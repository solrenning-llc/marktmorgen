/**
 * A discount code on a booking with a deposit (520 [LB1], unit 5c; the
 * owner's decision of 2 November 2026, 13h53 Fortaleza): the code comes off
 * the whole price of the booking, never off the deposit alone. The deposit
 * charged online stays what the creator set, but is never more than the
 * discounted price; the rest to pay in person is the discounted price less
 * the deposit, and is said on Stripe's page before paying.
 *
 * Stripe's own page can only take a code off what it charges (the deposit),
 * and cannot change the sentence about the rest once a code is typed there.
 * So the buyer types the code on the booking page, it is read here from the
 * creator's own Stripe account, and the checkout is opened with the
 * discounted figures; no code box is shown on Stripe's page (lib/calls.ts).
 *
 * Because Stripe then does not redeem the code itself, nothing here can count
 * its uses or tell a first purchase: a code with a limit on its uses, a
 * first-purchase-only rule, a rule this file does not read, a coupon of its
 * own with a limit or an end date, one limited to some products or to one
 * customer, is refused on a booking with a deposit, and the buyer is told so before
 * paying. Anything that cannot be read is refused too: unknown is never a
 * discount.
 *
 * What it costs: one Stripe request on the creator's account, only when a
 * buyer types a code on a booking with a deposit, inside the booking's own
 * limit of tries per connection (app/api/store/book/route.ts).
 */
import { onAccount } from "@/lib/stripe-account";
import { type Currency, currencyRule } from "@/lib/money";
import { CODES_API_VERSION, codeProblem, readCode } from "@/lib/discount";

/** A code as read for a deposit: only what this file decides on. */
export type DepositCode = {
  id: string;
  code: string;
  active: boolean;
  expiresAt: number | null;
  /** The promotion code's own limit on uses, or the coupon's. */
  limited: boolean;
  firstOrder: boolean;
  /** A minimum the code asks for, in one currency. */
  minimum: { cents: number; currency: string } | null;
  /** A rule this file does not read (a minimum per currency, a minimum in another shape, a coupon limited to products or ending). */
  otherRules: boolean;
  off: { kind: "percent"; percent: number } | { kind: "amount"; cents: number; currency: string; options: Record<string, number> } | null;
};

export type DepositCodeRefusal = "unknown" | "limited" | "small";

export type DepositFigures = {
  /** What the code takes off the whole price. */
  off: number;
  /** The price after the code. */
  discounted: number;
  /** What is charged online: the deposit, never more than the discounted price. */
  charged: number;
  /** What is left to pay in person. */
  rest: number;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Reads one promotion code row, with its coupon expanded, strictly: anything not read as expected is a rule not read. */
export function readDepositCodeRow(row: Record<string, unknown>): DepositCode | null {
  if (typeof row.id !== "string" || !row.id || typeof row.code !== "string" || !row.code) return null;
  const promotion = row.promotion as { coupon?: unknown } | null | undefined;
  const coupon = (promotion?.coupon ?? row.coupon) as Record<string, unknown> | string | null | undefined;
  if (!coupon || typeof coupon === "string") return null;
  const restrictions = (row.restrictions ?? {}) as Record<string, unknown>;
  const minimumCents = restrictions.minimum_amount;
  const minimumCurrency = restrictions.minimum_amount_currency;
  const minimum =
    typeof minimumCents === "number" && Number.isSafeInteger(minimumCents) && minimumCents > 0 && typeof minimumCurrency === "string" && /^[a-z]{3}$/i.test(minimumCurrency)
      ? { cents: minimumCents, currency: minimumCurrency.toLowerCase() }
      : null;
  const currencyOptions = restrictions.currency_options;
  const otherRules =
    (minimumCents !== undefined && minimumCents !== null && minimum === null) ||
    (currencyOptions !== undefined && currencyOptions !== null && !(typeof currencyOptions === "object" && Object.keys(currencyOptions as object).length === 0)) ||
    // Stripe sends applies_to only when asked (readDepositCode expands it): absent is a rule not read, never none.
    !("applies_to" in coupon) ||
    (coupon.applies_to !== null && coupon.applies_to !== undefined) ||
    coupon.valid === false ||
    num(coupon.redeem_by) !== null;
  let off: DepositCode["off"] = null;
  const percent = num(coupon.percent_off);
  const amount = num(coupon.amount_off);
  if (percent !== null && percent > 0 && percent <= 100) off = { kind: "percent", percent };
  else if (amount !== null && Number.isSafeInteger(amount) && amount > 0 && typeof coupon.currency === "string" && /^[a-z]{3}$/i.test(coupon.currency)) {
    const options: Record<string, number> = {};
    const raw = coupon.currency_options;
    if (raw && typeof raw === "object") {
      for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
        const cents = num((value as { amount_off?: unknown } | null)?.amount_off);
        if (cents !== null && Number.isSafeInteger(cents) && cents > 0) options[code.toLowerCase()] = cents;
      }
    }
    off = { kind: "amount", cents: amount, currency: coupon.currency.toLowerCase(), options };
  }
  return {
    id: row.id,
    code: row.code,
    active: row.active === true,
    expiresAt: num(row.expires_at),
    // A limit on uses, its own or its coupon's, or a code for one customer only: nothing here could hold it.
    limited:
      num(row.max_redemptions) !== null ||
      num(coupon.max_redemptions) !== null ||
      (row.customer !== undefined && row.customer !== null) ||
      (row.customer_account !== undefined && row.customer_account !== null),
    firstOrder: restrictions.first_time_transaction === true,
    minimum,
    otherRules,
    off,
  };
}

/**
 * The figures of a booking with a deposit and a code, or why the code is
 * refused. The deposit is the one the creator set, already checked against
 * the whole price (lib/call-deposit.ts, chargeNow); this only applies the
 * code to the whole price and caps the deposit at what is left.
 */
export function depositWithCode(
  code: DepositCode,
  input: { priceCents: number; deposit: number; currency: Currency; nowSeconds: number },
): { ok: true; figures: DepositFigures } | { ok: false; why: DepositCodeRefusal } {
  if (!code.active || (code.expiresAt !== null && code.expiresAt <= input.nowSeconds)) return { ok: false, why: "unknown" };
  // Only Stripe could count these, and it does not redeem a code used here.
  if (code.limited || code.firstOrder || code.otherRules) return { ok: false, why: "limited" };
  if (!code.off) return { ok: false, why: "unknown" };
  if (code.minimum) {
    if (code.minimum.currency !== input.currency) return { ok: false, why: "unknown" };
    if (input.priceCents < code.minimum.cents) return { ok: false, why: "unknown" };
  }
  let off: number;
  if (code.off.kind === "percent") off = Math.round((input.priceCents * code.off.percent) / 100);
  else {
    const cents = code.off.currency === input.currency ? code.off.cents : code.off.options[input.currency];
    if (typeof cents !== "number") return { ok: false, why: "unknown" };
    off = cents;
  }
  const discounted = Math.max(0, input.priceCents - off);
  const charged = Math.min(input.deposit, discounted);
  // Stripe cannot charge less than its smallest amount: a code that leaves less than that online is not used here.
  if (charged < currencyRule(input.currency).minCharge) return { ok: false, why: "small" };
  return { ok: true, figures: { off: input.priceCents - discounted, discounted, charged, rest: discounted - charged } };
}

/**
 * Reads the code a buyer typed from the creator's own Stripe account: only
 * an active one with exactly that code. Null when there is none, when it
 * cannot be read, or when what was typed is not a code.
 */
export async function readDepositCode(account: string, typed: string): Promise<DepositCode | null> {
  const code = readCode(typed);
  if (!code || codeProblem(code)) return null;
  try {
    const page = await onAccount("GET", account, `/promotion_codes?limit=2&active=true&code=${encodeURIComponent(code)}&expand[]=data.promotion.coupon.applies_to&expand[]=data.promotion.coupon.currency_options`, undefined, CODES_API_VERSION);
    if (!Array.isArray(page.data) || page.data.length !== 1) return null;
    const row = page.data[0] as Record<string, unknown>;
    if (typeof row.code !== "string" || row.code.toUpperCase() !== code.toUpperCase()) return null;
    return readDepositCodeRow(row);
  } catch (error) {
    console.error("reading a code for a deposit failed", error);
    return null;
  }
}
