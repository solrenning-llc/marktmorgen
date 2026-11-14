/**
 * A come-back offer to somebody whose membership ended: one email, some days
 * later, with a discount to return.
 *
 * Measured before it was built (30 September 2026): Patreon's Autopilot sends
 * win-back and cancellation offers; Mighty Networks has cancellation
 * follow-up automations; Circle sends reactivation emails from payment
 * activity; Whop messages a member when they leave. Stan, Skool, Kajabi and
 * Gumroad document none. The cancel page here already makes one offer to a
 * member on their way out (lib/save-offer.ts); this is the second chance,
 * after they have gone.
 *
 * What it is, precisely:
 *
 *   - One email per ended membership, the number of days after it ended that
 *     the creator chose, and at most one per person and product in half a
 *     year, however many times they come and go.
 *   - Only to somebody who agreed to hear from the creator and has not left
 *     the creator's list, with the list's own one-click unsubscribe, and the
 *     creator's postal address, which US law asks of every commercial email.
 *   - Never to somebody who has already come back.
 *   - A discount the creator chooses, a percentage off one to three payments,
 *     made as a coupon on the creator's own Stripe account and applied by
 *     Stripe's own checkout. A multi-payment offer is made only on monthly
 *     memberships, where months and payments are the same thing.
 *   - The link works for OFFER_DAYS days, only for the address it was sent to,
 *     and the checkout it opens takes no free trial a second time.
 *
 * Pure, so the studio's form can read the choices without anything that
 * talks to Stripe. The sending is in lib/winback-send.ts.
 */
import type { Store } from "@/lib/store";
import { SAVE_MONTHS, SAVE_PERCENTS, canOffer } from "@/lib/save-offer";

export type WinBack = {
  /** Percent off each payment while it lasts. 0 is off. */
  percent: number;
  /** How many payments it lasts for. */
  months: number;
  /** How many days after a membership ends the email goes. */
  days: number;
  /** The coupon on the creator's own account, made when this was saved. */
  coupon: string;
  /** The creator's postal address, which the email carries. */
  address: string;
};

export const WINBACK_PERCENTS = SAVE_PERCENTS;
export const WINBACK_MONTHS = SAVE_MONTHS;
/**
 * When the email goes. Past three weeks is not offered: the job reads when a
 * membership ended from Stripe's list of events, which keeps thirty days.
 */
export const WINBACK_DAYS = [3, 7, 14, 21] as const;
/** How long the offer in the email stays open. */
export const OFFER_DAYS = 14;
/** At most one come-back email per person and product in this long. */
export const ONCE_PER_DAYS = 180;
export const MAX_WINBACK_ADDRESS = 200;
/**
 * Calls to the creator's Stripe account one opening of a come-back link makes at the most, to read whether the person
 * already has a membership that has not ended (lib/winback-send.ts, openWinBack): the address's customers listed and
 * searched, and up to ten pages of their memberships. Past them the answer is unknown, and nothing is opened.
 */
export const WINBACK_OPEN_STRIPE_CALLS = 12;
/**
 * Public requests of the store's window that reading counts as, taken before it: its worst cost with a tenth to spare
 * (WINBACK_OPEN_READ in tests/plan-cost-registry.ts, held by tests/plan-cost-registry.test.ts).
 */
export const WINBACK_OPEN_REQUEST_UNITS = 9;

export const NO_WINBACK: WinBack = { percent: 0, months: 1, days: 7, coupon: "", address: "" };

const COUPON_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

/** Whatever came back from storage, made safe to use. Anything off-list reads as off. */
export function parseWinBack(raw: unknown): WinBack {
  if (!raw || typeof raw !== "object") return { ...NO_WINBACK };
  const value = raw as Record<string, unknown>;
  const percent = (WINBACK_PERCENTS as readonly number[]).includes(value.percent as number) ? (value.percent as number) : 0;
  const months = (WINBACK_MONTHS as readonly number[]).includes(value.months as number) ? (value.months as number) : 1;
  const days = (WINBACK_DAYS as readonly number[]).includes(value.days as number) ? (value.days as number) : NO_WINBACK.days;
  const coupon = typeof value.coupon === "string" && COUPON_PATTERN.test(value.coupon) ? value.coupon : "";
  const address =
    typeof value.address === "string" ? value.address.replace(/\s+/g, " ").trim().slice(0, MAX_WINBACK_ADDRESS) : "";
  // On only with a coupon to apply and an address to print.
  if (!percent || !coupon || !address) return { ...NO_WINBACK, days, address };
  return { percent, months, days, coupon, address };
}

/** Whether a store sends come-back offers. */
export function winbackOn(store: Pick<Store, "winback">): boolean {
  return store.winback.percent > 0 && store.winback.coupon !== "" && store.winback.address !== "";
}

/** "25% off the next 2 payments". */
export function winbackWords(offer: Pick<WinBack, "percent" | "months">): string {
  return offer.months === 1
    ? `${offer.percent}% off your first payment`
    : `${offer.percent}% off your first ${offer.months} payments`;
}

/** Whether this offer can be made on a membership charged this often, and honoured exactly (lib/save-offer.ts). */
export function canWinBack(offer: Pick<WinBack, "months">, interval: string, intervalCount = 1): boolean {
  return canOffer(offer, interval, intervalCount);
}
