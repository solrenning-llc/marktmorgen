"use client";

import { useId, useState } from "react";
import { AI_ALLOWANCE_UNKNOWN } from "@/components/ai-assist";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { MAX_HELP_QUESTION } from "@/lib/ai-rules";
import { NewTab } from "@/components/new-tab";

type Answer = { answer: string; sources: { id: string; q: string }[] };

/**
 * "How do I…?" in the studio (lib/help-ask.ts): a question in plain words,
 * answered from the help center's own answers, with links to read them in
 * full. A question the help center does not cover is said to be so.
 * `left` is null when the month's AI allowance could not be read: said in
 * words, never "0 left"; the server still checks before an answer.
 */
export function StudioHelp({ left: startLeft }: { left: number | null }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [note, setNote] = useState("");
  const [left, setLeft] = useState(startLeft);
  const allowanceId = useId();

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (busy || question.trim().length < 3) return;
    setBusy(true);
    setNote("");
    setAnswer(null);
    try {
      const response = await fetch("/api/store/help", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: Answer; left?: number | null; error?: string };
      if (data.ok && data.value) {
        setAnswer(data.value);
        if (typeof data.left === "number") setLeft(data.left);
        return;
      }
      setNote(
        data.error === "used"
          ? "This month's AI help is used up; it starts again with your next billing month. The help center is always open."
          : data.error === "slow"
            ? "A few questions a minute at most. Ask again in a moment."
            : "No answer just now. Started attempts count toward the monthly allowance. Try again, or open the help center.",
      );
    } catch {
      setNote("No answer just now. Started attempts count toward the monthly allowance. Try again, or open the help center.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="studio-help-title" className="card mt-8 p-6 sm:p-8">
      <h2 id="studio-help-title" className="flex items-center gap-2 text-lg font-semibold tracking-[-0.02em] text-ink">
        <Icon name="chat" size={20} />
        How do I…?
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        {"Ask anything about your store in your own words, in English or the language you write in. Answered from our help center only, with the answers it came from. "}
        <span id={allowanceId}>{left === null ? `${AI_ALLOWANCE_UNKNOWN} Each question counts as one AI job.` : `Each question counts as one of your ${left} AI jobs left this month.`}</span>
      </p>
      <form onSubmit={ask} className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="studio-help-question" className="sr-only">Your question</label>
        <input
          id="studio-help-question"
          value={question}
          maxLength={MAX_HELP_QUESTION}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="How do I sell a course in payments?"
          className="field min-w-0 flex-1"
        />
        <button type="submit" disabled={busy || question.trim().length < 3} aria-busy={busy} aria-describedby={allowanceId} className="btn btn-primary shrink-0">
          {busy ? "Looking…" : "Ask"}
        </button>
      </form>
      {answer ? (
        <div role="status" className="mt-4 rounded-2xl bg-paper p-4 ring-1 ring-line">
          <p className="whitespace-pre-line text-ink">{answer.answer}</p>
          {answer.sources.length ? (
            <ul className="mt-3 space-y-1 text-sm">
              {answer.sources.map((source) => (
                <li key={source.id}>
                  <Link href={`/help#${source.id}`} target="_blank" rel="noopener" className="font-semibold text-ink-soft underline underline-offset-4 hover:text-violet-deep">
                    {source.q}
                  <NewTab /></Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {note ? <p role="status" className="mt-3 text-sm font-semibold text-ink">{note}</p> : null}
    </section>
  );
}
