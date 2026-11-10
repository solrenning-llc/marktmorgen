"use client";

import { useState } from "react";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import type { AskSection, AskWindow, NumbersAnswer } from "@/lib/numbers-ask";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  notes: "Ask a question of a few words or more.",
  used: "This month's AI jobs are used up. They come back with your next billing month.",
  off: "Asking your numbers is not available right now.",
  numbers: "Your numbers could not be read just now. Try again in a moment.",
  slow: "A few questions a minute at most. Try again in a moment.",
  failed: "No answer came back. Try again. This try counted as one of this month's AI jobs.",
  server_error: "Something went wrong on our side. Try again in a moment. If the answer had already started, this try may have counted as one of this month's AI jobs.",
};

const WINDOW_WORDS: Record<AskWindow, string> = { d7: "last 7 days", d30: "last 30 days", d90: "last 90 days" };
const EXAMPLES = ["Which channel brought the most money this month?", "Where do visitors stop before buying?", "How did this week compare with last week?"];

/**
 * A question about the store's own numbers, answered from them only, with the
 * figures it rests on and a way to the part of the panel that shows them
 * (lib/numbers-ask.ts). One of the month's AI jobs per question.
 */
export function NumbersAsk({ onShow }: { onShow: (window: AskWindow, section: AskSection | "") => void }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<(NumbersAnswer & { left: number | null }) | null>(null);

  async function ask(asked: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/numbers/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: asked }) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string; value?: NumbersAnswer; left?: number | null };
      if (data.ok && data.value) setAnswer({ ...data.value, left: data.left ?? null });
      // A refusal for the studio's requests carries its own sentence (how many this needs, how many are left).
      else if (data.error === "studio_used" && typeof data.message === "string" && data.message) setError(data.message);
      else setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line" role="region" aria-labelledby="numbers-ask" data-numbers-ask>
      <p id="numbers-ask" className="text-sm font-bold text-ink">
        Ask your numbers
      </p>
      <form
        className="mt-2 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim().length >= 3) void ask(question.trim());
        }}
      >
        <label htmlFor="numbers-question" className="sr-only">
          Your question about your numbers
        </label>
        <input
          id="numbers-question"
          className="field min-w-0 flex-1"
          maxLength={300}
          placeholder={EXAMPLES[0]}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || question.trim().length < 3} aria-busy={busy}>
          {busy ? "Reading…" : "Ask"}
        </button>
      </form>
      {!answer && !error ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="inline-flex min-h-11 items-center rounded-full bg-white px-3 text-xs font-semibold text-ink-soft ring-1 ring-line hover:text-ink"
              onClick={() => {
                setQuestion(example);
                void ask(example);
              }}
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
      {answer ? (
        <div className="mt-3" aria-live="polite" data-numbers-answer>
          <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{answer.answer}</p>
          {answer.used.length ? (
            <dl className="mt-3 flex flex-wrap gap-2">
              {answer.used.map((u) => (
                <div key={`${u.label}-${u.value}`} className="rounded-[10px] bg-white px-3 py-2 ring-1 ring-line">
                  <dt className="text-xs text-ink-soft">{u.label}</dt>
                  <dd className="text-sm font-semibold tabular-nums text-ink">{u.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
            <button type="button" className="inline-flex min-h-11 items-center text-sm font-semibold text-violet-deep underline underline-offset-4" onClick={() => onShow(answer.window, answer.section)}>
              {`Show these numbers, ${WINDOW_WORDS[answer.window]}`}
            </button>
            <span className="text-xs text-ink-soft">
              {`Answered from your Numbers panel only; each figure above is one it shows.${answer.left === null ? "" : ` ${answer.left} AI ${answer.left === 1 ? "job" : "jobs"} left this month.`}`}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
