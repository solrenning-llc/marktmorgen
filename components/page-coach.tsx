"use client";

import { useContext, useId, useState } from "react";
import { Icon } from "@/components/icons";
import { AI_ALLOWANCE_UNKNOWN, AiOn, allowanceOf } from "@/components/ai-assist";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import { BLOCK_KINDS, type BlockKind, type FactKey, type SalesPage } from "@/lib/sales-page";
import { BUYER_LENSES, type CoachCheck, coachChecks, coachScore, scoreWord, steepestDrop } from "@/lib/page-coach";
import type { PageFacts } from "@/lib/page-facts";

/** What the writing help sends back about a page (lib/ai.ts, PageReview). */
type Review = {
  verdict: string;
  fixes: { title: string; detail: string }[];
  headlines: { headline: string; sub: string }[];
  fit: { yes: string[]; no: string[] } | null;
  questions: { q: string; a: string }[];
  /** The page read by three kinds of buyer (624 [SZ8](9)); absent from a review made before. */
  buyers?: { lens: string; objection: string; add: string }[];
};

const MESSAGES: Record<string, string> = {
  used: "This month's writing help is used up. It starts again with your next billing month.",
  slow: "A few at a time: wait a minute, then try again.",
  failed: "The review did not come back just now. Your content was not changed. Started attempts count toward the monthly allowance. Try again in a moment.",
  off: "The writing help is not available right now.",
  forbidden: "Your role on this store cannot do this.",
  unknown: "That product is no longer in your store. Reload the page.",
};

const kindLabel = (kind: BlockKind) => BLOCK_KINDS.find((k) => k.kind === kind)?.label ?? kind;

/**
 * The page coach, above the blocks in the studio (lib/page-coach.ts): a score
 * out of 100, what is missing with a button that adds the block, where readers
 * stop, and a review by the writing help whose drafts the creator applies one
 * at a time. It changes the blocks in the editor only; nothing is saved until
 * the page's own Save.
 */
export function PageCoach({
  productId,
  productTitle,
  free,
  picture,
  pictureAlt,
  facts,
  factsUnread = [],
  page,
  reach,
  onAdd,
  onHeadline,
  onTest,
  onFit,
  onQuestions,
  traffic = null,
  asked = [],
}: {
  productId: string;
  productTitle: string;
  free: boolean;
  picture: boolean;
  /** The product picture's own description, shown at the top when the hero shows a picture. */
  pictureAlt: string;
  facts: PageFacts;
  /** The numbers whose read did not come back (lib/page-facts-read.ts). */
  factsUnread?: readonly FactKey[];
  /** The page as it stands in the editor, saved or not. */
  page: SalesPage;
  reach: { shares: Record<string, number>; visitors: number } | null;
  onAdd: (kind: BlockKind) => void;
  onHeadline: (headline: string, sub: string) => void;
  onTest: (headline: string, sub: string) => void;
  onFit: (yes: string[], no: string[]) => void;
  onQuestions: (items: { q: string; a: string }[]) => void;
  /** The last 30 days of the product's page: times it was opened, and checkouts started (lib/stats.ts). */
  traffic?: { views: number; checkouts: number } | null;
  /** Questions visitors asked the page's answer box that the page could not answer (lib/answers.ts). */
  asked?: string[];
}) {
  const ai = useContext(AiOn);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [left, setLeft] = useState(allowanceOf(ai));
  const allowanceId = useId();
  const [used, setUsed] = useState<Set<string>>(new Set());

  const checks = coachChecks({ page, productTitle, free, picture, pictureAlt, facts, factsUnread });
  const score = coachScore(checks);
  const missing = checks.filter((c) => !c.done).sort((a, b) => b.weight - a.weight);
  const drop = steepestDrop(page.blocks, reach);
  const tone = score >= 75 ? "var(--mint-deep, #0f766e)" : score >= 45 ? "var(--violet, #5a36ee)" : "var(--amber, #b45309)";

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "review", product: productId, page, notes }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: Review; left?: number; error?: string };
      if (data.ok && data.value) {
        setReview(data.value);
        setUsed(new Set());
        if (typeof data.left === "number") setLeft(data.left);
        return;
      }
      setError(MESSAGES[data.error ?? ""] ?? MESSAGES.failed);
    } catch {
      setError(MESSAGES.failed);
    } finally {
      setBusy(false);
    }
  }

  const mark = (key: string) => setUsed((all) => new Set(all).add(key));
  const ring = `conic-gradient(${tone} ${score * 3.6}deg, var(--line, #e7e5e4) 0deg)`;

  const checkRow = (check: CoachCheck) => (
    <li key={check.id} className="flex items-start gap-3 py-2.5">
      <span
        className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${check.done ? "bg-mint-soft text-mint-deep" : "bg-sand text-ink-mute"}`}
        aria-hidden="true"
      >
        <Icon name={check.done ? "check" : "plus"} size={14} strokeWidth={2.4} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">
          {check.label}
          <span className="sr-only">{check.done ? " (done)" : " (missing)"}</span>
        </span>
        {!check.done ? <span className="mt-0.5 block text-xs text-ink-soft">{check.why}</span> : null}
      </span>
      {!check.done && check.add ? (
        <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => onAdd(check.add as BlockKind)}>
          <Icon name="plus" size={14} />
          {`Add ${kindLabel(check.add).toLowerCase()}`}
        </button>
      ) : null}
    </li>
  );

  return (
    <section aria-labelledby="coach-title" className="mt-6 rounded-2xl border border-line bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative grid h-16 w-16 shrink-0 place-items-center rounded-full" style={{ background: ring }} aria-hidden="true">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-white text-lg font-bold tabular-nums text-ink">{score}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h3 id="coach-title" className="text-base font-semibold text-ink">
            {`Page coach: ${score} out of 100, ${scoreWord(score).toLowerCase()}`}
          </h3>
          <p className="mt-0.5 text-sm text-ink-soft">
            {missing.length === 0
              ? "Everything a page that sells has in common is here. What is left is the words: test two headlines, and read what readers do below."
              : `${missing.length} ${missing.length === 1 ? "thing" : "things"} that pages that sell have in common ${missing.length === 1 ? "is" : "are"} missing. The ones that matter most come first.`}
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} aria-controls="coach-body" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "See what to improve"}
        </button>
      </div>

      {traffic && traffic.views > 0 ? (
        <p className="mt-3 text-sm text-ink-soft">
          <span className="font-semibold text-ink">Last 30 days: </span>
          {`this page was opened ${traffic.views} ${traffic.views === 1 ? "time" : "times"}, and ${traffic.checkouts} ${traffic.checkouts === 1 ? "checkout was" : "checkouts were"} started${traffic.checkouts <= traffic.views ? ` — ${Math.round((traffic.checkouts / traffic.views) * 100)} for every 100 views` : ", some of them from your store's front page"}.`}
        </p>
      ) : null}

      {drop ? (
        <p className="notice notice-warn mt-4 text-sm" role="status">
          {`${drop.lost} of every 100 readers stop just before your ${kindLabel(drop.kind).toLowerCase()} block, out of ${reach?.visitors ?? 0} counted. Move your first button above it, or shorten what comes before.`}
        </p>
      ) : null}

      {open ? (
        <div id="coach-body" className="mt-4">
          {missing.length ? <ul className="divide-y divide-line">{missing.map(checkRow)}</ul> : null}
          {checks.some((c) => c.done) ? (
            <details className="mt-2">
              <summary className="cursor-pointer py-2 text-sm font-semibold text-ink-soft">{`Done (${checks.filter((c) => c.done).length})`}</summary>
              <ul className="divide-y divide-line">{checks.filter((c) => c.done).map(checkRow)}</ul>
            </details>
          ) : null}

          {asked.length ? (
            <div className="mt-4 rounded-2xl border border-line bg-paper p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Icon name="chat" size={16} />
                {`Visitors asked ${asked.length === 1 ? "this" : `these ${asked.length}`}, and your page could not answer`}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
                {asked.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
              <button
                type="button"
                className="btn btn-secondary btn-sm mt-3"
                disabled={used.has("asked")}
                onClick={() => {
                  onQuestions(asked.map((q) => ({ q, a: "" })));
                  mark("asked");
                }}
              >
                {used.has("asked") ? "Added: write the answers, then save" : "Add them to my questions"}
              </button>
              <p className="mt-2 text-xs text-ink-soft">
                Real questions, from the answer box on this page, with nothing about who asked. Answered on the page, the next visitor reads the answer before having to ask.
              </p>
            </div>
          ) : null}

          {ai.on ? (
            <div className="mt-4 rounded-2xl border border-violet-brand/25 bg-lilac/40 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-violet-deep">
                <Icon name="sparkle" size={16} />
                A second opinion from the writing help
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                It reads this page as visitors do, with what is missing and where readers stop, and says what to change first. It also drafts three headlines, who it is for and not for, and the questions buyers will ask that your page leaves open, each a press away from your page. It uses only what your page says and never invents reviews, numbers, results or deadlines.
              </p>
              <label className="mt-3 block">
                <span className="field-label">Anything it should look at (optional)</span>
                <textarea
                  className="field mt-1"
                  rows={2}
                  maxLength={MAX_AI_NOTES}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="For example: visitors read but few buy. Or: is my headline clear?"
                />
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void ask()} disabled={busy || left === null || left <= 0} aria-busy={busy} aria-describedby={allowanceId}>
                  {busy ? "Reading your page…" : review ? "Review it again" : "Review my page"}
                </button>
                <span id={allowanceId} className="text-xs text-ink-soft">{left === null ? AI_ALLOWANCE_UNKNOWN : `${left} left this month`}</span>
              </div>
              {error ? (
                <p className="notice notice-error mt-3 text-sm" role="alert">
                  {error}
                </p>
              ) : null}

              {review ? (
                <div className="mt-4 space-y-5" aria-live="polite">
                  <p className="text-[0.9375rem] font-semibold text-ink">{review.verdict}</p>

                  {review.fixes.length ? (
                    <div>
                      <p className="field-label">What to change first</p>
                      <ol className="mt-2 space-y-2">
                        {review.fixes.map((fix, i) => (
                          <li key={i} className="flex gap-3 rounded-xl bg-white p-3 ring-1 ring-line">
                            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-lilac text-xs font-bold text-violet-deep">{i + 1}</span>
                            <span className="min-w-0">
                              <span className="block text-sm font-semibold text-ink">{fix.title}</span>
                              {fix.detail ? <span className="mt-0.5 block text-sm text-ink-soft">{fix.detail}</span> : null}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}

                  {review.headlines.length ? (
                    <div>
                      <p className="field-label">Headlines to try</p>
                      <ul className="mt-2 space-y-2">
                        {review.headlines.map((h, i) => (
                          <li key={i} className="rounded-xl bg-white p-3 ring-1 ring-line">
                            <p className="font-semibold text-ink">{h.headline}</p>
                            {h.sub ? <p className="mt-0.5 text-sm text-ink-soft">{h.sub}</p> : null}
                            <div className="mt-2 flex flex-wrap gap-2">
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                disabled={used.has(`h${i}`)}
                                onClick={() => {
                                  onHeadline(h.headline, h.sub);
                                  mark(`h${i}`);
                                }}
                              >
                                {used.has(`h${i}`) ? "In the hero" : "Use it"}
                              </button>
                              {free ? null : (
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  disabled={used.has(`t${i}`)}
                                  onClick={() => {
                                    onTest(h.headline, h.sub);
                                    mark(`t${i}`);
                                  }}
                                >
                                  {used.has(`t${i}`) ? "Set as the second headline" : "Test it against yours"}
                                </button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {review.fit ? (
                    <div className="rounded-xl bg-white p-3 ring-1 ring-line">
                      <p className="field-label">Who it is for, and who it is not</p>
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <ul className="space-y-1 text-sm text-ink">
                          {review.fit.yes.map((item, i) => (
                            <li key={i} className="flex gap-2">
                              <Icon name="check" size={14} className="mt-1 shrink-0 text-mint-deep" />
                              {item}
                            </li>
                          ))}
                        </ul>
                        <ul className="space-y-1 text-sm text-ink-soft">
                          {review.fit.no.map((item, i) => (
                            <li key={i} className="flex gap-2">
                              <Icon name="close" size={14} className="mt-1 shrink-0" />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm mt-3"
                        disabled={used.has("fit")}
                        onClick={() => {
                          onFit(review.fit!.yes, review.fit!.no);
                          mark("fit");
                        }}
                      >
                        {used.has("fit") ? "Added to your page" : "Add it to my page"}
                      </button>
                    </div>
                  ) : null}

                  {review.questions.length ? (
                    <div className="rounded-xl bg-white p-3 ring-1 ring-line">
                      <p className="field-label">Questions your page leaves open</p>
                      <ul className="mt-2 space-y-2">
                        {review.questions.map((item, i) => (
                          <li key={i} className="text-sm">
                            <span className="block font-semibold text-ink">{item.q}</span>
                            <span className={`mt-0.5 block ${item.a ? "text-ink-soft" : "italic text-ink-mute"}`}>
                              {item.a || "Only you can answer this one: your page does not say."}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm mt-3"
                        disabled={used.has("faq")}
                        onClick={() => {
                          onQuestions(review.questions);
                          mark("faq");
                        }}
                      >
                        {used.has("faq") ? "Added to your questions" : "Add them to my questions"}
                      </button>
                      {review.questions.some((q) => !q.a) ? (
                        <p className="mt-2 text-xs text-ink-soft">A question without an answer is left out when you save, until you write one.</p>
                      ) : null}
                    </div>
                  ) : null}

                  {review.buyers?.length ? (
                    <div className="rounded-xl bg-white p-3 ring-1 ring-line">
                      <p className="field-label">Three buyers reading your page</p>
                      <ul className="mt-2 space-y-3">
                        {review.buyers.map((item) => {
                          const lens = BUYER_LENSES.find((l) => l.id === item.lens);
                          return lens ? (
                            <li key={item.lens} className="text-sm">
                              <span className="block font-semibold text-ink">{lens.label}</span>
                              <span className="mt-0.5 block text-ink-soft">{`Their doubt: ${item.objection}`}</span>
                              <span className="mt-0.5 block text-ink-soft">{`What could answer it: ${item.add}`}</span>
                            </li>
                          ) : null;
                        })}
                      </ul>
                      <p className="mt-2 text-xs text-ink-soft">Three ways of reading the page, written by the AI from what it says. Not a prediction of sales.</p>
                    </div>
                  ) : null}

                  <p className="text-xs text-ink-soft">Read every line before you save: it goes out under your name. Nothing changed on your page until you pressed a button above, and nothing is live until you press Save.</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
