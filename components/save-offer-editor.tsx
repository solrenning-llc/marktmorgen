"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { SAVE_MONTHS, SAVE_PERCENTS, type SaveOffer, saveWords } from "@/lib/save-offer";
import { STUDIO_MESSAGES, SESSION_ENDED } from "@/lib/studio-messages";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  percent: "Pick one of the percentages offered.",
  months: "Pick one, two or three payments.",
  stripe: "Connect your Stripe account first.",
  stripe_refused: "Stripe would not make the discount on your account, so nothing was changed. Try again in a moment.",
  none: "This account has no store yet.",
  signed_out: SESSION_ENDED,
  server_error: "Something went wrong on our side. Nothing was changed; try again in a moment.",
};

/**
 * The offer made once to a member who presses Cancel.
 *
 * Every line under the heading is something the code actually does, and
 * nothing more: the offer is Stripe's own page, it is made once per membership,
 * declining is one press, and on memberships not charged monthly only a
 * one-payment offer can be honoured, so only that one is made there.
 */
export function SaveOfferEditor({ save, connected }: { save: SaveOffer; connected: boolean }) {
  const router = useRouter();
  const on = save.percent > 0;
  const [percent, setPercent] = useState<number>(on ? save.percent : 25);
  const [months, setMonths] = useState<number>(on ? save.months : 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(next: { percent: number; months: number }) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/save-offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) {
        toast(next.percent ? "Your offer is saved." : "No offer is made now.");
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
    <section className="card mt-8 p-6 sm:p-8" aria-labelledby="save-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="save-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          An offer when a member cancels
        </h2>
        <span className={`tag ${on ? "tag-live" : ""}`}>{on ? "On" : "Off"}</span>
      </div>
      <p className="mt-2 text-ink-soft">
        When a member presses Cancel, Stripe&apos;s own cancellation page offers them a discount to stay. They take it
        with one press, or decline it with one press and cancel as they meant to.
      </p>
      <ul className="mt-4 space-y-2 text-sm text-ink-soft">
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
          <span>
            Made once per membership, ever. A member who meets a discount every time they reach for Cancel learns to
            reach for it every month.
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
          <span>
            Never in the way. Declining is one press, and the page where a member changes their card still has its own
            Cancel.
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
          <span>
            An offer of more than one payment is made only on memberships charged every month. On weekly, yearly and
            other memberships, a longer discount would not match what the member was told, so none is made there.
          </span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
          <span>The discount is made on your own Stripe account, where you can see it, and applies to that member only.</span>
        </li>
      </ul>

      {!connected ? (
        <p className="mt-5 text-sm text-ink-soft">Connect your Stripe account first, and this can be switched on.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send({ percent, months });
          }}
          className="mt-5 space-y-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block" htmlFor="save-percent">
              <span className="field-label">Discount</span>
              <select
                id="save-percent"
                value={percent}
                onChange={(e) => setPercent(Number(e.target.value))}
                className="field mt-2"
              >
                {SAVE_PERCENTS.map((p) => (
                  <option key={p} value={p}>{`${p}% off`}</option>
                ))}
              </select>
            </label>
            <label className="block" htmlFor="save-months">
              <span className="field-label">For</span>
              <select
                id="save-months"
                value={months}
                onChange={(e) => setMonths(Number(e.target.value))}
                className="field mt-2"
              >
                {SAVE_MONTHS.map((m) => (
                  <option key={m} value={m}>{m === 1 ? "The next payment" : `The next ${m} payments`}</option>
                ))}
              </select>
            </label>
          </div>
          {/* Exact about who: an offer of several payments reaches only the
              members of monthly memberships (lib/save-offer.ts canOffer), so
              the line says so rather than promising it to everybody. */}
          <p className="text-sm text-ink-soft">
            {months === 1
              ? `A member who presses Cancel is offered ${saveWords({ percent, months })}.`
              : `A member of a monthly membership who presses Cancel is offered ${saveWords({ percent, months })}.`}
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
              <button type="button" disabled={busy} className="btn btn-ghost" onClick={() => void send({ percent: 0, months: 1 })}>
                Turn off
              </button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
