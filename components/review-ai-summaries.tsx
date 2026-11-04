"use client";

import { useRef, useState } from "react";
import { MIN_SUMMARY_REVIEWS, SUMMARY_REFRESH_SECONDS, type SummaryTheme, summaryLine } from "@/lib/review-ai-summary-rules";

type Kept = { at: number; read: number; themes: SummaryTheme[] } | null;
type Product = { id: string; title: string; reviews: number; summary: Kept };

const DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const day = (seconds: number) => DAY.format(new Date(seconds * 1000));

const REFUSALS: Record<string, string> = {
  few: `A summary needs at least ${MIN_SUMMARY_REVIEWS} reviews with words.`,
  used: "This month's AI jobs are used up. A summary can be made next month.",
  busy: "Another summary is being made. Try again in a minute.",
  off: "AI summaries are not available for this store just now.",
  slow: "Too many AI requests a moment ago. Try again in a minute.",
  // The try is counted before the model answers (lib/ai.ts keeps it counted on purpose), so this never says otherwise.
  failed: "The summary could not be made just now. This try counts as one of this month's AI jobs. Try again later.",
};

/**
 * Each product's AI summary of its reviews, in the studio (636 [GL4](d),
 * unit 3): the themes reviewers repeat, each with how many of the reviews
 * read say it, made only when the creator asks, at most once a week, as one
 * of the month's AI jobs. AI only names a theme; the counts are the
 * reviewers'. Buyers do not see it yet.
 */
export function ReviewAiSummaries({ products, now }: { products: Product[]; /** The request's time, in seconds, read once on the server. */ now: number }) {
  const [shown, setShown] = useState(products);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, string>>({});
  // Where focus goes once a product's button is replaced by its result, so a keyboard user keeps their place.
  const statusRefs = useRef<Record<string, HTMLParagraphElement | null>>({});

  async function make(product: Product) {
    if (busy) return;
    setBusy(product.id);
    setSaid((all) => ({ ...all, [product.id]: `Making the summary of ${product.title}'s reviews…` }));
    try {
      const response = await fetch("/api/store/review-summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: product.id }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; summary?: Kept; error?: string; left?: number | null };
      if (answer.ok && answer.summary) {
        setShown((all) => all.map((p) => (p.id === product.id ? { ...p, summary: answer.summary! } : p)));
        setSaid((all) => ({ ...all, [product.id]: typeof answer.left === "number" ? `Made. ${answer.left} AI ${answer.left === 1 ? "job" : "jobs"} left this month.` : "This week's summary." }));
      } else {
        setSaid((all) => ({ ...all, [product.id]: REFUSALS[answer.error ?? "failed"] ?? REFUSALS.failed }));
      }
    } catch {
      setSaid((all) => ({ ...all, [product.id]: "That did not work. Check your connection and try again." }));
    } finally {
      setBusy(null);
      window.setTimeout(() => statusRefs.current[product.id]?.focus(), 0);
    }
  }

  return (
    <section aria-labelledby="ai-summaries-title" className="card p-5 sm:p-6">
      <h2 id="ai-summaries-title" className="font-semibold text-ink">
        AI summary of each product&apos;s reviews
      </h2>
      <p className="mt-1 text-xs text-ink-soft">
        AI sorts a product&apos;s reviews into the themes they repeat; the counts are your reviewers&apos;. Every rating counts the same. One AI job each, at most once a week. Only you and your team see it for now.
      </p>
      {shown.length ? (
        <ul className="mt-3 space-y-4">
          {shown.map((product) => {
            const line = product.summary ? summaryLine(product.summary.themes, product.summary.read) : "";
            const nextAt = product.summary ? product.summary.at + SUMMARY_REFRESH_SECONDS : 0;
            const canMake = product.reviews >= MIN_SUMMARY_REVIEWS && (!product.summary || nextAt <= now);
            return (
              <li key={product.id} className="text-sm">
                <h3 className="font-semibold text-ink [overflow-wrap:anywhere]">{product.title}</h3>
                {product.summary ? (
                  <p className="mt-1 text-ink">
                    <span className="sr-only">Summary sorted by AI: </span>
                    {line || "No theme was repeated by two reviews or more."}
                    <span className="block text-xs text-ink-soft">{`Made ${day(product.summary.at)} from ${product.summary.read} ${product.summary.read === 1 ? "review" : "reviews"}.`}</span>
                  </p>
                ) : null}
                {canMake ? (
                  <button type="button" className="btn btn-secondary btn-sm mt-2" aria-disabled={busy !== null} aria-busy={busy === product.id} onClick={() => void make(product)}>
                    {product.summary ? "Make this week's summary" : "Make the summary"}
                    <span className="sr-only">{` of ${product.title}'s reviews`}</span>
                  </button>
                ) : (
                  <p className="mt-1 text-xs text-ink-soft">
                    {product.reviews < MIN_SUMMARY_REVIEWS ? `A summary needs at least ${MIN_SUMMARY_REVIEWS} reviews; this one has ${product.reviews}.` : `A new one can be made from ${day(nextAt)}.`}
                  </p>
                )}
                <p className="mt-1 text-xs text-ink" role="status" tabIndex={-1} ref={(node) => { statusRefs.current[product.id] = node; }}>
                  {said[product.id] ?? ""}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-soft">No product has reviews yet.</p>
      )}
    </section>
  );
}
