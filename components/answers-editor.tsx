"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { type AnswersSetting, MAX_ANSWER_FACTS } from "@/lib/answers-rules";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const FAILED = "It could not be saved just now. Try again in a moment.";

/**
 * Answers to visitors' questions on product pages (lib/answers-rules.ts):
 * switched on here, with the creator's own notes for them, how many of the
 * month's AI attempts were used, and the questions their pages could not answer.
 */
export function AnswersEditor({
  setting,
  used,
  allowance,
  missed,
}: {
  setting: AnswersSetting;
  /** null when the month's count could not be read: said so, never "0 used" (rule 24). */
  used: number | null;
  allowance: number;
  /** The newest questions a page did not answer: what was asked, of which product, on which day. */
  missed: { title: string; question: string; at: number }[];
}) {
  const router = useRouter();
  const [on, setOn] = useState(setting.on);
  const [facts, setFacts] = useState(setting.facts);
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = on !== setting.on || facts.trim() !== setting.facts;

  async function post(body: Record<string, unknown>, what: "save" | "clear", said: string) {
    setBusy(what);
    setError(null);
    try {
      const response = await fetch("/api/store/answers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean };
      if (!data.ok) {
        setError(FAILED);
        return;
      }
      toast(said);
      router.refresh();
    } catch {
      setError(FAILED);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div id="answers" className="card scroll-mt-32 p-6 sm:p-8">
      <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Answer buyers&apos; questions with AI</p>
      <p className="mt-2 text-ink-soft">
        A box on each product&apos;s page, &ldquo;A question before you buy?&rdquo;. The visitor is answered in seconds, only from what that page says and
        from your notes below, in their own language. When your page does not answer the question, they are told so, and the question lands here
        for you to read: that list shows you what your pages are missing.
      </p>
      <p className="mt-2 text-ink-soft">
        With three products or more, your store page also gets &ldquo;Not sure which one is for you?&rdquo;: a visitor says what they want and
        sees which of your products fit, and why, picked only from your titles, one-line summaries, prices and notes. When nothing fits, what they
        looked for lands here too: an idea for your next product. Each pick counts as one answer.
      </p>

      <label className="mt-5 flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold text-ink">
        <input type="checkbox" checked={on} onChange={(event) => setOn(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" />
        <span>
          Answer questions on my product pages, and help visitors choose on my store page
          <span className="block font-normal text-ink-soft">
            It never states a price, a refund, a deadline or a result that is not on your page, and the box says the answer is automatic.
          </span>
        </span>
      </label>

      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="answer-facts" className="field-label">
            What buyers should know (optional)
          </label>
          <span className="text-xs tabular-nums text-ink-mute">{`${facts.length}/${MAX_ANSWER_FACTS}`}</span>
        </div>
        <textarea
          id="answer-facts"
          className="field mt-1"
          rows={4}
          maxLength={MAX_ANSWER_FACTS}
          value={facts}
          onChange={(event) => setFacts(event.target.value)}
          placeholder="For example: I refund anyone who asks in the first two weeks. Every file is a PDF. I answer email within two working days."
        />
        <p className="mt-1 text-xs text-ink-soft">True of every product on your store. Write only what you will stand behind: buyers read an answer as your word.</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={() => void post({ on, facts: facts.trim() }, "save", on ? "Saved. The box is on your product pages." : "Saved. The box is off.")} disabled={busy !== null || !changed} aria-busy={busy === "save"}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <p className="text-sm text-ink-soft">{`${used === null ? "We could not read how many AI attempts were used this month just now; reload the page in a minute to try again." : `${used.toLocaleString("en-US")} of ${allowance.toLocaleString("en-US")} AI attempts used this month.`} Failed or timed-out requests count; cached replies do not. At the limit, new requests pause until next month. No per-answer overage is charged.`}</p>
      </div>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}

      {missed.length > 0 ? (
        <div className="mt-7 border-t border-line pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-semibold text-ink">Questions your pages did not answer</p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void post({ clear: true }, "clear", "List cleared.")} disabled={busy !== null} aria-busy={busy === "clear"}>
              Clear the list
            </button>
          </div>
          <p className="mt-1 text-sm text-ink-soft">Newest first, with nothing about who asked. Answer them on the product&apos;s page or in your notes above, and the next visitor gets the answer.</p>
          <ul className="mt-3 space-y-2">
            {missed.map((row, index) => (
              <li key={index} className="rounded-xl bg-paper px-4 py-3 ring-1 ring-line">
                <p className="text-ink">{row.question}</p>
                <p className="mt-1 text-xs text-ink-soft">{`${row.title}${row.at ? ` · ${DATE.format(new Date(row.at * 1000))}` : ""}`}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
