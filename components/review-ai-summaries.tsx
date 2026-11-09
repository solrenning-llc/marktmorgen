"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { StudioEmptyState } from "@/components/empty-state";
import { MIN_SUMMARY_REVIEWS, SUMMARY_REFRESH_SECONDS, type SummaryTheme, summaryLine } from "@/lib/review-ai-summary-rules";

type Kept = { at: number; read: number; themes: SummaryTheme[] } | null;
/** lastAt: when the week's last summary was made, in seconds, even when it was deleted since (a review changed or gone). */
type Product = { id: string; title: string; reviews: number; summary: Kept; lastAt?: number };

const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const day = (seconds: number) => DAY.format(new Date(seconds * 1000));

const REFUSALS: Record<string, string> = {
  few: `A summary needs at least ${MIN_SUMMARY_REVIEWS} reviews with words.`,
  used: "This month's AI jobs are used up. A summary can be made next month.",
  busy: "Another summary is being made. Try again in a minute.",
  unread: "Your reviews could not be read just now, so no summary was made and no AI job was used. Try again in a moment.",
  off: "AI summaries are not available for this store just now.",
  slow: "Too many AI requests a moment ago. Try again in a minute.",
  // The try is counted before the model answers (lib/ai.ts keeps it counted on purpose), so this never says otherwise.
  failed: "The summary could not be made just now. This try counts as one of this month's AI jobs. You can try again now; each try is one more AI job.",
  week: "A summary of this product was made in the last 7 days. A new one can be made a week after it.",
  empty: "No theme came out that two or more reviews share in their own words, so nothing was kept. This try counts as one of this month's AI jobs. You can try again now; each try is one more AI job.",
};

/**
 * Each product's AI summary of its reviews, in the studio (636 [GL4](d),
 * unit 3): the themes reviewers repeat, each with how many of the reviews
 * read say it, made only when the creator asks, at most once a week, as one
 * of the month's AI jobs. AI only names a theme; the counts are the
 * reviewers'. Buyers do not see it yet.
 */
export function ReviewAiSummaries({ products, now, canAsk = false }: { products: Product[]; /** The request's time, in seconds, read once on the server. */ now: number; /** True for a role that can switch the review email on: only then is the jump to "Asking for reviews" drawn. */ canAsk?: boolean }) {
  const [shown, setShown] = useState(products);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, string>>({});
  // Where focus goes once a product's button is replaced by its result, so a keyboard user keeps their place;
  // after a refusal the button stays, and focus goes back to it.
  const statusRefs = useRef<Record<string, HTMLParagraphElement | null>>({});
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const summaryRefs = useRef<Record<string, HTMLParagraphElement | null>>({});
  // One short sentence for screen readers, said once; the full one stays beside the product.
  const [announce, setAnnounce] = useState("");
  // The same sentence twice is not read again by screen readers: the region is emptied first, the sentence put back on the next tick.
  const announceTimer = useRef<number | null>(null);
  function say(text: string) {
    if (announceTimer.current !== null) window.clearTimeout(announceTimer.current);
    setAnnounce("");
    announceTimer.current = window.setTimeout(() => {
      announceTimer.current = null;
      setAnnounce(text);
    }, 50);
  }
  useEffect(() => () => {
    if (announceTimer.current !== null) window.clearTimeout(announceTimer.current);
  }, []);

  async function make(product: Product) {
    if (busy) return;
    setBusy(product.id);
    setSaid((all) => ({ ...all, [product.id]: `Making the summary of ${product.title}'s reviews…` }));
    try {
      const response = await fetch("/api/store/review-summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: product.id }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; summary?: Kept; error?: string; left?: number | null; next?: number | null };
      if (answer.ok && answer.summary) {
        const summary = answer.summary;
        const left = typeof answer.left === "number" ? `Made. ${answer.left} AI ${answer.left === 1 ? "job" : "jobs"} left this month.` : "This week's summary.";
        // The summary replaces the button and takes the focus in the same task, so it never rests on the page.
        flushSync(() => {
          setSaid((all) => ({ ...all, [product.id]: left }));
          setShown((all) => all.map((p) => (p.id === product.id ? { ...p, summary } : p)));
        });
        summaryRefs.current[product.id]?.focus();
        say(`The summary of ${product.title}'s reviews is ready. ${left}`);
      } else {
        const week = answer.error === "week" && typeof answer.next === "number" ? answer.next : null;
        const why = week !== null ? `A summary of this product was made in the last 7 days. A new one can be made from ${day(week)} (UTC).` : REFUSALS[answer.error ?? "failed"] ?? REFUSALS.failed;
        flushSync(() => setSaid((all) => ({ ...all, [product.id]: why })));
        if (week !== null) {
          // A week's refusal takes the button away: the reason, already written, takes the focus first.
          statusRefs.current[product.id]?.focus();
          flushSync(() => setShown((all) => all.map((p) => (p.id === product.id ? { ...p, lastAt: week - SUMMARY_REFRESH_SECONDS } : p))));
        } else {
          buttonRefs.current[product.id]?.focus();
        }
        // The week's reason is read from the status that has the focus; the live region says only that none was made.
        say(week !== null ? `No summary of ${product.title}'s reviews was made.` : `No summary of ${product.title}'s reviews was made. ${why}`);
      }
    } catch {
      const why = "That did not work. Check your connection and try again.";
      flushSync(() => setSaid((all) => ({ ...all, [product.id]: why })));
      buttonRefs.current[product.id]?.focus();
      say(`No summary of ${product.title}'s reviews was made. ${why}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="ai-summaries-title" className="card p-5 sm:p-6">
      <h2 id="ai-summaries-title" className="font-semibold text-ink">
        {`AI summary of each product's reviews (${shown.length} ${shown.length === 1 ? "product" : "products"})`}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        AI groups a product&apos;s reviews by the topics people repeat. The numbers are counted from your reviewers&apos; own words, and every rating counts the same. Each summary uses one of your monthly AI jobs (the AI work your plan includes), and you can make one per product each week. Only you and your team see it for now.
      </p>
      <p className="sr-only" role="status">{announce}</p>
      {shown.length ? (
        <ul className="mt-3 space-y-4">
          {shown.map((product) => {
            const line = product.summary ? summaryLine(product.summary.themes, product.summary.read) : "";
            // The week counts from the last one made, even one deleted since because a review changed or went.
            const lastAt = Math.max(product.summary?.at ?? 0, product.lastAt ?? 0);
            const nextAt = lastAt ? lastAt + SUMMARY_REFRESH_SECONDS : 0;
            const canMake = product.reviews >= MIN_SUMMARY_REVIEWS && (!lastAt || nextAt <= now);
            return (
              <li key={product.id} className="text-sm">
                <h3 className="font-semibold text-ink [overflow-wrap:anywhere]">{product.title}</h3>
                {product.summary ? (
                  <p className="mt-1 text-ink rounded-md focus:outline-3 focus:outline-offset-3 focus:outline-(--focus)" tabIndex={-1} ref={(node) => { summaryRefs.current[product.id] = node; }}>
                    <span className="font-semibold">AI-sorted summary: </span>
                    {line || "No theme was repeated by two reviews or more."}
                    <span className="block text-sm text-ink-soft">{`Made ${day(product.summary.at)} (UTC) from ${product.summary.read} ${product.summary.read === 1 ? "review" : "reviews"}.`}</span>
                  </p>
                ) : null}
                {canMake ? (
                  <>
                    <button type="button" ref={(node) => { buttonRefs.current[product.id] = node; }} className="btn btn-secondary btn-sm mt-2 inline-flex min-h-11 items-center" aria-disabled={busy !== null} aria-busy={busy === product.id} aria-describedby={busy !== null && busy !== product.id ? `ai-wait-${product.id}` : undefined} onClick={() => void make(product)}>
                      {product.summary ? "Make this week's summary" : "Make the summary"}
                      <span className="sr-only">{` of ${product.title}'s reviews`}</span>
                    </button>
                    {busy !== null && busy !== product.id ? (
                      <p id={`ai-wait-${product.id}`} className="mt-1 text-sm text-ink-soft">One summary is made at a time. This one can be made when the other is ready.</p>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-1 text-sm text-ink-soft">
                    {product.reviews < MIN_SUMMARY_REVIEWS ? `A summary needs at least ${MIN_SUMMARY_REVIEWS} reviews; this one has ${product.reviews}.` : `${product.summary ? "" : "The last summary was taken away because a review it counted was changed or removed. "}A new one can be made from ${day(nextAt)} (UTC).`}
                  </p>
                )}
                <p className="mt-1 text-sm text-ink rounded-md focus:outline-3 focus:outline-offset-3 focus:outline-(--focus)" tabIndex={-1} ref={(node) => { statusRefs.current[product.id] = node; }}>
                  {said[product.id] ?? ""}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <StudioEmptyState title="No product has reviews yet" body={`Each product shows here once buyers review it. A summary needs at least ${MIN_SUMMARY_REVIEWS} reviews with words, and you make it when you are ready.`} action={canAsk ? { href: "#asking-for-reviews", label: "Ask buyers for a review" } : undefined} className="mt-3" />
      )}
    </section>
  );
}
