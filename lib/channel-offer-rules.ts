/**
 * Channel offers and sales per coupon (added 16 November 2026; queue item 760 [STN7], units 1 and 2, as rules).
 * Pure and browser-safe: nothing here reads Stripe, makes a coupon or keeps anything, and nothing calls a model, so
 * this unit adds no cost to any plan.
 *
 *   - A channel offer is a discount that belongs to one post or one AutoDM. It reaches only a visit that came
 *     through that channel's own link: an AutoDM's link already carries `mm_dm=<rule id>` (lib/autodm-rules.ts,
 *     dmLinkTag); a post's link carries `mm_post=<post id>`. It is never a code to type. The checkout unit applies it
 *     as a Stripe coupon on the creator's account with no promotion code, so nobody can type it and a code shared
 *     elsewhere cannot take it; Stripe still does the arithmetic (lib/discount.ts). What it takes off is read as a
 *     new discount code's is (lib/discount-input.ts): a whole percent from 1 to 100, or an amount in the store's
 *     currency within its price range.
 *   - Sales per coupon: whole orders, added up per coupon (a typed code, or "offer:<id>" for a channel offer) and
 *     per currency, with refunds apart. A row that does not read leaves the report partial, never a smaller whole
 *     shown as complete (rule 24).
 *
 * Unknown is never zero: a use count that cannot be read gives no offer, an unknown clock gives no offer.
 */
import { dmLinkTag } from "@/lib/autodm-rules";
import type { Off } from "@/lib/discount-rules";
import { CURRENCIES, type Currency, priceInRange, readMoney } from "@/lib/money";

export type ChannelKind = "post" | "autodm";
export type Channel = { kind: ChannelKind; id: string };
export type ChannelOffer = { id: string; channel: Channel; off: Off; product: string | null; endsAt: number | null; maxUses: number | null };
export type OfferRefusal = "id" | "channel" | "percent" | "amount" | "product" | "ends" | "uses";

/** An offer's own id: 6 to 24 lowercase letters and digits. */
const OFFER_ID = /^[a-z0-9]{6,24}$/;
/** A post's id on the platform, as an AutoDM rule keeps it (lib/autodm-reply-rules.ts). */
const POST_ID = /^[A-Za-z0-9_-]{1,64}$/;

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : typeof value === "number" && Number.isFinite(value) ? String(value).slice(0, max) : "");

/** The link tag a channel's visits carry, or null for a channel that is not one. */
export function channelTag(channel: { kind: unknown; id: unknown } | null | undefined): { name: "mm_dm" | "mm_post"; value: string } | null {
  if (!channel || typeof channel.id !== "string") return null;
  if (channel.kind === "autodm") return dmLinkTag(channel.id);
  if (channel.kind === "post") return POST_ID.test(channel.id) ? { name: "mm_post", value: channel.id } : null;
  return null;
}

/**
 * A channel offer as the studio sends it, checked against the store's currency and the ids of the products it sells
 * now, or the first thing wrong with it. Left out: every product, no end, no cap.
 */
export function readChannelOffer(input: unknown, currency: Currency, products: readonly { id: string }[]): { ok: true; offer: ChannelOffer } | { ok: false; reason: OfferRefusal } {
  const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const id = typeof value.id === "string" ? value.id : "";
  if (!OFFER_ID.test(id)) return { ok: false, reason: "id" };
  const raw = value.channel && typeof value.channel === "object" ? (value.channel as Record<string, unknown>) : null;
  const tag = channelTag(raw as { kind: unknown; id: unknown } | null);
  if (!raw || !tag) return { ok: false, reason: "channel" };
  const channel: Channel = { kind: raw.kind as ChannelKind, id: raw.id as string };
  let off: Off;
  if (text(value.kind, 10) === "amount") {
    const cents = readMoney(text(value.amount, 20), currency);
    if (cents === null || !priceInRange(cents, currency)) return { ok: false, reason: "amount" };
    off = { kind: "amount", cents, currency };
  } else {
    const percent = Number(text(value.percent, 10));
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) return { ok: false, reason: "percent" };
    off = { kind: "percent", percent };
  }
  let product: string | null = null;
  if (value.product !== undefined && value.product !== null && value.product !== "") {
    if (typeof value.product !== "string" || !products.some((p) => p.id === value.product)) return { ok: false, reason: "product" };
    product = value.product;
  }
  let endsAt: number | null = null;
  if (value.endsAt !== undefined && value.endsAt !== null && value.endsAt !== "") {
    if (typeof value.endsAt !== "number" || !Number.isSafeInteger(value.endsAt) || value.endsAt <= 0) return { ok: false, reason: "ends" };
    endsAt = value.endsAt;
  }
  let maxUses: number | null = null;
  const uses = text(value.maxUses, 10);
  if (uses) {
    const n = Number(uses);
    if (!Number.isSafeInteger(n) || n < 1) return { ok: false, reason: "uses" };
    maxUses = n;
  }
  return { ok: true, offer: { id, channel, off, product, endsAt, maxUses } };
}

/**
 * The offer a visit gets, or null: the first offer whose channel's tag is exactly the visit's, for this product (or
 * every product), before its end, and under its cap by a use count that reads as a whole number. A cap with no
 * readable count, or an unknown clock, gives nothing.
 */
export function offerForVisit(input: {
  offers: readonly ChannelOffer[];
  tag: { name: string; value: string } | null;
  product: string;
  nowSeconds: number;
  used: Record<string, number> | null;
}): ChannelOffer | null {
  const { tag } = input;
  if (!tag || typeof tag.name !== "string" || typeof tag.value !== "string") return null;
  if (typeof input.nowSeconds !== "number" || !Number.isFinite(input.nowSeconds)) return null;
  for (const offer of input.offers) {
    const own = channelTag(offer.channel);
    if (!own || own.name !== tag.name || own.value !== tag.value) continue;
    if (offer.product !== null && offer.product !== input.product) continue;
    if (offer.endsAt !== null && input.nowSeconds >= offer.endsAt) continue;
    if (offer.maxUses !== null) {
      const count = input.used && Object.hasOwn(input.used, offer.id) ? input.used[offer.id] : undefined;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count >= offer.maxUses) continue;
    }
    return offer;
  }
  return null;
}

const CURRENCY_CODES = new Set<string>(CURRENCIES.map((rule) => rule.code));

/** One coupon's sales: whole orders, and the money per currency, gross and refunded. */
export type CouponLine = { key: string; orders: number; gross: Record<string, number>; refunded: Record<string, number> };

/**
 * Sales per coupon from one row per order that used one: its coupon key, the amount charged and refunded in cents
 * and its currency. A row that does not read (no key, an amount that is not a whole number from 0, a refund above the
 * charge, an unknown currency) is left out and makes the report partial. Lines come out with the most orders first,
 * then by key.
 */
export function couponSalesReport(rows: unknown): { partial: boolean; lines: CouponLine[] } {
  if (!Array.isArray(rows)) return { partial: true, lines: [] };
  let partial = false;
  const byKey = new Map<string, CouponLine>();
  for (const row of rows) {
    const r = row && typeof row === "object" ? (row as Record<string, unknown>) : null;
    const key = r && typeof r.key === "string" ? r.key : "";
    const amount = r?.amountCents;
    const refunded = r?.refundedCents;
    const currency = r?.currency;
    if (
      !key ||
      typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0 ||
      typeof refunded !== "number" || !Number.isSafeInteger(refunded) || refunded < 0 || refunded > amount ||
      typeof currency !== "string" || !CURRENCY_CODES.has(currency)
    ) {
      partial = true;
      continue;
    }
    const line = byKey.get(key) ?? { key, orders: 0, gross: {}, refunded: {} };
    line.orders += 1;
    line.gross[currency] = (line.gross[currency] ?? 0) + amount;
    if (refunded > 0) line.refunded[currency] = (line.refunded[currency] ?? 0) + refunded;
    byKey.set(key, line);
  }
  const lines = [...byKey.values()].map((line) => ({ ...line, gross: sorted(line.gross), refunded: sorted(line.refunded) }));
  lines.sort((a, b) => b.orders - a.orders || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { partial, lines };
}

/** The same amounts, their currencies in order, so a report reads the same each time. */
function sorted(amounts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(amounts).sort(([a], [b]) => (a < b ? -1 : 1)));
}
