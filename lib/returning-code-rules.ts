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
 * word a buyer types kept here, on the store. The buyer types the code on
 * the store's page, before the checkout, with the link we emailed to their
 * library as the proof of their email (never a typed address: review of
 * #3666); the server reads what that proved email bought in this store
 * (lib/next-offer.ts, ownedHere) and opens the checkout with the coupon,
 * for that email only, or refuses the
 * code with a plain sentence. Anything that cannot be read is a refusal:
 * an unknown purchase history is never a discount.
 *
 * The proved email is not kept again by Marktmorgen: it is read once, from
 * the library link, in the request, and is the address the checkout opens
 * with on Stripe's page, where the buyer would have typed it anyway.
 *
 * Pure, so the store record and the page can import it.
 */
import { LINK_CODE_PATTERN } from "@/lib/code-link";

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
 * Why a code is not taken:
 *   - "code": no such code in this store, or it has ended;
 *   - "proof": no library link with it, or one we did not send or that has
 *     ended: the same answer whatever email anyone typed, so it never says
 *     whether someone bought here;
 *   - "bought": the proved email has no earlier purchase in this store (said
 *     only to whoever opened that email's own link);
 *   - "unknown": what the email bought could not be read in full, or the
 *     store's month of requests is used: never taken on a guess;
 *   - "busy": too many tries from this connection in a short time.
 */
export type ReturningRefusal = "code" | "proof" | "bought" | "unknown" | "busy";

export const RETURNING_REFUSALS: readonly ReturningRefusal[] = ["code", "proof", "bought", "unknown", "busy"];

/** A refusal carried back to the page in its address, or null for anything else. */
export function readRefusal(raw: string | null | undefined): ReturningRefusal | null {
  return RETURNING_REFUSALS.find((reason) => reason === raw) ?? null;
}

/**
 * The decision, once the code and what the email owns are known. `owned` is
 * every product the email has from this store, or null when that could not
 * be read in full: null is "unknown", never "bought nothing".
 */
export function returningDecision(code: ReturningCode | null, owned: ReadonlySet<string> | null): { ok: true; code: ReturningCode } | { ok: false; reason: ReturningRefusal } {
  if (!code) return { ok: false, reason: "code" };
  if (owned === null) return { ok: false, reason: "unknown" };
  if (owned.size === 0) return { ok: false, reason: "bought" };
  return { ok: true, code };
}

/**
 * Whether a product's buy box offers the field: only where the store has a
 * code that has not ended, can sell, and the price is the creator's own (a
 * buyer who names the amount already chooses what they pay).
 */
export function returningCodeOffered(
  store: { returningCodes: readonly ReturningCode[]; stripeAccountId: string | null },
  product: { pwyw?: unknown },
  nowSeconds: number,
): boolean {
  if (!store.stripeAccountId || product.pwyw) return false;
  return store.returningCodes.some((entry) => entry.endsAt === null || entry.endsAt > nowSeconds);
}
