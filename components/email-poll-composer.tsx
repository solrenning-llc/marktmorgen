"use client";

import { type EmailPoll, type PollProblem, MAX_POLL_DAYS, MAX_POLL_OPTION, MAX_POLL_OPTIONS, MAX_POLL_QUESTION, MIN_POLL_OPTIONS, POLL_DEFAULT_DAYS, readPollInput } from "@/lib/email-poll-rules";

/**
 * The poll a creator adds to an email to the list (125 [F2-EMAIL-POLLS],
 * unit 7b; drawn by components/email-studio.tsx). Checked by the same rules
 * the server reads it with (lib/email-poll-rules.ts readPollInput), so what
 * can be sent is what will be kept.
 */
export type PollDraft = { question: string; options: string[]; days: number };

export const emptyPoll = (): PollDraft => ({ question: "", options: ["", ""], days: POLL_DEFAULT_DAYS });

/** What goes with the email: no poll when the box is off, the poll as the server reads it, or what is wrong with it. */
export function pollAsked(on: boolean, draft: PollDraft): { ok: true; poll: EmailPoll | undefined } | { ok: false; problem: PollProblem } {
  if (!on) return { ok: true, poll: undefined };
  const read = readPollInput(draft);
  return read.ok ? { ok: true, poll: read.poll } : read;
}

const PROBLEM: Record<PollProblem, string> = {
  question: "Write the question.",
  options: `Write ${MIN_POLL_OPTIONS} to ${MAX_POLL_OPTIONS} different answers, none of them empty.`,
  days: `Choose from 1 to ${MAX_POLL_DAYS} days.`,
};

export function PollComposer({ on, value, onToggle, onChange }: { on: boolean; value: PollDraft; onToggle: (on: boolean) => void; onChange: (next: PollDraft) => void }) {
  const asked = pollAsked(on, value);
  const problem = asked.ok ? null : asked.problem;
  const setOption = (i: number, text: string) => onChange({ ...value, options: value.options.map((o, j) => (j === i ? text : o)) });
  return (
    <div>
      <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-ink">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} className="h-4 w-4 shrink-0 accent-violet-brand" />Add a poll
      </label>
      {on ? (
        <div className="mt-3 space-y-4 rounded-[var(--r-md)] bg-sand p-4">
          <label className="block">
            <span className="field-label">Question</span><input
              type="text"
              className="field mt-2"
              maxLength={MAX_POLL_QUESTION}
              value={value.question}
              aria-invalid={problem === "question" || undefined}
              aria-describedby="poll-question-hint"
              onChange={(e) => onChange({ ...value, question: e.target.value })}
            />
            <span id="poll-question-hint" className="field-hint mt-1 block">{problem === "question" ? PROBLEM.question : "For example: Which class should I teach next?"}</span>
          </label>
          <fieldset aria-describedby="poll-options-hint">
            <legend className="field-label">Answers</legend>
            <div className="mt-2 space-y-2">
              {value.options.map((option, i) => (
                <div key={i} className="flex items-end gap-2">
                  <label className="block flex-1">
                    <span className="field-hint block">{`Answer ${i + 1}`}</span>
                    <input
                      type="text"
                      className="field mt-1"
                      maxLength={MAX_POLL_OPTION}
                      value={option}
                      aria-invalid={problem === "options" || undefined}
                      onChange={(e) => setOption(i, e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-secondary min-h-11"
                    disabled={value.options.length <= MIN_POLL_OPTIONS}
                    onClick={() => onChange({ ...value, options: value.options.filter((_, j) => j !== i) })}
                  >{`Remove answer ${i + 1}`}</button>
                </div>
              ))}
            </div>
            {value.options.length < MAX_POLL_OPTIONS ? (
              <button type="button" className="btn btn-secondary mt-2 min-h-11" onClick={() => onChange({ ...value, options: [...value.options, ""] })}>Add an answer</button>
            ) : null}
            <span id="poll-options-hint" className="field-hint mt-1 block">{problem === "options" ? PROBLEM.options : `${MIN_POLL_OPTIONS} to ${MAX_POLL_OPTIONS} answers, each its own link in the email.`}</span>
          </fieldset>
          <label className="block">
            <span className="field-label">Open for</span><select className="field mt-2" value={value.days} onChange={(e) => onChange({ ...value, days: Number(e.target.value) })}>
              {Array.from({ length: MAX_POLL_DAYS }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d === 1 ? "1 day" : `${d} days`}</option>
              ))}
            </select>
          </label>
          <p className="text-sm text-ink-soft">
            Each person gets their own links. Opening one shows a page, and their answer is counted only when they press Confirm there, so mail apps that open links by themselves count nothing. You see only the totals, never who answered what.
          </p>
          <p className="text-sm text-ink-soft">Drafts do not keep the poll yet: add it just before you send.</p>
        </div>
      ) : null}
    </div>
  );
}
