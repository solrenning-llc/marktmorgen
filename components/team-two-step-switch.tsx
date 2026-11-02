"use client";

import { useState } from "react";

/**
 * The owner's switch: everybody on the team signs in with a second step
 * (612 [WP11]). Beside it, who is ready now and who would be sent to set one
 * up, so switching it on never surprises anybody. Only an owner who has a
 * second step themselves may switch it on (the server says so otherwise).
 */
export function TeamTwoStepSwitch({ on: initialOn, ownerReady, members }: { on: boolean; ownerReady: boolean; members: { email: string; ready: boolean }[] }) {
  const [on, setOn] = useState(initialOn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const waiting = members.filter((m) => !m.ready).length;
  return (
    <div>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold text-ink">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          aria-describedby="team-two-step-help"
          className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand"
          onChange={async (event) => {
            const next = event.target.checked;
            setBusy(true);
            setError(null);
            setDone(null);
            const response = await fetch("/api/store/team", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "two-step", on: next }),
            }).catch(() => null);
            const answer = response ? ((await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null) : null;
            setBusy(false);
            if (!answer?.ok) {
              setError(
                answer?.error === "owner_two_step"
                  ? "Set up your own second step first: a passkey or an authenticator app, in your account settings in the studio."
                  : "That did not save. Try again in a moment.",
              );
              return;
            }
            setOn(next);
            setDone(next ? "Everyone on the team now signs in with a second step." : "The team no longer has to use a second step.");
          }}
        />
        Everyone on the team signs in with a second step
      </label>
      <p id="team-two-step-help" className="mt-2 max-w-2xl text-sm text-ink-soft">
        A passkey or a code from an authenticator app, after the emailed link. Anyone without one is shown how to set it
        up the next time they open the studio, and keeps their invitation and their role.
        {ownerReady ? "" : " You need a second step of your own before you can switch this on."}
      </p>
      {members.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm" aria-label="Who has a second step">
          {members.map((m) => (
            <li key={m.email} className="flex flex-wrap gap-x-2">
              <span className="break-all font-semibold text-ink">{m.email}</span>
              <span className="text-ink-soft">{m.ready ? "has a second step" : "has no second step yet"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {waiting > 0 && !on ? (
        <p className="mt-2 text-sm text-ink-soft">{`${waiting} ${waiting === 1 ? "person" : "people"} would be asked to set one up.`}</p>
      ) : null}
      {error ? (
        <p className="notice notice-error mt-2" role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="mt-2 text-sm font-semibold" role="status">
          {done}
        </p>
      ) : null}
    </div>
  );
}
