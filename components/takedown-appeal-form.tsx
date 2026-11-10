"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MAX_APPEAL_TEXT } from "@/lib/takedown-appeal-rules";

/**
 * The form of one request to look again (646 [WG6], unit 2), in two steps so nothing is sent by mistake (WCAG 3.3.6):
 * write why, check the words, then send. A problem stays next to the field (role="alert"), with the words kept so
 * nothing is typed twice (3.3.7). No time limit.
 *
 * Focus is never lost (2.4.3, review of #3533): entering the check step moves it to that step's heading, every return
 * to the first step moves it to the field, and the outcome goes into one live region mounted from the start (a
 * region that appears with its text already in it is often not announced), which then takes the focus itself.
 */
export function TakedownAppealForm({ decision, what }: { decision: string; what: string }) {
  const id = useId();
  const [words, setWords] = useState("");
  const [step, setStep] = useState<"write" | "check" | "sending" | "done">("write");
  const [problem, setProblem] = useState("");
  const [answer, setAnswer] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const checkHeading = useRef<HTMLHeadingElement>(null);
  const outcome = useRef<HTMLParagraphElement>(null);
  const moved = useRef(false);
  const left = MAX_APPEAL_TEXT - words.length;

  // After each change of step, the focus goes where the person now is; not on the first drawing of the page.
  useEffect(() => {
    if (!moved.current) return;
    if (step === "write") field.current?.focus();
    if (step === "check") checkHeading.current?.focus();
    if (step === "done") outcome.current?.focus();
  }, [step]);
  const go = (next: "write" | "check" | "sending" | "done") => {
    moved.current = true;
    setStep(next);
  };

  async function send() {
    go("sending");
    setProblem("");
    try {
      const response = await fetch("/api/store/appeal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "file", decision, explanation: words }) });
      const data: unknown = await response.json().catch(() => null);
      const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      if (response.ok && d.ok === true && typeof d.number === "string") {
        setAnswer(`We have your request ${d.number}. A person at Marktmorgen will look at it, and the answer will give its reason. This page shows where it stands.`);
        go("done");
        return;
      }
      if (response.status === 202 && d.error === "unsent") {
        setAnswer(typeof d.message === "string" ? d.message : "Your request is kept, but we could not pass it on yet. Reload this page to send it again.");
        go("done");
        return;
      }
      setProblem(typeof d.message === "string" ? d.message : "We could not send your request just now. Nothing was sent. Try again in a moment.");
      go("write");
    } catch {
      setProblem("We could not reach Marktmorgen just now. Nothing was sent. Try again in a moment.");
      go("write");
    }
  }

  return (
    <div className="mt-5">
      {step === "write" ? (
        <form onSubmit={(event) => { event.preventDefault(); if (!words.trim()) { setProblem("Tell us in a sentence or more why you think the decision is wrong."); field.current?.focus(); return; } setProblem(""); go("check"); }} noValidate>
          <label htmlFor={`${id}-why`} className="field-label">Why should we look again?</label>
          <p id={`${id}-hint`} className="field-hint mt-1">
            For example: you own the rights, you have a license, or the notice names the wrong thing. You can write up to {MAX_APPEAL_TEXT.toLocaleString("en-US")} characters.
          </p>
          <textarea
            id={`${id}-why`}
            ref={field}
            className="field mt-2 min-h-40"
            value={words}
            maxLength={MAX_APPEAL_TEXT}
            onChange={(event) => setWords(event.target.value)}
            aria-describedby={`${id}-hint ${id}-left${problem ? ` ${id}-problem` : ""}`}
            aria-invalid={problem ? true : undefined}
          />
          <p id={`${id}-left`} className="field-hint mt-1">{left.toLocaleString("en-US")} characters left.</p>
          {problem ? <p id={`${id}-problem`} role="alert" className="field-error mt-1">{problem}</p> : null}
          <button type="submit" className="btn btn-primary mt-4 min-h-11">Check my request</button>
        </form>
      ) : step === "done" ? null : (
        <section aria-labelledby={`${id}-check`}>
          <h3 id={`${id}-check`} ref={checkHeading} tabIndex={-1} className="font-semibold">Check your request</h3>
          <p className="mt-1 text-sm">About: {what}</p>
          <blockquote className="mt-2 max-w-[80ch] whitespace-pre-wrap border-l-4 border-line pl-4">{words}</blockquote>
          {problem ? <p role="alert" className="field-error mt-2">{problem}</p> : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" className="btn btn-primary min-h-11" onClick={send} disabled={step === "sending"} aria-disabled={step === "sending" ? true : undefined}>
              {step === "sending" ? "Sending…" : "Send my request"}
            </button>
            <button type="button" className="btn btn-secondary min-h-11" onClick={() => go("write")} disabled={step === "sending"}>
              Change it
            </button>
          </div>
        </section>
      )}
      {/* Mounted from the start, empty until there is an outcome, so the outcome is announced when it comes. */}
      <p ref={outcome} tabIndex={-1} role="status" data-appeal-outcome="" className={answer ? "mt-4 max-w-[80ch] font-semibold text-ink" : "sr-only"}>{answer}</p>
    </div>
  );
}

/** Tells our team again about a kept request it was never told of. */
export function TakedownAppealSendAgain({ decision, number }: { decision: string; number: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [words, setWords] = useState("");
  async function again() {
    setState("sending");
    try {
      const response = await fetch("/api/store/appeal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "again", decision }) });
      const data: unknown = await response.json().catch(() => null);
      const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      if (response.ok && d.ok === true && d.told === true) {
        setWords(`Request ${number} is passed on to our team.`);
        setState("sent");
        return;
      }
      setWords(typeof d.message === "string" ? d.message : "We could not pass it on just now. Try again in a moment.");
      setState("failed");
    } catch {
      setWords("We could not reach Marktmorgen just now. Try again in a moment.");
      setState("failed");
    }
  }
  return (
    <div className="mt-3">
      <p className="max-w-[80ch]">We could not pass this request on to our team yet.</p>
      {state === "sent" ? null : (
        <button type="button" className="btn btn-primary mt-2 min-h-11" onClick={again} disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : "Send it again"}
        </button>
      )}
      <p role="status" className="mt-2">{words}</p>
    </div>
  );
}
