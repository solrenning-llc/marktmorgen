/**
 * Pay what you want: the buyer chooses the price, above a floor the creator
 * sets.
 *
 * The creator's price becomes the minimum, and they add the amount they
 * suggest, which Stripe's checkout shows first in the box the buyer types
 * into. Nothing about the amount is ever read from our own form: Stripe's
 * page takes it, and Stripe refuses anything under the minimum or over the
 * ceiling, so a buyer cannot pay a cent for a $10 floor by editing a page.
 *
 * Stripe only lets a buyer choose the amount of a Price that exists on the
 * account — it cannot be described inline the way every other price here is
 * — so the first checkout creates one on the creator's own account and the
 * id is kept, keyed by everything that shapes it. Changing the title, the
 * floor, the suggestion or the tax setting simply leads to a new one.
 *
 * What it cannot be combined with, and why, is decided here once and read by
 * the studio, the server and the store page alike:
 *
 *   a membership       Stripe lets a buyer choose the amount of a one-off
 *                      payment only, never of a subscription;
 *   price options      the buyer would be choosing twice;
 *   a payment plan     instalments of an amount nobody has chosen yet;
 *   an order bump      the chosen amount has to be the checkout's only line;
 *   a paid call        a call is booked for a time at a set price;
 *   discount codes     not offered: the buyer already names the price.
 *
 * A one-click offer after paying, a limited quantity, sales tax, a course and
 * the questions at checkout all work with it unchanged.
 */
import type { Listing, Store } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { onAccount } from "@/lib/stripe-account";
import { type Currency, currencyRule } from "@/lib/money";

export type PayWhatYouWant = {
  /** What the buyer's box starts at on Stripe's page, in the currency's smallest unit. */
  suggestedCents: number;
};

/**
 * The ceiling a buyer can type: the same ceiling every other price in the
 * store's currency has ($5,000 for a store in dollars, lib/money.ts).
 */
export function pwywMaximum(currency: Currency): number {
  return currencyRule(currency).maxPrice;
}

/**
 * Whatever came back from storage, made safe to use. The bounds here are the
 * widest any currency allows; the store's own are checked when it is saved.
 */
export function parsePwyw(raw: unknown): PayWhatYouWant | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>).suggestedCents;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 100 || value > 10_000_000) return null;
  return { suggestedCents: value };
}

export type PwywProblem = "free" | "recurring" | "options" | "call" | "plan" | "bump" | "suggested";

/**
 * Why this product cannot be sold at a price the buyer chooses, or null when
 * it can. `suggestedCents` is checked against the product's own price, which
 * is the floor, and the ceiling of the store's currency.
 */
export function pwywProblem(product: Listing, suggestedCents: number, currency: Currency): PwywProblem | null {
  if (product.priceCents === 0) return "free";
  if (product.recurring) return "recurring";
  if (product.options.length > 0) return "options";
  if (product.call) return "call";
  if (product.plan) return "plan";
  if (product.bumps.length) return "bump";
  if (suggestedCents < product.priceCents || suggestedCents > pwywMaximum(currency)) return "suggested";
  return null;
}

/** The choose-your-price setting a buyer meets on this product, or null. */
export function activePwyw(product: Listing): PayWhatYouWant | null {
  const pwyw = product.pwyw;
  if (!pwyw) return null;
  if (product.priceCents === 0 || product.recurring || product.call || product.options.length > 0) return null;
  // A suggestion under the floor would be refused by Stripe; the floor wins.
  return { suggestedCents: Math.max(pwyw.suggestedCents, product.priceCents) };
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Only a Price Stripe answered as the one written is kept (isPwywPrice), under the `:checked` ending; an id kept
 * before that check, under the key without it, was never read against the Price written and is never read again.
 */
const priceKey = (account: string, print: string) => `nl:pwyw:${account}:${print}:checked`;

/** What a choose-your-price Price was written as: what Stripe's reply must say back (isPwywPrice). */
type WrittenPwyw = { currency: string; minimum: number; preset: number; maximum: number; tax: string; product: string };

/**
 * Whether Stripe's reply to POST /prices is the choose-your-price Price just written (rule 30, as ensurePrice in
 * lib/billing.ts): a price id, active, the currency sent, the buyer's box with the floor, the suggestion and the ceiling
 * sent, no set amount, paid once and never again, the tax treatment when one was sent, and the product it is for. Any other
 * reply is never used for a checkout, nor kept for the next: the checkout that asked fails, and the next asks again,
 * under a new Idempotency-Key (refusedKey), since Stripe answers the same key with the same reply for a day.
 */
function isPwywPrice(reply: Record<string, unknown>, written: WrittenPwyw): reply is Record<string, unknown> & { id: string } {
  const box = reply.custom_unit_amount as { minimum?: unknown; preset?: unknown; maximum?: unknown } | null | undefined;
  const metadata = reply.metadata as { product?: unknown } | null | undefined;
  return typeof reply.id === "string" && /^price_[A-Za-z0-9]{6,64}$/.test(reply.id) && reply.active === true && reply.currency === written.currency &&
    !!box && typeof box === "object" && box.minimum === written.minimum && box.preset === written.preset && box.maximum === written.maximum &&
    reply.unit_amount === null && reply.recurring === null &&
    (!written.tax || reply.tax_behavior === written.tax) &&
    !!metadata && typeof metadata === "object" && metadata.product === written.product;
}

/** A year: long enough that a steady seller never waits for Stripe twice. */
const KEEP_SECONDS = 365 * 24 * 60 * 60;

/**
 * How many replies to this Price were refused (isPwywPrice) in the last day, under the same family as the Price it
 * stands for: it is the Idempotency-Key's ending. Stripe keeps its reply to a key for 24 hours and answers it again to
 * the same key, so after a refusal the next checkout asks under a new key, or the refused reply would come back to
 * every buyer of the product for a day; checkouts asking at the same moment read the same count, so they still share
 * one key and make one Price. Each refusal adds one with INCR, its expiry set in the same request, so a refusal that
 * lands late never lowers it and the count never goes back to a key already answered wrong. It is never deleted, not
 * even after a Price is kept (a checkout that then went back to the first key would be answered the refused reply
 * again): it runs out by itself a day and an hour after the last refusal, past Stripe's 24 hours.
 *
 * Every new key may make a Price on the creator's account, so a Stripe that keeps answering wrong is asked under at
 * most REFUSED_MOST new keys a day for a shape: past REFUSED_MOST refusals, a checkout fails at once, without asking
 * Stripe, until the count runs out (PwywPriceHeld; the buyer is told plainly, nothing is charged). The retry after
 * Stripe refused a kept Price at checkout (archivedKey) asks under a new key too, so it goes up the same count. At most
 * REFUSED_MOST + 1 Prices a day for a shape, then, the first key's and one for each new key.
 *
 * Without Redis, the count is this server's own: kept for the same 25 hours, and for at most REFUSED_HERE_MOST
 * shapes, the oldest dropped first.
 */
const refusedKey = (account: string, print: string) => `nl:pwyw:${account}:${print}:refused`;
const REFUSED_SECONDS = 25 * 60 * 60;
export const REFUSED_MOST = 3;
const REFUSED_HERE_MOST = 1_000;
type HeldHere = Map<string, { count: number; until: number }>;
const refusedHere: HeldHere = new Map();
const archivedHere: HeldHere = new Map();
function hereNow(here: HeldHere, name: string, now: number) {
  const held = here.get(name);
  if (held && held.until > now) return held.count;
  if (held) here.delete(name);
  return 0;
}
/** Kept REFUSED_SECONDS, for at most REFUSED_HERE_MOST names, the oldest dropped first. */
function herePut(here: HeldHere, name: string, count: number, now: number) {
  here.delete(name);
  if (here.size >= REFUSED_HERE_MOST) {
    for (const [other, held] of here) if (held.until <= now) here.delete(other);
    for (const other of here.keys()) {
      if (here.size < REFUSED_HERE_MOST) break;
      here.delete(other);
    }
  }
  here.set(name, { count, until: now + REFUSED_SECONDS * 1000 });
}
const refusedHereNow = (refused: string, now: number) => hereNow(refusedHere, refused, now);
const refusedHereAdd = (refused: string, now: number) => herePut(refusedHere, refused, refusedHereNow(refused, now) + 1, now);

/**
 * The retry after Stripe refused a kept Price at checkout (the creator archived it in their dashboard), marked by the
 * refused Price's id: it holds the count of refusals the retry asks under, one more than the count it found. The first
 * retry to set it (SET NX) adds that one to the count of refusals, so the new key is counted and held to REFUSED_MOST
 * as any other; every retry for the same refused Price, at the same moment or a little later, reads it and asks
 * under the same key, so they make one Price between them. Never a key of the clock. A retry answered wrong takes
 * the mark away, so the next retry is counted and asks under a new key; otherwise it runs out with the count.
 */
const archivedKey = (account: string, print: string, archived: string) => `nl:pwyw:${account}:${print}:archived:${archived}`;
const PRICE_ID = /^price_[A-Za-z0-9]{6,64}$/;

/**
 * This product's Price had to be made again more than REFUSED_MOST times in a day (Stripe answered wrong, or the
 * creator archived it in their dashboard and each checkout after made another): the checkout fails before asking
 * Stripe, until the count runs out, at most REFUSED_SECONDS later. `product` is the product's title, for the
 * creator's notice (lib/checkout-trouble.ts); nothing about the buyer.
 */
export class PwywPriceHeld extends Error {
  readonly product: string;
  constructor(product: string) {
    super("This choose-your-price Price was made again too many times today; not asked again until the count runs out");
    this.name = "PwywPriceHeld";
    this.product = product;
  }
}
/** How long, at most, a product stays held from any moment it is held: the count's own expiry, set at each refusal. */
export const HELD_MOST_HOURS = REFUSED_SECONDS / 3600;
const refusedCount = (value: unknown) => (typeof value === "string" && /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);

/**
 * The id of the Price on the creator's account that lets a buyer choose the
 * amount of this product, made the first time it is needed.
 *
 * `archived` skips the kept id, for the one retry after Stripe says the kept
 * Price can no longer be used (the creator archived it in their dashboard):
 * it is the id Stripe refused, and the retry is counted with the refusals
 * (archivedKey).
 */
export async function pwywPriceId(
  store: Store,
  product: Listing,
  pwyw: PayWhatYouWant,
  archived?: string,
): Promise<string> {
  const account = store.stripeAccountId;
  if (!account) throw new Error("This store has no account");
  const fresh = archived !== undefined;
  if (fresh && !PRICE_ID.test(archived)) throw new Error("The Price refused at checkout is not a price id");
  // The currency is part of what shapes the Price: a store that changes it
  // is given a new one rather than a Price in the old currency.
  const shape = {
    product: product.id,
    title: product.title,
    minimum: product.priceCents,
    preset: pwyw.suggestedCents,
    maximum: Math.max(pwywMaximum(store.currency), pwyw.suggestedCents),
    tax: store.tax.enabled ? (store.tax.included ? "inclusive" : "exclusive") : "",
    ...(store.currency === "usd" ? {} : { currency: store.currency }),
  };
  const print = await fingerprint(JSON.stringify(shape));
  const key = priceKey(account, print);
  const refused = refusedKey(account, print);
  const retry = fresh ? archivedKey(account, print, archived) : "";
  const cache = isRedisConfigured();

  let refusals = cache ? 0 : refusedHereNow(refused, Date.now());
  let marked = fresh && !cache ? hereNow(archivedHere, retry, Date.now()) : 0;
  if (cache) {
    const [kept, count, left, mark] = await redisPipeline([["GET", key], ["GET", refused], ["TTL", refused], ...(fresh ? [["GET", retry]] : [])]);
    if (!fresh && typeof kept === "string" && PRICE_ID.test(kept)) return kept;
    refusals = refusedCount(count);
    marked = refusedCount(mark);
    // A count left with no expiry (its EXPIRE never landed) would hold the product for good: it is given its day.
    if (left === -1) await redisPipeline([["EXPIRE", refused, REFUSED_SECONDS]]).catch(() => {});
  }
  if (refusals > REFUSED_MOST) throw new PwywPriceHeld(product.title);
  if (fresh) {
    // The retry asks under a new key, so it is counted before it asks, and held past REFUSED_MOST as any other.
    if (!marked) {
      if (refusals + 1 > REFUSED_MOST) throw new PwywPriceHeld(product.title);
      if (cache) {
        const [set, mark] = await redisPipeline([["SET", retry, String(refusals + 1), "NX", "EX", REFUSED_SECONDS], ["GET", retry]]);
        marked = refusedCount(mark);
        if (!marked) throw new Error("The retry could not be counted");
        // Never a Price asked for without its count: a count that did not land fails the checkout and frees the mark.
        if (set === "OK") {
          try {
            const [added] = await redisPipeline([["INCR", refused], ["EXPIRE", refused, REFUSED_SECONDS]]);
            if (!refusedCount(added)) throw new Error("The retry was not counted");
          } catch (error) {
            await redisPipeline([["DEL", retry]]).catch(() => {});
            throw error;
          }
        }
      } else {
        marked = refusals + 1;
        const now = Date.now();
        herePut(archivedHere, retry, marked, now);
        refusedHereAdd(refused, now);
      }
    }
    if (marked > REFUSED_MOST) throw new PwywPriceHeld(product.title);
    refusals = marked;
  }

  const body = new URLSearchParams({
    currency: store.currency,
    "custom_unit_amount[enabled]": "true",
    "custom_unit_amount[minimum]": String(shape.minimum),
    "custom_unit_amount[preset]": String(shape.preset),
    "custom_unit_amount[maximum]": String(shape.maximum),
    "product_data[name]": product.title,
    "product_data[metadata][store]": store.handle,
    "product_data[metadata][product]": product.id,
    "metadata[store]": store.handle,
    "metadata[product]": product.id,
  });
  if (shape.tax) body.set("tax_behavior", shape.tax);
  // Two buyers pressing buy at the same moment make one Price, not two: they read the same count of refusals, or, on
  // the retry after an archived Price, the same mark. Never a key of the clock: each new key may make a Price.
  const idempotency = `pwyw-${print}${refusals ? `-r${refusals}` : ""}`;
  const price = await onAccount("POST", account, "/prices", body, undefined, idempotency);
  // Nothing is kept on any other reply: the checkout that asked fails, and the count of refusals goes up, so the next
  // one asks Stripe again under a new key instead of being answered this reply again for a day (rule 30).
  const written = { currency: store.currency, minimum: shape.minimum, preset: shape.preset, maximum: shape.maximum, tax: shape.tax, product: product.id };
  // On the retry, Stripe answering with the very Price it just refused at checkout is a refusal too: it is its kept
  // reply to a key already used (a count that was lost, or a key Stripe keeps past the count's day), and taking it
  // would send every checkout back to that archived Price until the mark ran out, without ever reaching the ceiling.
  if (!isPwywPrice(price, written) || (fresh && price.id === archived)) {
    // A retry's key was counted when it was marked: the mark goes, so the next retry is counted and asks under a new key.
    if (fresh) {
      if (cache) await redisPipeline([["DEL", retry]]).catch(() => {});
      else archivedHere.delete(retry);
    } else if (cache) await redisPipeline([["INCR", refused], ["EXPIRE", refused, REFUSED_SECONDS]]).catch(() => {});
    else refusedHereAdd(refused, Date.now());
    throw new Error("Stripe did not return the price just written");
  }
  // The count of refusals stays until it runs out: the next checkout asks under the key that was just answered right.
  if (cache) await redisPipeline([["SET", key, price.id, "EX", KEEP_SECONDS]]).catch(() => {});
  return price.id;
}
