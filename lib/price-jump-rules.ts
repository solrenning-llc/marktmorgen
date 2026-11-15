/**
 * A price typed wrong by the creator (569 [NC1], complement (b) of 2 November
 * 2026): a published product's price saved at PRICE_JUMP_FACTOR times or more,
 * or a PRICE_JUMP_FACTOR-th or less, of its price now is most likely a slip
 * ($1,000 for $10.00, $1 for $100), and buyers would be charged it at once.
 * Such a save is made only when it names the new price exactly
 * (lib/store.ts, editProduct; app/api/store/product/route.ts, confirmPrice);
 * the studio's "Check what buyers pay" says the jump before it sends it
 * (lib/price-review.ts). Pure and browser-safe.
 *
 * Not a jump: a first price (from free), a move to free (nobody is charged),
 * or anything a draft holds (no buyer can pay for it).
 */

/** How many times up or down a price may move without the creator naming the new one. */
export const PRICE_JUMP_FACTOR = 10;

export type PriceJump = { way: "up" | "down"; times: number };

const cents = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** The jump from one price to another, or null when it is not one. Both in the smallest unit of the store's currency. */
export function priceJump(beforeCents: number, afterCents: number): PriceJump | null {
  if (!cents(beforeCents) || !cents(afterCents)) return null;
  if (afterCents >= beforeCents * PRICE_JUMP_FACTOR) return { way: "up", times: Math.floor(afterCents / beforeCents) };
  if (afterCents * PRICE_JUMP_FACTOR <= beforeCents) return { way: "down", times: Math.floor(beforeCents / afterCents) };
  return null;
}

/** The price a save confirms, read exactly: a whole positive number of cents, or null. */
export function confirmedPrice(raw: unknown): number | null {
  const value = typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : raw;
  return typeof value === "number" && cents(value) ? value : null;
}

/** What the creator is told about a jump, with both prices as the store shows them. */
export function priceJumpWords(jump: PriceJump, now: string, then: string): string {
  const how = jump.way === "up"
    ? `${jump.times.toLocaleString("en-US")} times the price now`
    : jump.times === PRICE_JUMP_FACTOR ? "a tenth of the price now" : `a tenth or less of the price now (${jump.times.toLocaleString("en-US")} times less)`;
  return `Check the number: ${then} is ${how}, ${now}. Buyers will pay ${then} as soon as you save.`;
}
