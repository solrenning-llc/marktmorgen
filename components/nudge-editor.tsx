"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { parseNudge, type Nudge } from "@/lib/member-health-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  address: "Type the postal address where you can be reached. The law in the United States asks every email like this to carry one.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  server_error: "We could not confirm whether your member email settings were saved. Reload this page to check before trying again.",
};

/** The come-back email to members who stopped coming (lib/member-health-rules.ts, lib/member-nudge.ts). */
export function NudgeEditor({ nudge, suggestedAddress, sent }: { nudge: Nudge; suggestedAddress: string; sent: number | null }) {
  const router = useRouter();
  const [on, setOn] = useState(nudge.on);
  const [address, setAddress] = useState(nudge.address || suggestedAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/nudge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on, address }) });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const expected = parseNudge({on,address});
      const saved = data.nudge && typeof data.nudge === "object" && !Array.isArray(data.nudge) ? data.nudge as Record<string, unknown> : {};
      if (response.ok && data.ok === true && data.error === undefined && saved.on === expected.on && saved.address === expected.address) {
        toast("Member email settings saved.");
        router.refresh();
        return;
      }
      const reason = typeof data.error === "string" ? data.error : "";
      setError(!response.ok && data.ok === false && Object.prototype.hasOwnProperty.call(MESSAGES, reason) ? MESSAGES[reason] : MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const bullets = [
    "Every running member has a score on your Membership numbers page. A member at risk only for being away, who never opened the course or community their membership includes, or has not for 30 days and more, gets one email from your store with the way back in.",
    "Once for each period they pay for, and only if they agreed to hear from you and have not left your list. Never to somebody whose payment failed, who canceled or who paused.",
    "In your store's language, from your store; their reply reaches you. It carries the reason they get it, a one-click way off your list and your postal address.",
  ];

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="nudge-title" data-nudge-editor aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="nudge-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Email members who stopped coming
        </h2>
        <span className={`tag ${nudge.on ? "tag-live" : ""}`}>{nudge.on ? "On" : "Off"}</span>
      </div>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        {bullets.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {nudge.on ? (
        sent === null ? (
          <p className="mt-3 text-sm text-ink-soft" role="status">{"We could not check just now how many were sent this month. Reload this page in a moment to check again."}</p>
        ) : (
          <p className="mt-3 text-sm text-ink">{`Sent this month: ${sent}`}</p>
        )
      ) : null}
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-ink" htmlFor="nudge-on">
          <input id="nudge-on" disabled={busy} type="checkbox" className="h-5 w-5" checked={on} onChange={(event) => setOn(event.target.checked)} />
          <span>Email members who stopped coming</span>
        </label>
        <label className="block" htmlFor="nudge-address">
          <span className="field-label">Your postal address, printed at the bottom</span>
          <input id="nudge-address" disabled={busy} className="field mt-2" maxLength={300} value={address} onChange={(event) => setAddress(event.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
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
