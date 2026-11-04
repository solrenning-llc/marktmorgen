"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import type { TaxSetting } from "@/lib/tax";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { NewTab } from "@/components/new-tab";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  setup: "Stripe says your tax setup is not finished yet. Finish it in your Stripe dashboard, then switch this on.",
  stripe: "Connect your Stripe account first.",
  series: "A series of calls is still running in your store. Its sessions were booked without sales tax, so you can switch tax on once the last series is over or canceled. Nothing was changed.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "We could not confirm whether your tax settings were saved. Reload this page to check before trying again.",
};

const subscribeToReadiness = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

const STRIPE_TAX_SETTINGS = "https://dashboard.stripe.com/settings/tax";
const STRIPE_EMAIL_SETTINGS = "https://dashboard.stripe.com/settings/emails";

/** Sales tax at checkout, worked out by Stripe Tax on the creator's account. */
export function TaxEditor({
  tax,
  status,
  connected,
}: {
  tax: TaxSetting;
  /** What Stripe said about the creator's tax setup on this page load. */
  status: "active" | "pending" | "unknown";
  connected: boolean;
}) {
  const ready = useSyncExternalStore(subscribeToReadiness, clientReady, serverReady);
  const router = useRouter();
  const [enabled, setEnabled] = useState(tax.enabled);
  const [included, setIncluded] = useState(tax.included);
  const [ids, setIds] = useState(tax.ids);
  const [invoices, setInvoices] = useState(tax.invoices);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const requested = { enabled, included, ids, invoices };
      const response = await fetch("/api/store/tax", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requested),
      });
      const data: unknown = await response.json().catch(() => null);
      const reply: Record<string, unknown> = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
      const saved = reply.tax && typeof reply.tax === "object" && !Array.isArray(reply.tax) ? reply.tax as Record<string, unknown> : null;
      if (response.ok && reply.ok === true && reply.error === undefined && saved && Object.entries(requested).every(([key, value]) => saved[key] === value)) {
        toast("Sales tax settings saved.");
        router.refresh();
        return;
      }
      setError(typeof reply.error === "string" && Object.hasOwn(MESSAGES, reply.error) ? MESSAGES[reply.error] : MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="tax-title">
      <h2 id="tax-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Tax and invoices
      </h2>
      <p id="tax-account-scope" className="mt-2 text-ink-soft">
        Stripe Tax works out sales tax or VAT from each buyer&apos;s address, for the places where you have told Stripe
        you are registered, and adds it at checkout, on your own Stripe account. These controls configure your account; they do not establish who owes tax under platform or marketplace rules. Stripe
        charges for Stripe Tax on your account, at the price on its own pricing page.
      </p>

      <p id="tax-platform-scope" className="mt-3 text-sm text-ink-soft">
        Marktmorgen&apos;s platform VAT collection and records are still being built. Setting up Stripe Tax on your account
        does not complete that work or open sales.
      </p>

      {!connected ? (
        <p className="mt-4 text-sm text-ink-soft">Connect your Stripe account first, and this can be switched on.</p>
      ) : (
        <form onSubmit={save} aria-describedby="tax-account-scope tax-platform-scope" aria-busy={busy} className="mt-5 space-y-4">
          <p className="text-sm">
            {status === "active" ? (
              <span className="font-semibold text-ink">Stripe Tax is set up on your account.</span>
            ) : status === "pending" ? (
              <>
                <span className="font-semibold text-ink">Stripe Tax is not set up on your account yet.</span>{" "}
                <span className="text-ink-soft">
                  In your Stripe dashboard, add your head office address, what you sell, and where you are registered to
                  collect tax. Then come back and switch it on.
                </span>{" "}
                <a href={STRIPE_TAX_SETTINGS} target="_blank" rel="noopener noreferrer" className="link font-semibold">
                  Open tax settings in Stripe
                <NewTab /></a>
              </>
            ) : (
              <span className="text-ink-soft">Stripe could not be asked about your tax setup just now.</span>
            )}
          </p>

          <label className="flex items-start gap-3 text-sm font-semibold text-ink">
            <input
              type="checkbox"
              checked={enabled}
                disabled={!ready || busy}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-violet-brand"
            />
            Add sales tax at checkout
          </label>

          <fieldset className="space-y-2" disabled={!ready || !enabled || busy}>
            <legend className="field-label">Your prices</legend>
            <label className="flex items-start gap-3 text-sm text-ink">
              <input type="radio" name="tax-included" checked={!included} onChange={() => setIncluded(false)} className="mt-0.5 h-4 w-4" />
              <span>Tax is added on top at checkout (usual in the United States)</span>
            </label>
            <label className="flex items-start gap-3 text-sm text-ink">
              <input type="radio" name="tax-included" checked={included} onChange={() => setIncluded(true)} className="mt-0.5 h-4 w-4" />
              <span>My prices already include it (usual in Europe, the UK and Australia)</span>
            </label>
          </fieldset>

          <fieldset className="space-y-3 border-t border-line pt-4" disabled={!ready || busy}>
            <legend className="field-label">Business buyers</legend>
            <label className="flex items-start gap-3 text-sm font-semibold text-ink">
              <input
                type="checkbox"
                checked={ids}
                disabled={!ready || busy}
                onChange={(e) => setIds(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-violet-brand"
              />
              Let a business give its VAT or tax number at checkout
            </label>
            <p className="pl-7 text-xs text-ink-soft">
              Stripe shows the box in the countries where it supports one. The number is saved on the buyer&apos;s record
              in your own Stripe account and printed on their invoice. With sales tax switched on above, Stripe applies
              the reverse charge or the zero rate where the law says so; with it off, the number is recorded and nothing
              else changes. Stripe checks the number&apos;s format. Entering a number does not by itself establish a buyer&apos;s
              tax treatment. A buyer without a number is never stopped.
            </p>
            <label className="flex items-start gap-3 text-sm font-semibold text-ink">
              <input
                type="checkbox"
                checked={invoices}
                disabled={!ready || busy}
                onChange={(e) => setInvoices(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-violet-brand"
              />
              Have Stripe make an invoice for every single payment
            </label>
            <p className="pl-7 text-xs text-ink-soft">
              Stripe draws up the invoice on your account, with you as the seller and tax on its own line. The buyer is
              sent the link to its PDF when &quot;Successful payments&quot; is on under Customer emails in your Stripe
              settings. Stripe charges you for each of these invoices, at the price on its own pricing page. Memberships
              and payment plans are already invoiced by Stripe at every payment, so this covers single payments.{" "}
              <a href={STRIPE_EMAIL_SETTINGS} target="_blank" rel="noopener noreferrer" className="link font-semibold">
                Open Customer emails in Stripe
              <NewTab /></a>
            </p>
          </fieldset>

          {enabled ? (
            <p className="text-xs text-ink-soft">
              While tax is on, the one-click offer after paying is paused: tax cannot be added to a one-click charge. Offers
              at checkout, plans and memberships all get tax.
            </p>
          ) : null}

          {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
          <button type="submit" aria-busy={busy} disabled={!ready || busy} className="btn btn-primary">
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      )}
    </section>
  );
}
