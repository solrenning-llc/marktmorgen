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
import { type Currency, currencyRule, formatMoney } from "@/lib/money";
import type { BookingWords } from "@/lib/buyer-words/booking";

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

/**
 * What is left to pay in person for one paid booking, and the code taken off
 * its whole price, as its sale keeps them (lib/calls.ts, callCheckoutBody:
 * metadata rest, code and code_off; 520 [LB1], units 5a and 5c). Read
 * strictly: anything not as written there is not said, never guessed.
 */
export type DueInPerson = { rest: number; code: string | null; codeOff: number };

const whole = (raw: unknown): number => (typeof raw === "string" && /^[1-9]\d{0,11}$/.test(raw) ? Number(raw) : 0);

export function readDue(meta: Record<string, string | undefined> | null | undefined): DueInPerson | null {
  if (!meta) return null;
  const rest = whole(meta.rest);
  const codeOff = whole(meta.code_off);
  const code = typeof meta.code === "string" && /^[A-Za-z0-9-]{3,24}$/.test(meta.code) && codeOff > 0 ? meta.code : null;
  if (!rest && !code) return null;
  return { rest, code, codeOff: code ? codeOff : 0 };
}

/**
 * The buyer's lines about it, in the store's language: the code and what it
 * took off the whole price, and what is left to pay in person, to whom. The
 * same sentences Stripe's page showed before paying.
 */
export function dueLines(words: BookingWords, due: DueInPerson | null, input: { currency: string; locale: string; storeName: string }): string[] {
  if (!due) return [];
  const money = (cents: number) => formatMoney(cents, input.currency, input.locale);
  return [
    ...(due.code ? [words.codeOffPrice(due.code, money(due.codeOff))] : []),
    ...(due.rest > 0 ? [words.depositRest(money(due.rest), input.storeName)] : []),
  ];
}

/** The creator's line about it, in English as every creator email is. */
export function creatorDueLine(due: DueInPerson | null, input: { paidCents: number | null | undefined; currency: string }): string {
  if (!due) return "";
  const money = (cents: number) => formatMoney(cents, input.currency);
  const code = due.code ? `They used code ${due.code}: ${money(due.codeOff)} off the whole price.` : "";
  const paid = typeof input.paidCents === "number" && input.paidCents > 0 ? `${money(input.paidCents)} was paid now as a deposit. ` : "";
  const rest = due.rest > 0 ? `${paid}The rest, ${money(due.rest)}, is paid to you in person.` : "";
  return [code, rest].filter(Boolean).join(" ");
}
