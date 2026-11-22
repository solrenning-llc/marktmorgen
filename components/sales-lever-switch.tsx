"use client";

import { useEffect, useId, useRef, useState } from "react";
import { SWITCH_START, type LeverRoute, type LeverSwitch, type SwitchView, pressLever, refreshedView, shownSwitch } from "@/lib/sales-lever-toggle-rules";

/** The card's request to the setting's own route (the studio's store pin adds which store). */
async function post(route: LeverRoute, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return response.json();
}

/**
 * The on/off switch on a "Grow your sales" card (752 [CD3]), for a lever
 * with an on/off setting of its own (lib/sales-lever-toggle-rules.ts). It
 * saves through that setting's route, says what happened in words, and offers
 * Undo until the next press, with no timer. After a reply that did not
 * confirm the change, it says so and asks for a reload instead of guessing.
 *
 * What it draws is the saved state of the last confirmed reply, not a flip of
 * the control, which the page re-renders from the store on every refresh
 * (shownSwitch); a refresh that draws another saved state than its own
 * (another tab) puts the card back to the control as drawn (refreshedView).
 * When the focused button goes away, the focus goes on rather
 * than to the page's body (WCAG 2.4.3; Claude 1's and Claude 7's MÉDIO on
 * #3563): a confirmed Undo hands it to the switch, an unconfirmed reply to
 * "Reload the page". When another tab's change resets the card, the status region says so, and a focus the
 * removed Undo held goes to the switch.
 */
export function SalesLeverSwitch({ control, states }: { control: LeverSwitch; states: { on: string; off: string } }) {
  const id = useId();
  const [view, setView] = useState<SwitchView>(SWITCH_START);
  // The saved state the page last drew. When a refresh draws another one, the card's own view is read against it
  // during this render (refreshedView), so the card never shows a state another tab has since changed.
  const [drawnOn, setDrawnOn] = useState(control.on);
  // What the status region says when another tab's change reset the card, and whether the focus should go on to the
  // switch: the reset drops the Undo, and a focus it held would fall to the page's body (Codex X6's LOW on #3563;
  // WCAG 2.4.3, 4.1.3).
  const [elsewhere, setElsewhere] = useState<string | null>(null);
  // Counts the resets that dropped an Undo; the effect below hands the focus on once for each.
  const [refocus, setRefocus] = useState(0);
  if (drawnOn !== control.on) {
    setDrawnOn(control.on);
    const next = refreshedView(view, control.on);
    if (next !== view) {
      const state = `${control.on ? states.on : states.off}.`;
      setElsewhere(view.undo ? `This setting was changed elsewhere, so Undo is gone. ${state}` : `This setting was changed elsewhere. ${state}`);
      if (view.undo) setRefocus(refocus + 1);
    }
    setView(next);
  }
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const switchRef = useRef<HTMLButtonElement>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);
  // Where the focus goes once the button it was on is gone, read after the render that removed it.
  const focusTo = useRef<"switch" | "reload" | null>(null);
  const known = view.saved !== "unknown";
  const now = shownSwitch(control, view);

  useEffect(() => {
    const to = focusTo.current;
    if (!to) return;
    focusTo.current = null;
    // Only a focus the removed button left on the page's body: never one the person moved elsewhere.
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (lost) (to === "reload" ? reloadRef : switchRef).current?.focus();
  });

  // After a reset by another tab's change: the switch takes a focus the removed Undo left on the page's body, never
  // one the person moved elsewhere.
  const refocused = useRef(0);
  useEffect(() => {
    if (refocus === refocused.current) return;
    refocused.current = refocus;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (lost) switchRef.current?.focus();
  }, [refocus]);

  async function press(how: "switch" | "undo") {
    if (sending.current || !known) return;
    sending.current = true;
    setElsewhere(null);
    setBusy(true);
    try {
      const next = await pressLever(control, view, how, post);
      if (next.saved === "unknown") focusTo.current = "reload";
      else if (how === "undo" && !next.undo) focusTo.current = "switch";
      setView(next);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <p className="text-sm font-semibold text-violet-deep">{known ? (now.on ? states.on : states.off) : "Saved setting unknown: reload the page to see it"}</p>
      {known ? (
        <>
          <button
            ref={switchRef}
            type="button"
            role="switch"
            aria-checked={now.on}
            aria-describedby={`${id}-before ${id}-buyers`}
            aria-disabled={busy}
            onClick={() => void press("switch")}
            className="mt-3 inline-flex min-h-11 items-center gap-3 rounded-full px-1 font-semibold text-ink"
          >
            <span aria-hidden="true" className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-current ${now.on ? "justify-end bg-violet-deep" : "justify-start bg-paper"}`}>
              <span className={`mx-0.5 h-4 w-4 rounded-full border-2 border-current ${now.on ? "bg-paper" : "bg-ink-soft"}`} />
            </span>
            <span>{control.title}</span>
            <span aria-hidden="true">{now.on ? "On" : "Off"}</span>
          </button>
          <p id={`${id}-before`} className="mt-2 text-sm text-ink-soft">{now.before}</p>
          <p id={`${id}-buyers`} className="mt-2 text-sm text-ink-soft">
            <span className="font-semibold text-ink">What buyers see: </span>
            {control.buyerSees}
          </p>
        </>
      ) : (
        <button ref={reloadRef} type="button" className="btn btn-secondary mt-3" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      )}
      <div role="status" className="mt-2 text-sm">
        {view.outcome ? <p className={view.outcome.state === "saved" ? "text-ink" : "font-semibold text-ink"}>{busy ? "Saving…" : view.outcome.text}</p> : busy ? <p>Saving…</p> : elsewhere ? <p className="font-semibold text-ink">{elsewhere}</p> : null}
      </div>
      {known && view.undo ? (
        <button type="button" aria-disabled={busy} onClick={() => void press("undo")} className="btn btn-secondary btn-sm mt-2">
          Undo<span className="sr-only">{`: ${now.label}`}</span>
        </button>
      ) : null}
    </div>
  );
}
