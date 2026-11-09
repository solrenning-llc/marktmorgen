"use client";

import { type FormEvent, useRef, useState } from "react";
import type { DoorOutcome } from "@/lib/ticket-door";

/**
 * The check-in screen at the door of an in-person event: 36 [F5], unit 2
 * (app/api/store/check-in/route.ts). One field and one button: type the code
 * printed under the ticket's QR code, or use a scanner that types it, and
 * press Enter. The result stays on the screen until the next code, with no
 * time limit, and is read out from a status region. Every result says in
 * words whether to let the person in, never by color alone; "could not check"
 * keeps the door shut (rule 24).
 */

/** What the door does, first, for each outcome. */
export const DOOR_HEADLINES: Readonly<Record<DoorOutcome, string>> = {
  admitted: "Let them in. The ticket is good and is now used.",
  used: "Do not let them in. This ticket was already used.",
  invalid: "Do not let them in. This is not a good ticket for this event.",
  expired: "Do not let them in. This ticket is no longer good.",
  unknown: "Do not let them in yet. We could not check this ticket.",
};

/** When the answer did not come back at all. */
const NO_ANSWER = "We could not reach Marktmorgen. Try again in a moment.";

const OUTCOMES: readonly DoorOutcome[] = ["admitted", "used", "invalid", "expired", "unknown"];

type Result = { outcome: DoorOutcome; message: string; ending: string };

const PANEL: Record<DoorOutcome, string> = {
  admitted: "border-mint-deep bg-mint-soft",
  used: "border-danger bg-danger-soft",
  invalid: "border-danger bg-danger-soft",
  expired: "border-danger bg-danger-soft",
  unknown: "border-amber-brand bg-amber-soft",
};

export function TicketCheckIn({ event }: { event: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const field = useRef<HTMLInputElement>(null);

  async function check(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (busy) return;
    const typed = code.trim();
    if (!typed) {
      setEmpty(true);
      field.current?.focus();
      return;
    }
    setEmpty(false);
    setBusy(true);
    let next: Result;
    try {
      const response = await fetch("/api/store/check-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, code: typed }) });
      const answer = (await response.json().catch(() => ({}))) as { outcome?: unknown; message?: unknown; ending?: unknown };
      const outcome = OUTCOMES.find((o) => o === answer.outcome);
      // Only an answer that says "admitted" in so many words admits; anything else is "could not check".
      next = outcome
        ? { outcome, message: typeof answer.message === "string" ? answer.message : "", ending: typeof answer.ending === "string" ? answer.ending : "" }
        : { outcome: "unknown", message: typeof answer.message === "string" ? answer.message : NO_ANSWER, ending: "" };
    } catch {
      next = { outcome: "unknown", message: NO_ANSWER, ending: "" };
    }
    setResult(next);
    // Ready for the next person; a code that could not be checked stays, so Enter tries it again.
    if (next.outcome !== "unknown") setCode("");
    setBusy(false);
    field.current?.focus();
  }

  return (
    <div>
      <form onSubmit={(e) => void check(e)} noValidate>
        <label htmlFor="check-in-code" className="field-label block">
          Ticket code
        </label>
        <p id="check-in-code-hint" className="mt-1 text-sm text-ink-soft">
          Type the code printed under the ticket&apos;s QR code, then press Enter. A scanner that types the code works too.
        </p>
        <input
          id="check-in-code"
          ref={field}
          className="field mt-2 font-mono"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (empty) setEmpty(false);
          }}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-describedby={empty ? "check-in-code-hint check-in-code-error" : "check-in-code-hint"}
          aria-invalid={empty || undefined}
        />
        {empty ? (
          <span id="check-in-code-error" className="field-error mt-1 block" role="alert">
            Type a ticket code first.
          </span>
        ) : null}
        <button type="submit" className="btn btn-primary mt-4" aria-disabled={busy || undefined}>
          Check in
        </button>
      </form>
      <div role="status" aria-live="polite" aria-atomic="true" className="mt-6">
        {busy ? <p className="text-ink-soft">Checking the ticket…</p> : null}
        {!busy && result ? (
          <div className={`rounded-xl border-2 p-5 ${PANEL[result.outcome]}`}>
            <p className="text-lg font-semibold text-ink">{DOOR_HEADLINES[result.outcome]}</p>
            {result.message ? <p className="mt-2 text-ink">{result.message}</p> : null}
            {result.ending ? <p className="mt-2 text-sm text-ink-soft">Code ending in {result.ending}.</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
