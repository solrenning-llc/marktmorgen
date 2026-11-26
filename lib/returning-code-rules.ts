/**
 * A discount code only for people who already bought from this store
 * (554 [DS1], unit 2; the owner's decision of 2 November 2026, 16h15
 * Fortaleza).
 *
 * Stripe has no rule for "only a buyer who bought here before":
 * `first_time_transaction` is the opposite, and does not hold for a checkout
 * with no customer of its own, which is every checkout here. So such a code
 * is never a promotion code Stripe's own box could take. It is the creator's
 * coupon on their own Stripe account (what it takes off, how many times it
 * can be used and its end date are Stripe's, checked by Stripe), with the
 * word a buyer types kept here, on the store. The buyer types the code and
 * their email on the store's page, before the checkout; the server reads
 * whether that email paid for an order in this store before and, if it did,
 * emails that address a link that works once (lib/returning-code.ts); the
 * page answers the same whether or not it bought here, so it never tells
 * who is a customer. Only that link opens the checkout with the coupon, for
 * that email. Anything that cannot be read is a refusal: an unknown purchase
 * history is never a discount. (Independent review of #3666: a typed email
 * alone proves nothing, so it never applies the coupon by itself.)
 *
 * Pure, so the store record and the page can import it.
 */
import { LINK_CODE_PATTERN } from "@/lib/code-link";
import { type IntroCandidate, activeIntro } from "@/lib/intro-price";
import { type SaleCandidate, type StoreSale, saleOff } from "@/lib/store-sale";

/** What a code takes off, Stripe's coupon as it was made: a percentage, or an amount in one currency. */
export type ReturningOff =
  | { kind: "percent"; percent: number }
  | { kind: "amount"; cents: number; currency: string };

/** One such code, as the store keeps it. */
export type ReturningCode = {
  /** The word a buyer types, upper case, in the shape of every code here. */
  code: string;
  /** The creator's coupon on their own Stripe account. */
  coupon: string;
  off: ReturningOff;
  /** Seconds since the epoch; null for no end. Stripe's coupon ends then too (redeem_by). */
  endsAt: number | null;
  /** Seconds since the epoch. */
  createdAt: number;
};

/** The most a store keeps, the same as the codes Stripe's box can take (lib/discount.ts, MAX_CODES). */
export const MAX_RETURNING_CODES = 20;

/** A Stripe coupon id: letters, digits, dashes and underscores. */
const COUPON_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const seconds = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

function readOff(raw: unknown): ReturningOff | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const off = raw as Record<string, unknown>;
  if (off.kind === "percent" && typeof off.percent === "number" && Number.isFinite(off.percent) && off.percent > 0 && off.percent <= 100) {
    return { kind: "percent", percent: off.percent };
  }
  if (off.kind === "amount" && typeof off.cents === "number" && Number.isSafeInteger(off.cents) && off.cents > 0 && typeof off.currency === "string" && /^[a-z]{3}$/.test(off.currency)) {
    return { kind: "amount", cents: off.cents, currency: off.currency };
  }
  return null;
}

/**
 * The store's codes, read strictly: an entry in any other shape is dropped,
 * so a garbled record can never take money off a checkout. Two entries with
 * the same word keep only the first.
 */
export function parseReturningCodes(raw: unknown): ReturningCode[] {
  if (!Array.isArray(raw)) return [];
  const out: ReturningCode[] = [];
  const words = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_RETURNING_CODES) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const code = typeof row.code === "string" ? row.code : "";
    const coupon = typeof row.coupon === "string" ? row.coupon : "";
    const off = readOff(row.off);
    const createdAt = seconds(row.createdAt);
    const endsAt = row.endsAt === null ? null : seconds(row.endsAt);
    if (!LINK_CODE_PATTERN.test(code) || !COUPON_PATTERN.test(coupon) || !off || createdAt === null) continue;
    if (row.endsAt !== null && endsAt === null) continue;
    if (words.has(code)) continue;
    words.add(code);
    out.push({ code, coupon, off, endsAt, createdAt });
  }
  return out;
}

/** The code a buyer typed, made the shape codes have here, or "" when it is not one. */
export function readTypedCode(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toUpperCase().slice(0, 40);
  return LINK_CODE_PATTERN.test(code) ? code : "";
}

/** The store's code for this word that has not ended, or null. */
export function returningCodeFor(codes: readonly ReturningCode[], typed: string, nowSeconds: number): ReturningCode | null {
  const word = readTypedCode(typed);
  if (!word) return null;
  const found = codes.find((entry) => entry.code === word);
  if (!found) return null;
  return found.endsAt !== null && found.endsAt <= nowSeconds ? null : found;
}

/**
 * What the buy form is told after a code was typed or a link was used:
 *   - "sent": the answer to every code and email that could be checked,
 *     whether or not the email bought here before, so it never says who is
 *     a customer: a link was emailed if it did;
 *   - "code": no such code in this store, or it has ended or is used up;
 *   - "email": the email is not one;
 *   - "link": the confirmation link was used already, ran out, or is not for
 *     this product;
 *   - "other": the code cannot go on this purchase: another discount already
 *     applies, the buyer names the price, or it is a gift, for several
 *     people or a pre-order;
 *   - "unknown": something could not be read, or the store's month of
 *     requests is used: never a discount on a guess;
 *   - "busy": too many tries in a short time.
 */
export type ReturningStatus = "sent" | "code" | "email" | "link" | "other" | "unknown" | "busy";
export type ReturningRefusal = Exclude<ReturningStatus, "sent">;

export const RETURNING_STATUSES: readonly ReturningStatus[] = ["sent", "code", "email", "link", "other", "unknown", "busy"];
export const RETURNING_REFUSALS: readonly ReturningRefusal[] = ["code", "email", "link", "other", "unknown", "busy"];

/** A status carried back to the page in its address, or null for anything else. */
export function readRefusal(raw: string | null | undefined): ReturningStatus | null {
  return RETURNING_STATUSES.find((status) => status === raw) ?? null;
}

/** A confirmation link's token as it arrives in an address: 64 hex characters, or "". */
export function readLinkToken(raw: string | null | undefined): string {
  const token = (raw ?? "").trim();
  return /^[a-f0-9]{64}$/.test(token) ? token : "";
}

/**
 * Whether another discount wins this product's checkout for everyone, as
 * lib/store-checkout.ts decides it: a buyer who names the amount, a
 * membership's introductory price, or a sale across the store that covers it.
 * The checkout then refuses a returning-buyer code ("other"), so it is never
 * offered, asked for or sent while one runs. A fair price depends on the
 * buyer's country and is checked where the country is known (lib/returning-code.ts).
 */
export function otherDiscountForAll(
  store: { sale?: StoreSale; tiers?: readonly string[] },
  product: { pwyw?: unknown } & Partial<Omit<SaleCandidate, "pwyw">> & Partial<Pick<IntroCandidate, "recurring">>,
  nowSeconds: number,
): boolean {
  if (product.pwyw) return true;
  if (typeof product.id !== "string" || typeof product.priceCents !== "number") return false;
  const candidate = product as SaleCandidate & IntroCandidate;
  if (candidate.recurring && activeIntro(candidate, store.tiers ?? [])) return true;
  return Boolean(store.sale) && saleOff(store.sale as StoreSale, candidate, nowSeconds) > 0;
}

/**
 * Whether a product's buy box offers the field: only where the store has a
 * code that has not ended, can sell, and the price is the creator's own (a
 * buyer who names the amount already chooses what they pay), with no other
 * discount winning its checkout (otherDiscountForAll).
 */
export function returningCodeOffered(
  store: { returningCodes: readonly ReturningCode[]; stripeAccountId: string | null; sale?: StoreSale; tiers?: readonly string[] },
  product: { pwyw?: unknown } & Partial<Omit<SaleCandidate, "pwyw">> & Partial<Pick<IntroCandidate, "recurring">>,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!store.stripeAccountId || otherDiscountForAll(store, product, nowSeconds)) return false;
  return store.returningCodes.some((entry) => entry.endsAt === null || entry.endsAt > nowSeconds);
}
