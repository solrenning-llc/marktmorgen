"use client";

import { useState } from "react";
import { ALWAYS_ON_ROWS, OPTIONAL_ROWS, type OptionalEvent } from "@/lib/notify-prefs-rules";

/**
 * The studio's alert email choices (app/studio/notifications, lib/notify-prefs.ts):
 * one labeled box per optional alert and one Save; the notices that cannot be
 * switched off are listed as text with their reason, not as boxes that do nothing.
 */
const UNCONFIRMED = "We could not confirm the save. Reload this page to see what is saved, then try again.";

/** What to tell the person, from the route's error: what happened, and what to do next. */
function refusal(error: string | undefined): string {
  if (error === "signed_out") return "Your sign-in has ended, so nothing was changed. Sign in again, then save.";
  if (error === "forbidden") return "Only the store's owner or an Admin can change these, so nothing was changed.";
  if (error === "server_error" || error === undefined) return UNCONFIRMED;
  return "Nothing was changed. Try again in a moment.";
}

export function NotifyPrefsPanel({ off: initial }: { off: OptionalEvent[] }) {
  const [saved, setSaved] = useState<OptionalEvent[]>(initial);
  const [off, setOff] = useState<OptionalEvent[]>(initial);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = off.length !== saved.length || off.some((event) => !saved.includes(event));

  async function save() {
    setBusy(true);
    setSaid(null);
    try {
      const response = await fetch("/api/store/notify-prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ off }) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; off?: OptionalEvent[]; error?: string };
      if (data.ok && Array.isArray(data.off)) {
        setSaved(data.off);
        setOff(data.off);
        setSaid({ ok: true, text: "Saved. Your alert emails follow these choices from now on." });
      } else {
        setSaid({ ok: false, text: refusal(data.error) });
      }
    } catch {
      setSaid({ ok: false, text: UNCONFIRMED });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 max-w-2xl">
      <section aria-labelledby="notify-choose">
        <h2 id="notify-choose" className="t-h3">
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
          <fieldset disabled={busy}>
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
                    <span>
                      <span className="font-semibold text-ink">{row.title}</span>
                      <span id={`notify-${row.id}-text`} className="block text-sm text-ink-soft">
                        {row.text}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <button type="submit" className="btn btn-primary mt-5 min-h-11" disabled={!changed || busy}>
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
