"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { parseEnding, type EndingSetting } from "@/lib/access-ending-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  address: "Type the postal address where you can be reached. The law in the United States asks every email like this to carry one.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  server_error: "We could not confirm whether your access reminder settings were saved. Reload this page to check before trying again.",
};

/** 361 [AP1] (e): the reminder a member gets the day before their access ends (lib/access-ending-rules.ts, lib/access-ending.ts). */
export function EndingEditor({ ending, suggestedAddress }: { ending: EndingSetting; suggestedAddress: string }) {
  const router = useRouter();
  const [on, setOn] = useState(ending.on);
  const [address, setAddress] = useState(ending.address || suggestedAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/ending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on, address }) });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const expected = parseEnding({on,address});
      const saved = data.ending && typeof data.ending === "object" && !Array.isArray(data.ending) ? data.ending as Record<string, unknown> : {};
      if (response.ok && data.ok === true && data.error === undefined && saved.on === expected.on && saved.address === expected.address) {
        toast("Access reminder settings saved.");
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
    "A member whose membership is set to end gets one email from your store the day before, with the date and time it ends and the link to their membership page, where they can keep it.",
    "Once for each end date, and only if they agreed to hear from you and have not left your list. Stripe is checked again just before sending, so nobody who changed their mind is told it ends.",
    "In your store's language, from your store; their reply reaches you. No discount and no countdown. It carries a one-click way off your list and your postal address.",
  ];

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="ending-title" data-ending-editor aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ending-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Remind members the day before their access ends
        </h2>
        <span className={`tag ${ending.on ? "tag-live" : ""}`}>{ending.on ? "On" : "Off"}</span>
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
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-ink" htmlFor="ending-on">
          <input id="ending-on" disabled={busy} type="checkbox" className="h-5 w-5" checked={on} onChange={(event) => setOn(event.target.checked)} />
          <span>Send the reminder the day before access ends</span>
        </label>
        <label className="block" htmlFor="ending-address">
          <span className="field-label">Your postal address, printed at the bottom</span>
          <input id="ending-address" disabled={busy} className="field mt-2" maxLength={300} value={address} onChange={(event) => setAddress(event.target.value)} />
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
