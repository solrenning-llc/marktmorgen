"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import {
  MAX_WINBACK_ADDRESS,
  OFFER_DAYS,
  WINBACK_DAYS,
  WINBACK_MONTHS,
  WINBACK_PERCENTS,
  type WinBack,
  winbackWords,
} from "@/lib/winback";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  percent: "Pick one of the percentages offered.",
  months: "Pick one, two or three payments.",
  days: "Pick when the email goes.",
  address: "Type the postal address where you can be reached. The law in the United States asks every email like this to carry one.",
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

/**
 * The come-back offer (lib/winback.ts): one email, some days after a
 * membership ends, with a discount to return. Every line under the heading is
 * something the code does.
 */
export function WinBackEditor({
  winback,
  connected,
  suggestedAddress,
  sent,
}: {
  winback: WinBack;
  connected: boolean;
  suggestedAddress: string;
  /** How many have been sent so far; null when it could not be counted just now. */
  sent: number | null;
}) {
  const router = useRouter();
  const on = winback.percent > 0 && winback.coupon !== "";
  const [percent, setPercent] = useState<number>(on ? winback.percent : 25);
  const [months, setMonths] = useState<number>(on ? winback.months : 1);
  const [days, setDays] = useState<number>(winback.days);
  const [address, setAddress] = useState(winback.address || suggestedAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(next: { percent: number; months: number; days: number; address: string }) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/come-back", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) {
        toast(next.percent ? "Your come-back offer is saved." : "No come-back emails are sent now.");
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

  return (
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="winback-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="winback-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          A come-back offer after a membership ends
        </h2>
        <span className={`tag ${on ? "tag-live" : ""}`}>{on ? "On" : "Off"}</span>
      </div>
      <p className="mt-2 text-ink-soft">
        Some days after a membership ends, one email offers a discount to come back. The link opens your checkout with the
        discount already applied by Stripe.
      </p>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        {bullet("Only to somebody who agreed to hear from you and has not left your list, with your list's one-click unsubscribe. Never to somebody who already came back.")}
        {bullet("One email per ended membership, and at most one per person and product in six months.")}
        {bullet(`The link works for ${OFFER_DAYS} days, only for the address it was sent to, with no second free trial.`)}
        {bullet("An offer of more than one payment is sent only for memberships charged every month. Payment plans, and memberships sold to end after a set number of payments, get none.")}
      </ul>
      {on ? <p className="mt-4 text-sm font-semibold text-ink">{sent === null ? "How many were sent could not be counted just now. Reload the page in a minute to see it." : `Sent so far: ${sent}.`}</p> : null}

      {!connected ? (
        <p className="mt-5 text-sm text-ink-soft">Connect your Stripe account first, and this can be switched on.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send({ percent, months, days, address });
          }}
          className="mt-5 space-y-4"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block" htmlFor="wb-percent">
              <span className="field-label">Discount</span>
              <select id="wb-percent" value={percent} onChange={(e) => setPercent(Number(e.target.value))} className="field mt-2">
                {WINBACK_PERCENTS.map((p) => (
                  <option key={p} value={p}>{`${p}% off`}</option>
                ))}
              </select>
            </label>
            <label className="block" htmlFor="wb-months">
              <span className="field-label">For</span>
              <select id="wb-months" value={months} onChange={(e) => setMonths(Number(e.target.value))} className="field mt-2">
                {WINBACK_MONTHS.map((m) => (
                  <option key={m} value={m}>{m === 1 ? "The first payment" : `The first ${m} payments`}</option>
                ))}
              </select>
            </label>
            <label className="block" htmlFor="wb-days">
              <span className="field-label">Sent</span>
              <select id="wb-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="field mt-2">
                {WINBACK_DAYS.map((d) => (
                  <option key={d} value={d}>{`${d} days after it ends`}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block" htmlFor="wb-address">
            <span className="field-label">Your postal address, printed at the bottom</span>
            <input
              id="wb-address"
              value={address}
              maxLength={MAX_WINBACK_ADDRESS}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Street, city, state and ZIP code, or a PO box"
              className="field mt-2"
              autoComplete="street-address"
            />
          </label>
          <p className="text-sm text-ink-soft">
            {`${months === 1 ? "A former member" : "A former member of a monthly membership"} is offered ${winbackWords({ percent, months })}, ${days} days after their membership ends.`}
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
              <button type="button" disabled={busy} className="btn btn-ghost" onClick={() => void send({ percent: 0, months: 1, days, address })}>
                Turn off
              </button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
