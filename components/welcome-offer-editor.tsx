"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { MAX_WELCOME_ADDRESS, WELCOME_HOURS, WELCOME_PERCENTS, type WelcomeOffer } from "@/lib/welcome-offer";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  percent: "Pick one of the percentages offered.",
  hours: "Pick how long the offer lasts.",
  product: "Choose a paid product with a single price, on sale in your store.",
  address: "Type the postal address where you can be reached. The law in the United States asks every email like the reminder to carry one.",
  stripe: "Connect your Stripe account first.",
  stripe_refused: "Stripe would not make the discount on your account, so nothing was changed. Try again in a moment.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Something went wrong on our side. Nothing was changed; try again in a moment.",
};

const bullet = (text: string) => (
  <li className="flex gap-2">
    <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
    <span>{text}</span>
  </li>
);

const hoursWords = (h: number) => (h === 168 ? "7 days" : `${h} hours`);

/**
 * The welcome offer with a deadline of each person's own (lib/welcome-offer.ts):
 * a discount on one paid product for whoever asks for a free one, for as
 * long as the creator chooses, counted from the moment they asked. Every line
 * under the heading is something the code does.
 */
export function WelcomeOfferEditor({
  offer,
  products,
  connected,
  suggestedAddress,
  offered,
}: {
  offer: WelcomeOffer;
  /** The store's paid products. */
  products: { id: string; title: string }[];
  connected: boolean;
  suggestedAddress: string;
  /** How many people have been offered it so far, or null when that could not be read just now (said so, never 0). */
  offered: number | null;
}) {
  const router = useRouter();
  const on = offer.percent > 0 && offer.coupon !== "";
  const [product, setProduct] = useState(on ? offer.product : products[0]?.id ?? "");
  const [percent, setPercent] = useState<number>(on ? offer.percent : 20);
  const [hours, setHours] = useState<number>(offer.hours);
  const [remind, setRemind] = useState(on ? offer.remind : true);
  const [address, setAddress] = useState(offer.address || suggestedAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(next: { product: string; percent: number; hours: number; remind: boolean; address: string }) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/welcome-offer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) {
        toast(next.percent ? "Your welcome offer is saved." : "No welcome offer is made now.");
        router.refresh();
        return;
      }
      setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const title = products.find((p) => p.id === product)?.title ?? "your product";

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="welcome-offer-title" data-welcome-offer-editor>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="welcome-offer-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          A welcome offer with a deadline of their own
        </h2>
        <span className={`tag ${on ? "tag-live" : ""}`}>{on ? "On" : "Off"}</span>
      </div>
      <p className="mt-2 text-ink-soft">
        Whoever asks for one of your free products is offered a discount on one paid product, with a countdown that starts
        when they ask. When it ends, it has ended.
      </p>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        {bullet("The time starts when the person asks for the free product and is kept for them: asking again, on another device or a month later, never starts it again.")}
        {bullet("When it ends, the button goes, the page says when it ended, and the product is at its usual price.")}
        {bullet("Stripe takes the discount off the first payment, for the address the free copy went to.")}
        {bullet("With the reminder on, one email goes before the end, only to someone who agreed to hear from you and confirmed their address, with your list's one-click unsubscribe.")}
      </ul>
      {on ? (
        offered === null ? (
          <p className="mt-4 text-sm text-ink-soft" role="status">{"We could not check just now how many people were offered it so far. Reload this page in a moment to check again."}</p>
        ) : (
          <p className="mt-4 text-sm font-semibold text-ink">{`Offered so far: ${offered}.`}</p>
        )
      ) : null}

      {!connected ? (
        <p className="mt-5 text-sm text-ink-soft">Connect your Stripe account first, and this can be switched on.</p>
      ) : !products.length ? (
        <p className="mt-5 text-sm text-ink-soft">Add a paid product first, and it can be offered here.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send({ product, percent, hours, remind, address });
          }}
          className="mt-5 space-y-4"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block" htmlFor="wo-product">
              <span className="field-label">Product offered</span>
              <select id="wo-product" value={product} onChange={(e) => setProduct(e.target.value)} className="field mt-2">
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </label>
            <label className="block" htmlFor="wo-percent">
              <span className="field-label">Discount</span>
              <select id="wo-percent" value={percent} onChange={(e) => setPercent(Number(e.target.value))} className="field mt-2">
                {WELCOME_PERCENTS.map((p) => (
                  <option key={p} value={p}>{`${p}% off`}</option>
                ))}
              </select>
            </label>
            <label className="block" htmlFor="wo-hours">
              <span className="field-label">Lasts</span>
              <select id="wo-hours" value={hours} onChange={(e) => setHours(Number(e.target.value))} className="field mt-2">
                {WELCOME_HOURS.map((h) => (
                  <option key={h} value={h}>{hoursWords(h)}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} className="mt-1" />
            <span>Send one reminder before it ends</span>
          </label>
          {remind ? (
            <label className="block" htmlFor="wo-address">
              <span className="field-label">Your postal address, printed at the bottom of the reminder</span>
              <input
                id="wo-address"
                value={address}
                maxLength={MAX_WELCOME_ADDRESS}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street, city, state and ZIP code, or a PO box"
                className="field mt-2"
                autoComplete="street-address"
              />
            </label>
          ) : null}
          <p className="text-sm text-ink-soft">
            {`Someone who asks for a free product is offered ${percent}% off ${title} for ${hoursWords(hours)} from that moment${remind ? ", with one reminder before the end" : ""}.`}
          </p>
          {error ? (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary">
              {busy ? "Saving…" : on ? "Save" : "Turn on"}
            </button>
            {on ? (
              <button type="button" disabled={busy} className="btn btn-ghost" onClick={() => void send({ product, percent: 0, hours, remind, address })}>
                Turn off
              </button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
