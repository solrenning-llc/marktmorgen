"use client";

import { useRef, useState } from "react";
import { ALWAYS_ON_ROWS, OPTIONAL_ROWS, type OptionalEvent } from "@/lib/notify-prefs-rules";

const UNCONFIRMED = "We could not confirm the save. Reload this page to see what is saved, then try again.";

type Answer = { ok?: boolean; off?: OptionalEvent[]; restarted?: boolean; error?: string; message?: string };

/** What to tell the owner, from the route's error: what happened, and what to do next. */
function refusal(data: Answer): string {
  switch (data.error) {
    case "signed_out":
      return "Your sign-in has ended, so nothing was changed. Sign in again, then save.";
    case "role":
    case "owner_only":
    case "forbidden":
      return "Only the store's owner can change these, so nothing was changed.";
    case "studio_used":
    case "locked":
      return data.message ? `Nothing was changed. ${data.message}` : "Nothing was changed. Try again later.";
    case "two_step_required":
      return "Nothing was changed. Log in again with your second step, then save.";
    case "store_gone":
      return "Nothing was changed: this store is closed.";
    case "invalid":
    case "always_on":
    case "none":
      return "Nothing was changed. Reload this page, then try again.";
    default:
      return UNCONFIRMED;
  }
}

/**
 * What a successful save says, for each reading of the weekly email's stop
 * link: off, on, or unknown (null, the read failed). Only "off" may say the
 * emails now follow the choices.
 */
export function savedText(stopped: boolean | null): string {
  if (stopped === false) return "Saved. Your alert emails follow these choices from now on.";
  if (stopped) return "Saved. These emails stay stopped by the weekly email's link until you start them again above.";
  return "Saved. If the stop link in a weekly email was used, these emails stay stopped until you start them again above.";
}

/**
 * The studio's alert email choices (app/studio/notifications; alertEmailsOff
 * in the store record, lib/notify-prefs-rules.ts): one labeled box per
 * optional alert and one Save; the notices that cannot be switched off are
 * listed as text with their reason, not as boxes that do nothing. While the
 * weekly email's stop link holds, or could not be checked (stopped is null),
 * that is said first, with a way to undo it. Nothing is disabled while
 * saving, so focus stays where the person left it; a successful restart
 * removes its own button, so focus moves to the "Alerts you choose" heading.
 */
export function NotifyPrefsPanel({ off: initial, stopped: initiallyStopped }: { off: OptionalEvent[]; stopped: boolean | null }) {
  const [saved, setSaved] = useState<OptionalEvent[]>(initial);
  const [off, setOff] = useState<OptionalEvent[]>(initial);
  const [stopped, setStopped] = useState<boolean | null>(initiallyStopped);
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = off.length !== saved.length || off.some((event) => !saved.includes(event));

  async function post(body: Record<string, unknown>): Promise<Answer | null> {
    try {
      const response = await fetch("/api/store/notify-prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return (await response.json().catch(() => ({}))) as Answer;
    } catch {
      return null;
    }
  }

  async function save() {
    if (busy) return;
    if (!changed) {
      setSaid({ ok: true, text: "Nothing to save: these are already your choices." });
      return;
    }
    setBusy(true);
    setSaid(null);
    const data = await post({ off });
    setBusy(false);
    if (data?.ok && Array.isArray(data.off)) {
      setSaved(data.off);
      setOff(data.off);
      setSaid({ ok: true, text: savedText(stopped) });
    } else setSaid({ ok: false, text: data ? refusal(data) : UNCONFIRMED });
  }

  async function restart() {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    const data = await post({ restart: true });
    setBusy(false);
    if (data?.ok && data.restarted) {
      setStopped(false);
      // The focused button goes with the stop block: move focus to the heading that stays.
      heading.current?.focus();
      setSaid({ ok: true, text: "Started again. The alerts you chose, and the weekly, monthly and busy-day emails, come again." });
    } else setSaid({ ok: false, text: data ? refusal(data) : UNCONFIRMED });
  }

  return (
    <div className="mt-8 max-w-2xl">
      {stopped !== false ? (
        <div className="notice mb-8">
          {stopped ? (
            <p>
              All of these alert emails are stopped, because the stop link in a weekly email was used. The weekly, monthly and busy-day emails are
              stopped too. Your choices below apply once they start again.
            </p>
          ) : (
            <p>
              We could not check whether the stop link in a weekly email was used. If it was, all of these alert emails are stopped, along with
              the weekly, monthly and busy-day emails. Reload this page to see, or start them again here.
            </p>
          )}
          <button type="button" className="btn btn-secondary mt-3 inline-flex min-h-11 items-center justify-center" aria-busy={busy} onClick={() => void restart()}>
            Start these emails again
          </button>
        </div>
      ) : null}

      <section aria-labelledby="notify-choose">
        <h2 id="notify-choose" ref={heading} tabIndex={-1} className="t-h3">
          Alerts you choose
        </h2>
        <p className="mt-2 text-ink-soft">
          Each one is on until you turn it off. Turning one off stops its email only. Your phone and your team chat keep their own settings.
        </p>
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset>
            <legend className="sr-only">Email me about</legend>
            <ul className="space-y-3">
              {OPTIONAL_ROWS.map((row) => (
                <li key={row.id}>
                  <label className="flex min-h-11 items-start gap-3" htmlFor={`notify-${row.id}`}>
                    <input
                      id={`notify-${row.id}`}
                      type="checkbox"
                      className="mt-1 h-5 w-5"
                      checked={!off.includes(row.id)}
                      onChange={(event) => setOff((now) => (event.target.checked ? now.filter((e) => e !== row.id) : [...now, row.id]))}
                      aria-describedby={`notify-${row.id}-text`}
                    />
                    <span className="font-semibold text-ink">{row.title}</span>
                  </label>
                  {/* Outside the label: given once, by aria-describedby, not also in the box's name. */}
                  <p id={`notify-${row.id}-text`} className="ml-8 text-sm text-ink-soft">
                    {row.text}
                  </p>
                </li>
              ))}
            </ul>
            <button type="submit" className="btn btn-primary mt-5 inline-flex min-h-11 items-center justify-center" aria-busy={busy}>
              {busy ? "Saving…" : "Save choices"}
            </button>
          </fieldset>
        </form>
        <p className="mt-4 text-sm text-ink-soft">
          The stop link at the foot of the weekly email stops all of these alerts too, along with the weekly, monthly and busy-day emails.
        </p>
        <p role="status" aria-live="polite" className={said ? (said.ok ? "notice mt-4" : "notice notice-error mt-4") : "sr-only"}>
          {said?.text ?? ""}
        </p>
      </section>

      <section aria-labelledby="notify-always" className="mt-10">
        <h2 id="notify-always" className="t-h3">
          Always sent
        </h2>
        <p className="mt-2 text-ink-soft">These emails cannot be turned off, for the reason given with each.</p>
        <ul className="mt-4 space-y-4">
          {ALWAYS_ON_ROWS.map((row) => (
            <li key={row.id}>
              <p className="font-semibold text-ink">
                {row.title} <span className="text-sm font-normal text-ink-soft">(Always on)</span>
              </p>
              <p className="text-sm text-ink-soft">{row.text}</p>
              <p className="text-sm text-ink">Why: {row.reason}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
