"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AI_ALLOWANCE_UNKNOWN } from "@/components/ai-assist";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { MAX_HELP_QUESTION } from "@/lib/ai-rules";
import { NewTab } from "@/components/new-tab";
import { MAX_SUPPORT_TEXT, MIN_SUPPORT_TEXT, SUPPORT_EMAILS_PER_REQUEST, supportDraft } from "@/lib/help-support-rules";

type Answer = { answer: string; sources: { id: string; q: string }[]; asked?: string };

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
  // The question the help could not answer: a person can still be asked about it.
  const [unanswered, setUnanswered] = useState("");
  const [left, setLeft] = useState(startLeft);
  const allowanceId = useId();

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (busy || question.trim().length < 3) return;
    setBusy(true);
    setNote("");
    setUnanswered("");
    setAnswer(null);
    try {
      const response = await fetch("/api/store/help", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: Answer; left?: number | null; error?: string };
      if (data.ok && data.value) {
        setAnswer({ ...data.value, asked: question.trim() });
        if (typeof data.left === "number") setLeft(data.left);
        return;
      }
      setUnanswered(question.trim());
      setNote(
        data.error === "used"
          ? "This month's AI help is used up; it starts again with your next billing month. The help center is always open."
          : data.error === "slow"
            ? "A few questions a minute at most. Ask again in a moment."
            : "No answer just now. Started attempts count toward the monthly allowance. Try again, or open the help center.",
      );
    } catch {
      setUnanswered(question.trim());
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
      {answer ? <SupportHandoff key={`${answer.asked}
${answer.answer}`} question={answer.asked ?? ""} answer={answer.answer} /> : null}
      {note ? <p role="status" className="mt-3 text-sm font-semibold text-ink">{note}</p> : null}
      {note && unanswered ? <SupportHandoff key={unanswered} question={unanswered} answer={NO_ANSWER} /> : null}
    </section>
  );
}

type Sent = { number: string; copied: boolean };

/** What the draft says was answered when the help gave no answer at all. */
export const NO_ANSWER = "The help gave no answer.";

/**
 * "Send this to support" (lib/help-support.ts): after an answer, the question and the answer go to a person in
 * one press, as words the creator sees and can change first. Nothing is sent before "Send to support"; the
 * result is the request's number, said in a status region that takes the focus.
 */
export function SupportHandoff({ question, answer, startOpen = false }: { question: string; answer: string; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [draft, setDraft] = useState(() => supportDraft(question, answer));
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [note, setNote] = useState("");
  const fieldId = useId();
  const hintId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  // Where the focus goes after the next render: the field when it opens, the number when it is sent, the button when closed.
  const focusNext = useRef<"field" | "result" | "opener" | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    (target === "field" ? field : target === "result" ? result : opener).current?.focus();
  });

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy || draft.trim().length < MIN_SUPPORT_TEXT) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/store/help/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft, screen: window.location.pathname }),
      });
      // Our refusals say `words`; the studio's own guard (lib/studio-route.ts) says `message`: each is shown as written.
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: Sent; words?: string; message?: string };
      if (data.ok && data.value) {
        setSent(data.value);
        focusNext.current = "result";
        return;
      }
      setNote(data.words || data.message || "We could not send your request just now, so nothing was sent. Try again in a moment.");
    } catch {
      setNote("We could not send your request just now, so nothing was sent. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p ref={result} tabIndex={-1} role="status" data-support-sent={sent.number} className="mt-4 rounded-2xl bg-paper p-4 text-ink ring-1 ring-line">
        {`Sent to support. Your request number is ${sent.number}. A person answers you by email. `}
        {sent.copied ? "A copy is in your inbox." : "We could not email you a copy, but support has your request."}
      </p>
    );
  }
  if (!open) {
    return (
      <div className="mt-3">
        <button ref={opener} type="button" onClick={() => { focusNext.current = "field"; setOpen(true); }} className="btn btn-secondary">
          <Icon name="mail" size={18} />
          Send this to support
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={send} aria-labelledby={`${fieldId}-title`} className="mt-4 rounded-2xl p-4 ring-1 ring-line">
      <h3 id={`${fieldId}-title`} className="font-semibold text-ink">Send this to support</h3>
      <p id={hintId} className="mt-1 text-sm text-ink-soft">
        {`A person reads it and answers you by email, with a copy to you (${SUPPORT_EMAILS_PER_REQUEST} emails in all). We add your store, your plan and this screen. Nothing about your buyers is sent. Change anything below first.`}
      </p>
      <label htmlFor={fieldId} className="mt-3 block text-sm font-semibold text-ink">What to send</label>
      <textarea
        ref={field}
        id={fieldId}
        value={draft}
        maxLength={MAX_SUPPORT_TEXT}
        rows={8}
        onChange={(e) => setDraft(e.target.value)}
        aria-describedby={hintId}
        className="field mt-1 w-full"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" disabled={busy || draft.trim().length < MIN_SUPPORT_TEXT} aria-busy={busy} className="btn btn-primary">
          {busy ? "Sending…" : "Send to support"}
        </button>
        <button type="button" onClick={() => { focusNext.current = "opener"; setOpen(false); setNote(""); }} className="btn btn-secondary">Cancel</button>
      </div>
      {note ? <p role="status" className="mt-3 text-sm font-semibold text-ink">{note}</p> : null}
    </form>
  );
}
