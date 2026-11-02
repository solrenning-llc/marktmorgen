/**
 * A deposit on an in-person booking (520 [LB1], unit 5a; added 2 November
 * 2026): the buyer pays part of the price on the site to hold the time, and
 * the rest in person, to the creator, at the address (lib/call-place.ts).
 * The rest never passes through Marktmorgen or the creator's Stripe account
 * here: only the deposit is charged.
 *
 *   - Only for a booking in person: a call has nowhere to pay the rest.
 *   - At least the smallest amount Stripe charges in the store's currency
 *     (lib/money.ts, minCharge), and less than the price: a deposit of the
 *     whole price is the whole price, not a deposit.
 *   - Kept on the setup in the store's currency's smallest unit. Read against
 *     the product's price at the moment of paying: if the price has changed
 *     so that the deposit is no longer less than it, or the booking is no
 *     longer in person, the whole price is charged, never more than the
 *     price and never a deposit nobody was told about.
 *   - Not for a session from a package: the package was already paid.
 *
 * Pure and browser-safe: the studio shows the same answer the checkout acts on.
 */
import { type Currency, currencyRule } from "@/lib/money";

export type DepositProblem = "shape" | "small" | "whole" | "online";

/**
 * Reads the deposit a creator typed, in the currency's smallest unit, against
 * the product's price. Absent, null or zero is no deposit.
 */
export function parseDeposit(raw: unknown, input: { priceCents: number; currency: Currency; inPerson: boolean }): { ok: true; cents: number | null } | { ok: false; why: DepositProblem } {
  if (raw === undefined || raw === null || raw === 0) return { ok: true, cents: null };
  // A number only, as the setup keeps it (lib/call-setup.ts reads the same shape): never a string read two ways.
  const cents = typeof raw === "number" ? raw : NaN;
  if (!Number.isSafeInteger(cents) || cents < 0) return { ok: false, why: "shape" };
  if (!input.inPerson) return { ok: false, why: "online" };
  if (cents < currencyRule(input.currency).minCharge) return { ok: false, why: "small" };
  if (cents >= input.priceCents) return { ok: false, why: "whole" };
  return { ok: true, cents };
}

/**
 * What the buyer pays on the site for one booking, and what is left to pay in
 * person: the deposit only while it is still a deposit of this price on an
 * in-person booking; otherwise the whole price, with nothing left.
 */
export function chargeNow(input: { priceCents: number; currency: Currency; deposit?: number | null; inPerson: boolean }): { cents: number; rest: number } {
  const read = parseDeposit(input.deposit ?? null, input);
  if (read.ok && read.cents !== null) return { cents: read.cents, rest: input.priceCents - read.cents };
  return { cents: input.priceCents, rest: 0 };
}
