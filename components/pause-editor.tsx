"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { PAUSE_CHOICES } from "@/lib/membership-pause-rules";
import { STUDIO_MESSAGES, SESSION_ENDED } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  months: "Pick off, or one, two or three months.",
  none: "This account has no store yet.",
  signed_out: SESSION_ENDED,
  server_error: "We could not confirm whether your pause setting was saved. Reload this page to check before trying again.",
};

/** Whether members may pause instead of canceling, and for how long (lib/membership-pause-rules.ts). */
export function PauseEditor({ months }: { months: number }) {
  const router = useRouter();
  const [chosen, setChosen] = useState(months);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ months: chosen }) });
      const raw: unknown = await response.json().catch(() => null);
      const data = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown> : {};
      if (response.ok && data.ok === true && data.error === undefined && data.pause === chosen) {
        toast(chosen ? "Members can pause now." : "Pausing is off.");
        router.refresh();
        return;
      }
      setError(typeof data.error === "string" && Object.hasOwn(MESSAGES, data.error) ? MESSAGES[data.error] : MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const bullets = [
    "On the page where a member would cancel, they can pause instead, for up to the months you choose.",
    "What they paid for stays open to the last day. Then nothing is charged and the membership is closed until the pause ends, when it starts again by itself with a payment.",
    "They can come back sooner: that takes a payment the same day, so an early return is never free days.",
    "Only on memberships charged every month and running normally, and once a year per membership, so a pause is a break and not a cheaper way to belong. Stripe skips the payments on your own account.",
  ];

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="pause-title" data-pause-editor>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pause-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Let members pause instead of canceling
        </h2>
        <span className={`tag ${months ? "tag-live" : ""}`}>{months ? "On" : "Off"}</span>
      </div>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        {bullets.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <form
        className="mt-5 flex flex-wrap items-end gap-3"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="block" htmlFor="pause-months">
          <span className="field-label">Members may pause for</span>
          <select id="pause-months" className="field mt-2" disabled={busy} value={chosen} onChange={(event) => setChosen(Number(event.target.value))}>
            {PAUSE_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "Off: no pausing" : n === 1 ? "Up to 1 month" : `Up to ${n} months`}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || chosen === months} aria-busy={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
