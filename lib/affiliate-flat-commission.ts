/**
 * A flat amount per sale as an affiliate commission (608 [WP7], unit 1, 10
 * November 2026): pure rules, no Redis and no PayPal.
 *
 * Today a creator can pay affiliates only a percentage (lib/affiliate-setting.ts,
 * 1 to 90%). Some creators would rather promise "$25 for every sale": it is
 * easier to explain to an affiliate and does not move with discounts. These
 * rules keep the same protections a percentage has:
 * - The same 90% cap per sale, counted together with every partner share and
 *   second tier riding on that sale (MAX_COMMITTED_SHARE, lib/partner-share.ts).
 *   A sale paid at a discount, or a smaller renewal, earns the flat amount
 *   only up to that cap, never above it.
 * - Each payment of a membership earns it again, under that payment's own cap,
 *   as a percentage is credited on each payment.
 * - A refund takes it back as a percentage's is taken back (lib/affiliates.ts,
 *   settleLine): pro rata to the pre-tax base the creator kept, and capped on
 *   that base; a full refund cancels it, and a refund never raises it.
 * - A value that cannot be read is unknown (null), never zero and never the
 *   full amount (rule 24).
 * Where the setting is stored, the studio field, the affiliate's page and the
 * crediting of real sales are later units. Marktmorgen pays nothing: the
 * creator pays affiliates from their own PayPal account.
 */
import { MAX_BONUS_CENTS, MIN_BONUS_CENTS, commissionOn } from "@/lib/affiliate-setting";
import { formatMoney } from "@/lib/money";
import { MAX_COMMITTED_SHARE } from "@/lib/partner-share";

/** In the currency's smallest unit: 1 to 10,000 in it, the same range as a sales bonus. */
export const MIN_FLAT_CENTS = MIN_BONUS_CENTS;
export const MAX_FLAT_CENTS = MAX_BONUS_CENTS;

/** A flat amount as set, or null when it is not one a creator can set. */
export function readFlatCents(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < MIN_FLAT_CENTS || raw > MAX_FLAT_CENTS) return null;
  return raw;
}

/** What every partner and second tier take of the same sale, in percent; null when it cannot be read. */
function readOthers(raw: number): number | null {
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * What one payment earns: the flat amount, cut to the room the 90% cap leaves
 * after `othersPercent`, in whole cents rounded down. `baseCents` is the same
 * base a percentage is taken of (what the buyer paid, before tax). Null when
 * the amount, the base or the others cannot be read.
 */
export function flatCommissionOn(baseCents: number, flatCents: number, othersPercent: number): number | null {
  const flat = readFlatCents(flatCents);
  const others = readOthers(othersPercent);
  // A negative amount paid can only be a bad read: unknown, never nothing (Claude 1 on #3595, rule 24).
  if (flat === null || others === null || !Number.isSafeInteger(baseCents) || baseCents < 0) return null;
  if (baseCents === 0) return 0;
  const room = MAX_COMMITTED_SHARE - others;
  if (room <= 0) return 0;
  return Math.min(flat, commissionOn(baseCents, room));
}

/**
 * What stays earned after a refund, as a percentage's is settled (lib/affiliates.ts, settleLine; Claude 1 on #3595):
 * the pre-tax base kept is `baseCents` scaled by what was not refunded of `totalCents` (what was charged, tax
 * included), rounded as settleLine rounds it; what was earned is kept pro rata to it, rounded down, and never above
 * the cap on that base kept. Nothing after a full refund; never more than was earned. Null when anything cannot
 * be read, a negative base or charge included.
 */
export function flatAfterRefund(earnedCents: number, baseCents: number, totalCents: number, refundedCents: number, othersPercent: number): number | null {
  const others = readOthers(othersPercent);
  if (
    others === null ||
    !Number.isSafeInteger(earnedCents) || earnedCents < 0 ||
    !Number.isSafeInteger(baseCents) || baseCents < 0 ||
    !Number.isSafeInteger(totalCents) || totalCents < 0 ||
    !Number.isSafeInteger(refundedCents) || refundedCents < 0
  ) {
    return null;
  }
  if (totalCents === 0 || baseCents === 0) return 0;
  const back = Math.min(refundedCents, totalCents);
  // In whole numbers, so amounts up to the safe range stay exact: round(base × (total − back) / total), half up.
  const scaled = BigInt(baseCents) * BigInt(totalCents - back);
  const two = BigInt(2);
  const keptBase = Number((two * scaled + BigInt(totalCents)) / (two * BigInt(totalCents)));
  if (keptBase <= 0) return 0;
  const room = MAX_COMMITTED_SHARE - others;
  if (room <= 0) return 0;
  const prorated = Number((BigInt(earnedCents) * BigInt(keptBase)) / BigInt(baseCents));
  return Math.min(prorated, earnedCents, commissionOn(keptBase, room));
}

/** The flat amount as the affiliate reads it, in the store's own currency: "$25", "CA$25", "€25". */
export function flatAmountText(cents: number, currency: string, locale = "en-US"): string {
  return formatMoney(cents, currency, locale);
}

export type FlatProblem = "amount" | "over-cap" | "unknown";

/**
 * For the studio, while the creator sets it: whether the amount can be set at
 * all ("amount"), and whether the 90% cap would cut it on a full-price sale
 * of this product ("over-cap"), so the creator sees it before an affiliate
 * does. "unknown" when the price or the others cannot be read.
 */
export function flatProblem(flatCents: number, priceCents: number, othersPercent: number): FlatProblem | null {
  const flat = readFlatCents(flatCents);
  if (flat === null) return "amount";
  if (readOthers(othersPercent) === null || !Number.isSafeInteger(priceCents) || priceCents < 0) return "unknown";
  const earned = flatCommissionOn(priceCents, flat, othersPercent);
  if (earned === null) return "unknown";
  return earned < flat ? "over-cap" : null;
}
