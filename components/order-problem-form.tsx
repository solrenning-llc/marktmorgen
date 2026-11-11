"use client";

import { useRef, useState } from "react";
import { orderProblemWords } from "@/lib/buyer-words/order-problem";
import { ORDER_PROBLEM_NOTE_MAX, ORDER_PROBLEM_REASONS, readOrderProblem } from "@/lib/order-problem-rules";

/**
 * The form of "Report a problem with this order" (567 [GD1] (a), unit 3).
 * A plain HTML form to /api/store/order-problem, so it works with JavaScript
 * turned off; the server decides. With JavaScript, the same rules
 * (readOrderProblem) are checked before sending, so a buyer whose note is
 * too short for "Something else" fixes it on the spot and never types it
 * again.
 */
export function OrderProblemForm({ handle, token, reference, language }: { handle: string; token: string; reference: string; language: string }) {
  const words = orderProblemWords(language);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<"" | "reason" | "note">("");
  const note = useRef<HTMLTextAreaElement>(null);
  const first = useRef<HTMLInputElement>(null);

  const check = (event: React.FormEvent<HTMLFormElement>) => {
    const form = new FormData(event.currentTarget);
    const read = readOrderProblem({ reason: form.get("reason"), note: form.get("note") ?? "", order: reference });
    if (read.ok || read.field === "order") {
      setProblem("");
      return;
    }
    event.preventDefault();
    setProblem(read.field);
    (read.field === "note" ? note.current : first.current)?.focus();
  };

  return (
    <form action="/api/store/order-problem" method="post" className="mt-6 space-y-5" onSubmit={check}>
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="ref" value={reference} />
      <fieldset aria-describedby={problem === "reason" ? "problem-reason-error" : undefined}>
        <legend className="st-label">{words.reasonLegend}</legend>
        <div className="mt-2 space-y-1">
          {ORDER_PROBLEM_REASONS.map((value, index) => (
            <label key={value} className="flex min-h-11 cursor-pointer items-center gap-3">
              <input
                ref={index === 0 ? first : undefined}
                type="radio"
                name="reason"
                value={value}
                required
                checked={reason === value}
                onChange={() => setReason(value)}
                className="h-5 w-5 shrink-0"
              />
              <span>{words.reasons[value]}</span>
            </label>
          ))}
        </div>
        {problem === "reason" ? (
          <p id="problem-reason-error" role="alert" className="mt-2 text-sm font-bold">
            {words.errorReason}
          </p>
        ) : null}
      </fieldset>
      <div>
        <label htmlFor="problem-note" className="st-label">
          {words.noteLabel}
        </label>
        <textarea
          ref={note}
          id="problem-note"
          name="note"
          rows={5}
          maxLength={ORDER_PROBLEM_NOTE_MAX}
          aria-describedby={problem === "note" ? "problem-note-hint problem-note-error" : "problem-note-hint"}
          aria-invalid={problem === "note" ? true : undefined}
          className="st-field"
        />
        <p id="problem-note-hint" className="st-muted mt-1 text-sm">
          {reason === "other" ? words.noteHintOther : words.noteHint}
        </p>
        {problem === "note" ? (
          <p id="problem-note-error" role="alert" className="mt-1 text-sm font-bold">
            {words.errorNote}
          </p>
        ) : null}
      </div>
      <button type="submit" className="btn st-btn btn-block">
        {words.send}
      </button>
    </form>
  );
}
