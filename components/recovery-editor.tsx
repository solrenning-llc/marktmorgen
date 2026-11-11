"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { MAX_RECOVERY_ADDRESS, parseRecovery, type RecoverySetting } from "@/lib/recovery-setting-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  address: "Add the postal address your reminders carry. US law asks every email about buying something to include one.",
  address_long: `Keep the address under ${MAX_RECOVERY_ADDRESS} characters.`,
  stripe: "Connect your Stripe account first.",
  unavailable: "Email sending is not set up on our side yet, so nothing was changed.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  invalid: "That could not be read. Nothing was changed.",
  changed: "Nothing was changed. These settings were changed in another tab or by someone else after this page loaded. Reload this page to see them before trying again.",
  server_error: "We could not confirm whether your checkout reminder settings were saved. Reload this page to check before trying again.",
};

/** One reminder after an abandoned checkout, to buyers who asked for it or agreed to it. */
export function RecoveryEditor({
  recovery,
  suggestedAddress,
  connected,
}: {
  recovery: RecoverySetting;
  /** The address already given for list email, offered when none is saved here. */
  suggestedAddress: string;
  connected: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(recovery.enabled);
  const [address, setAddress] = useState(recovery.address || suggestedAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // What this page read, compared with what is saved: a change made since in another tab is refused, not overwritten.
        body: JSON.stringify({ enabled, address, expect: { enabled: recovery.enabled, address: recovery.address } }),
      });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const saved = data.recovery && typeof data.recovery === "object" && !Array.isArray(data.recovery) ? data.recovery as Record<string, unknown> : {};
      const expected = parseRecovery({enabled,address});
      if (response.ok && data.ok === true && data.error === undefined && saved.enabled === expected.enabled && saved.address === expected.address && typeof saved.asks === "boolean") {
        toast(enabled ? "Checkout reminders are on." : "Checkout reminders are off.");
        router.refresh();
        return;
      }
      setError(typeof data.error === "string" && Object.hasOwn(MESSAGES,data.error) ? MESSAGES[data.error] : MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="checkout-reminders" className="card mt-8 scroll-mt-32 p-6 sm:p-8" aria-labelledby="recovery-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="recovery-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Abandoned checkout reminder
        </h2>
        <span className={`tag ${recovery.enabled ? "tag-live" : ""}`}>{recovery.enabled ? "On" : "Off"}</span>
      </div>
      <p className="mt-2 text-ink-soft">
        When a buyer leaves your checkout without paying, they can get one email about an hour later with a link back to
        the product. Only a buyer who said yes: by asking for it on the page the way back from the checkout leads to, or,
        on a Stripe account in the United States, by checking Stripe&apos;s box on the checkout itself. Nobody else is
        ever written to.
      </p>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
          <span>One email per checkout, at most one per buyer and product in a week, and none to anyone who has paid for it since.</span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
          <span>It comes from your store&apos;s name, replies reach you, and a stop link works in one press, for good.</span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
          <span>
            A buyer who goes back from the checkout lands on a page of your store that says nothing was charged, links
            back to the product, and offers the reminder. Their address is used for that one email, is not shown to you
            and is not added to your list.
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
          <span>
            Each paid product&apos;s page offers the same under its buy box, for a visitor who is not ready yet: one
            reminder with the link, in about an hour, tomorrow or in three days, as they choose. The same limits, the
            same stop link, and none if they buy first.
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
          <span>
            Stripe shows its own box only on checkouts of US businesses. With a US account, a checkout left open also
            closes after 1 hour instead of Stripe&apos;s usual 24, so that reminder arrives while it still matters.
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
          <span>For calls and live sessions, the time the buyer picked goes back on sale when the checkout closes, so their reminder leads to the times still open, and is sent only while there is one.</span>
        </li>
      </ul>

      {!connected ? (
        <p className="mt-5 text-sm text-ink-soft">Connect your Stripe account first, and this can be switched on.</p>
      ) : (
        <form onSubmit={save} aria-busy={busy} className="mt-5 space-y-4">
          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold text-ink">
            <input
              type="checkbox"
              disabled={busy}
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-violet-brand"
            />
            Send one reminder after an abandoned checkout
          </label>

          <div>
            <label htmlFor="recovery-address" className="field-label">
              Your postal address
            </label>
            <input
              id="recovery-address"
              disabled={busy}
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              maxLength={MAX_RECOVERY_ADDRESS}
              autoComplete="street-address"
              placeholder="Street, city, state and ZIP"
              aria-describedby="recovery-address-hint"
              required={enabled}
              className="field mt-2"
            />
            <p id="recovery-address-hint" className="mt-2 text-xs text-ink-soft">
              Printed at the bottom of every reminder, as US law asks. A PO box or a mailbox service is fine.
            </p>
          </div>

          {error ? (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary">
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      )}
    </section>
  );
}
