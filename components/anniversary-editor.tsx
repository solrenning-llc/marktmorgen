"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { MAX_ANNIVERSARY_ADDRESS, MAX_ANNIVERSARY_MESSAGE, anniversaryEmail, parseAnniversary, type Anniversary } from "@/lib/anniversary-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  address: "Type the postal address where you can be reached. The law in the United States asks every email like this to carry one.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  server_error: "We could not confirm whether your anniversary email settings were saved. Reload this page to check before trying again.",
};

/** The email on the anniversary of a purchase (lib/anniversary-rules.ts, lib/anniversary-send.ts; 283 [HG2]). */
export function AnniversaryEditor({
  setting,
  storeName,
  suggestedAddress,
  sent,
  connected,
}: {
  setting: Anniversary;
  storeName: string;
  suggestedAddress: string;
  sent: number;
  connected: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(setting.on);
  const [message, setMessage] = useState(setting.message);
  const [address, setAddress] = useState(setting.address || suggestedAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/anniversary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on, message, address }) });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const expected = parseAnniversary({ on, message, address });
      const saved = data.anniversary && typeof data.anniversary === "object" && !Array.isArray(data.anniversary) ? (data.anniversary as Record<string, unknown>) : {};
      if (response.ok && data.ok === true && data.error === undefined && saved.on === expected.on && saved.message === expected.message && saved.address === expected.address) {
        toast("Anniversary email settings saved.");
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
    "A year after somebody buys a product from your store, they get one email from you that says when they bought it and what, with your few words below and a link to your store.",
    "Only to buyers who checked the box to hear from you when they paid, and who are still on your list. Never to somebody who left your list, whose email bounced, or whose purchase was refunded or disputed.",
    "At most once per person for each date. Each email counts toward your store's emails for the month, and none is sent when they are used up.",
    "It carries the reason they get it, a one-click way off your list and your postal address. We never ask a buyer for a birth date: the only date used is the day they bought.",
  ];
  // What a buyer reads, with this store's name and the words typed now (an example product and date).
  const example = anniversaryEmail({ storeName: storeName || "Your store", title: "Your product", boughtOn: "November 6, 2025", message, link: "Your store's link" });

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="anniversary-title" data-anniversary-editor aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="anniversary-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Email buyers a year after they buy
        </h2>
        <span className={`tag ${setting.on ? "tag-live" : ""}`}>{setting.on ? "On" : "Off"}</span>
      </div>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        {bullets.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {!connected ? (
        <p className="notice mt-3" role="note">
          Connect your Stripe account first. The date of each purchase is read from your sales there.
        </p>
      ) : null}
      {setting.on ? <p className="mt-3 text-sm text-ink">{`Sent this month: ${sent}`}</p> : null}
      <form
        className="mt-5 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-ink" htmlFor="anniversary-on">
          <input id="anniversary-on" disabled={busy} type="checkbox" className="h-5 w-5" checked={on} onChange={(event) => setOn(event.target.checked)} />
          <span>Email buyers a year after they buy</span>
        </label>
        <label className="block" htmlFor="anniversary-message">
          <span className="field-label">Your words, below the date (optional)</span>
          <span id="anniversary-message-help" className="mt-1 block text-sm text-ink-soft">
            {`For example: "The second edition is out, with two new chapters." Up to ${MAX_ANNIVERSARY_MESSAGE} characters. Shown exactly as you write it.`}
          </span>
          <textarea
            id="anniversary-message"
            aria-describedby="anniversary-message-help"
            disabled={busy}
            className="field mt-2"
            rows={4}
            maxLength={MAX_ANNIVERSARY_MESSAGE}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <label className="block" htmlFor="anniversary-address">
          <span className="field-label">Your postal address, printed at the bottom</span>
          <input id="anniversary-address" disabled={busy} className="field mt-2" maxLength={MAX_ANNIVERSARY_ADDRESS} value={address} onChange={(event) => setAddress(event.target.value)} />
        </label>
        <div className="rounded-xl border border-line p-4" aria-labelledby="anniversary-example-title" role="group">
          <h3 id="anniversary-example-title" className="text-sm font-semibold text-ink">
            Example of what a buyer reads
          </h3>
          <p className="mt-2 text-sm text-ink">{`Subject: ${example.subject}`}</p>
          <p className="mt-2 whitespace-pre-line text-sm text-ink-soft">{example.body}</p>
        </div>
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
