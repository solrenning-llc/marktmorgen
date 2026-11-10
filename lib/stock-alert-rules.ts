/**
 * Limited products that run out (623 [SZ7], unit 1, 10 November 2026): the
 * rules, with no Redis and no email.
 *
 * (a) Back in stock. A sold-out limited product offers "Email me when it's
 *     back"; when the creator adds units, each confirmed address gets one
 *     email and the list is deleted (the waitlist's pattern, lib/waitlist.ts).
 *     A sale that would have been lost comes back to the creator.
 * (b) Low stock. The creator picks a number of units and is told once each
 *     time the count falls to it, so they can restock before selling out.
 * (c) Per buyer. An optional limit of units one paying address can buy of a
 *     limited product, for fair launches; a purchase above it is refused
 *     before the checkout opens.
 *
 * No invented "only 3 left": the page already shows the real number
 * (lib/stock.ts). A count that cannot be read never sends, never alerts and
 * never lets a purchase past a limit (rule 24). Storing the signups and the
 * settings, sending the emails (each taken from the store's monthly emails
 * before it goes) and checking the limit in the checkout are later units.
 */
import { MAX_STOCK } from "@/lib/product-extras";
import { MAX_WAITLIST } from "@/lib/waitlist-rules";

/** The most addresses one product's back-in-stock list holds: the waitlist's ceiling. */
export const MAX_STOCK_ALERTS = MAX_WAITLIST;
/** The highest low-stock number: as many units as a product can hold. */
export const MAX_LOW_STOCK = MAX_STOCK;
/** The highest per-buyer limit. */
export const MAX_PER_BUYER = 100;

type Answer = "yes" | "no" | "unknown";

/** A count of units or people: a whole number, zero or more. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Units left as lib/stock.ts gives them: a count, or null for a product that is not limited. */
function isLeft(value: unknown): value is number | null {
  return value === null || isCount(value);
}

/** An optional whole number from 1 to `max`: 0 when left empty or 0 (off), null when it is anything else. */
function optional(raw: unknown, max: number): number | null {
  if (raw === "" || raw === 0 || raw === "0") return 0;
  const n = typeof raw === "string" && raw.trim() ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/** Whether the back-in-stock box is offered: only on a sold-out limited product, while its list has room. */
export function stockAlertSignup(left: unknown, signups: unknown): "open" | "full" | "in-stock" | "not-limited" | "unknown" {
  if (!isLeft(left) || !isCount(signups)) return "unknown";
  if (left === null) return "not-limited";
  if (left > 0) return "in-stock";
  return signups < MAX_STOCK_ALERTS ? "open" : "full";
}

/** Whether a change of units left is a sold-out product coming back (or no longer limited). */
export function restocked(before: unknown, after: unknown): Answer {
  if (!isLeft(before) || !isLeft(after)) return "unknown";
  if (before !== 0) return "no";
  return after === null || after > 0 ? "yes" : "no";
}

/** The creator's low-stock number: 0 is off. */
export function readLowStock(raw: unknown): number | null {
  return optional(raw, MAX_LOW_STOCK);
}

/** Whether this change of units left crosses the low-stock number going down: told once per crossing. */
export function crossedLow(before: unknown, after: unknown, low: unknown): Answer {
  if (!isLeft(before) || !isLeft(after) || !isCount(low)) return "unknown";
  if (low === 0 || before === null || after === null) return "no";
  return before > low && after <= low ? "yes" : "no";
}

/** The per-buyer limit: 0 is off. */
export function readPerBuyer(raw: unknown): number | null {
  return optional(raw, MAX_PER_BUYER);
}

/**
 * Whether one paying address may buy `quantity` more units, having bought
 * `alreadyBought` before. Unreadable refuses: "unknown" opens no checkout.
 */
export function perBuyerAllows(limit: unknown, alreadyBought: unknown, quantity: unknown): "ok" | "over" | "unknown" {
  if (!isCount(limit) || limit > MAX_PER_BUYER) return "unknown";
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) return "unknown";
  if (limit === 0) return "ok";
  if (!isCount(alreadyBought)) return "unknown";
  return alreadyBought + quantity <= limit ? "ok" : "over";
}
