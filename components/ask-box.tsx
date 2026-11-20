"use client";

import { useState, useSyncExternalStore } from "react";
import { MAX_QUESTION, MIN_QUESTION } from "@/lib/answers-rules";

const never = () => () => {};

/**
 * "A question before you buy?" on a product's page (lib/answers.ts): the
 * visitor types one, and is answered from what the page says, or told plainly
 * that the page does not say.
 *
 * Drawn only once the browser has taken the page over: it needs JavaScript to
 * ask, and a box that does nothing when pressed is worse than no box. The
 * page sells without it.
 */
/** Everything the box says, in the store's language (lib/buyer-words), with the store's name already in. */
export type AskWords = {
  aria: string;
  label: string;
  placeholder: string;
  busy: string;
  ask: string;
  closed: string;
  typeFirst: string;
  slow: string;
  failed: string;
  note: string;
};

export function AskBox({ handle, product, words }: { handle: string; product: string; words: AskWords }) {
  const here = useSyncExternalStore(never, () => true, () => false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ asked: string; text: string; known: boolean; example: string | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!here) return null;

  const NOTES: Record<string, string> = {
    question: words.typeFirst,
    slow: words.slow,
    closed: words.closed,
    off: words.closed,
    failed: words.failed,
  };

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    const asked = question.trim();
    if (busy) return;
    if (asked.length < MIN_QUESTION) {
      setNote(NOTES.question);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/store/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, product, question: asked }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; answer?: string; known?: boolean; example?: string; error?: string };
      if (data.ok && data.answer) {
        setAnswer({ asked, text: data.answer, known: data.known === true, example: typeof data.example === "string" && data.example ? data.example : null });
        setQuestion("");
      } else {
        setNote(NOTES[data.error ?? ""] ?? NOTES.failed);
      }
    } catch {
      setNote(NOTES.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="st-ask mt-4" aria-label={words.aria}>
      <form onSubmit={ask}>
        <label htmlFor={`ask-${product}`} className="st-label">
          {words.label}
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id={`ask-${product}`}
            className="st-field min-w-0 flex-1"
            maxLength={MAX_QUESTION}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={words.placeholder}
            autoComplete="off"
            enterKeyHint="send"
          />
          <button type="submit" className="btn st-btn-ghost shrink-0" disabled={busy} aria-busy={busy}>
            {busy ? words.busy : words.ask}
          </button>
        </div>
      </form>
      <div aria-live="polite">
        {answer ? (
          <div className="st-ask-answer mt-3">
            <p className="st-muted text-xs font-semibold">{answer.asked}</p>
            {/* The demo store's month of AI answers is used up: an answer written in advance, said so above it (lib/demo-ai-rules.ts). */}
            {answer.example ? <p className="st-note mt-1 text-sm font-semibold">{answer.example}</p> : null}
            <p className="mt-1 leading-relaxed">{answer.text}</p>
          </div>
        ) : null}
        {note ? (
          <p className="st-note mt-3 text-sm" role="status">
            {note}
          </p>
        ) : null}
      </div>
      <p className="st-muted mt-2 text-xs">{words.note}</p>
    </section>
  );
}
