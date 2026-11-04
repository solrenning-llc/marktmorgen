"use client";

import { useState } from "react";
import { MAKER_UNRECORDED, type PausePreview } from "@/lib/api-key-rules";

/** How the owner's own session stands: logged in with a second step, has one but logged in without it, or has none. */
export type OwnerStep = "live" | "other_session" | "none";

const ERRORS: Record<string, string> = {
  owner_no_step: "Set up your own second step first: add a passkey or turn on an authenticator app under Two-step login in the studio, then log in again with it.",
  owner_step_session: "You logged in this time without your passkey or app code. Log in again with one of them, then come back here.",
  signed_out: "Your session ended. Log in again.",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The owner's switch: everybody on the team logs in with a second step (612
 * [WP11]). Nothing is saved by the first press: it opens a review of what
 * will happen (WCAG 3.3.6), who on the team has no second step yet and which
 * API keys will pause and whose (owner C3-100), and only "Turn it on" saves.
 * When the keys changed since the page was drawn, the server says so and the
 * review is shown again with the new list. Turning it off asks once too, and
 * says that paused keys stay paused.
 */
export function TeamTwoStepSwitch({
  on: initialOn,
  ownerStep,
  waiting,
  preview: initialPreview,
}: {
  on: boolean;
  ownerStep: OwnerStep;
  /** Team members with no second step yet: they are asked to set one up. */
  waiting: string[];
  preview: PausePreview;
}) {
  const [on, setOn] = useState(initialOn);
  const [preview, setPreview] = useState(initialPreview);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function save(next: boolean) {
    setBusy(true);
    setError(null);
    setDone(null);
    const response = await fetch("/api/store/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "two-step", on: next, expect: preview.total }),
    }).catch(() => null);
    const answer = response
      ? ((await response.json().catch(() => null)) as { ok?: boolean; error?: string; preview?: PausePreview; paused?: number; emailed?: number } | null)
      : null;
    setBusy(false);
    if (!answer?.ok) {
      if (answer?.error === "changed" && answer.preview) {
        setPreview(answer.preview);
        setError("The API keys changed since this page opened. Nothing was saved. Check the list again, then turn it on.");
        return;
      }
      setError(ERRORS[answer?.error ?? ""] ?? "That did not save. Nothing was changed. Try again in a moment.");
      return;
    }
    setOn(next);
    setReviewing(false);
    if (next) {
      const paused = answer.paused ?? 0;
      setDone(
        paused
          ? `Turned on. ${plural(paused, "API key is", "API keys are")} paused, and ${plural(answer.emailed ?? 0, "person was", "people were")} emailed how to turn theirs back on.`
          : "Turned on. Everyone on the team now logs in with a second step.",
      );
    } else {
      setDone("Turned off. The team no longer has to use a second step. Paused API keys stay paused until whoever made them turns them back on.");
    }
  }

  // An owner who has no second step at all may still turn it off (the server agrees); never on.
  const blocked = ownerStep === "other_session" || (ownerStep === "none" && !on);

  return (
    <div>
      <p className="text-sm font-semibold text-ink" role="status" aria-live="polite">
        {on ? "On: everyone on the team logs in with a second step." : "Off: team members may log in with the emailed link alone."}
      </p>
      <p id="team-two-step-help" className="mt-2 max-w-2xl text-sm text-ink-soft">
        A second step is a passkey, or a code from an authenticator app after the emailed link. Anyone without one is shown
        how to set it up the next time they open the studio, and keeps their role.
      </p>
      {blocked ? (
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">{ownerStep === "none" ? ERRORS.owner_no_step : ERRORS.owner_step_session}</p>
      ) : null}

      {reviewing ? (
        <section className="mt-4 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line" aria-labelledby="team-two-step-review">
          <TeamTwoStepReview on={on} waiting={waiting} preview={preview} />
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={on ? "btn btn-secondary" : "btn btn-primary"} disabled={busy} aria-busy={busy} onClick={() => save(!on)}>
              {busy ? "Saving…" : on ? "Turn it off" : "Turn it on"}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setReviewing(false); setError(null); }}>
              Cancel
            </button>
          </div>
        </section>
      ) : (
        <button
          type="button"
          className="btn btn-secondary mt-4"
          disabled={blocked}
          aria-describedby="team-two-step-help"
          onClick={() => { setReviewing(true); setDone(null); setError(null); }}
        >
          {on ? "Stop asking for a second step…" : "Ask the team for a second step…"}
        </button>
      )}

      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-3 text-sm font-semibold text-ink" role="status">
          {done}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What saving the switch will do, shown before it is saved (WCAG 3.3.6): on,
 * who has no second step yet and which API keys pause and whose; off, that
 * paused keys stay paused.
 */
export function TeamTwoStepReview({ on, waiting, preview }: { on: boolean; waiting: string[]; preview: PausePreview }) {
  return (
    <>
      <h3 id="team-two-step-review" className="font-semibold text-ink">
        {on ? "Before you turn it off" : "Before you turn it on"}
      </h3>
      {on ? (
        <p className="mt-2 text-sm text-ink-soft">
          Team members will be able to log in with the emailed link alone again. API keys paused before stay paused
          until whoever made them turns them back on.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink-soft">
            {waiting.length
              ? `${plural(waiting.length, "person has", "people have")} no second step yet and will be asked to set one up: ${waiting.join(", ")}.`
              : "Everyone on the team already has a second step."}
          </p>
          {preview.total ? (
            <>
              <p className="mt-3 text-sm font-semibold text-ink">
                {`${plural(preview.total, "API key", "API keys")} will pause, because ${preview.total === 1 ? "it was" : "they were"} made without a second step. Nothing is deleted.`}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                {preview.people.map((line) => (
                  <li key={line.who} className="break-words">
                    {line.who === MAKER_UNRECORDED
                      ? `${plural(line.count, "key", "keys")} made before November 4, 2026, when who made a key was not recorded`
                      : `${plural(line.count, "key", "keys")} made by ${line.who}${line.emailed ? ", who will get an email on how to turn them back on" : ""}`}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-ink-soft">
                Anything using a paused key is refused until it is turned back on, under API keys in the studio, by whoever
                made it after logging in with a second step.
                {preview.people.some((line) => line.who === MAKER_UNRECORDED) ? " Keys made before November 4, 2026 you can turn back on yourself, as nobody else can." : ""}
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-ink-soft">No API key will pause.</p>
          )}
        </>
      )}
    </>
  );
}
