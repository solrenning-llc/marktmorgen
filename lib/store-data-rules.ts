/**
 * What a store may keep in the database, the rules (added 18 October 2026).
 *
 * Every record a store keeps in Redis is paid for every month it is kept, at
 * Upstash's storage rate, and many of them grow with a store's age: its
 * products and pages, its contacts, its community's posts, the records each
 * of its orders leaves. Until this day only some kinds had a count of their
 * own, so no plan's worst month could say what a store's records cost
 * (tests/plan-cost-registry.ts, the line database-storage).
 *
 * So each store has a data room: a number of bytes, by plan, that what it
 * keeps there may fill, measured where it is written (lib/store-data.ts) and
 * given back where it goes. Two kinds of writes take from it:
 *
 *   - What a store chooses to keep: the store's own record and its
 *     products, pages, posts, notes, contacts, forms and what buyers write
 *     inside what they bought. Taken before it is written, all or nothing:
 *     what does not fit is refused with a sentence saying so, and nothing is
 *     written. Deleting, shortening and hiding are never refused.
 *   - What an order leaves: each of its records charged at what it really
 *     adds as it is written (lib/order-data.ts, since 18 October 2026; until
 *     then a fixed ORDER_DATA_BYTES an order), and never refused, because a
 *     buyer who paid must get everything. Its room is held up front instead,
 *     at the most an order can take: a new checkout is admitted only while
 *     the room has space for it and for every checkout still open
 *     (lib/order-admission.ts), the way the month's order figure is, and
 *     what a store chooses to keep may fill the room only up to
 *     ORDER_RESERVE_WINDOWS windows of orders from the top, so a full room
 *     never stops sales on its own.
 *
 * Records that are not in the room are bounded another way, each in
 * tests/store-data-registry.ts: they expire within days of the use that
 * wrote them, or are capped in number and size, or belong to the company
 * and not to a store. That file fails when a key family is added without
 * saying which.
 *
 * Pure and browser-safe: the studio shows the same figures the writes are
 * refused at.
 */
import type { Tier } from "@/lib/plan";
import { paidOrdersLimitFor } from "@/lib/order-rules";
import { MAX_CART } from "@/lib/cart-rules";
import { MAX_BUMPS } from "@/lib/product-extras";
import { MAX_BUNDLE_ITEMS } from "@/lib/bundle-rules";
import { type PlanFields, type Standing, standingOf } from "@/lib/plan-standing";

const MB = 1_000_000;

/**
 * The room each plan's store has in the database, in bytes: what it keeps
 * and what its orders leave, together. Sized so each plan keeps the owner's
 * 60% after tax at full use of everything (tests/spend-floor.test.ts).
 */
export const DATA_ROOM_BYTES: Record<Tier, number> = {
  creator: 18 * MB,
  pro: 135 * MB,
  scale: 250 * MB,
};

/**
 * The room of a store that pays nothing: a free trial, no plan, a plan that
 * ended. What it already keeps stays; past this nothing new is kept.
 */
export const NON_PAYING_DATA_ROOM_BYTES: Record<Exclude<Standing, "paid">, number> = {
  trial: 10 * MB,
  none: 5 * MB,
  ended: 5 * MB,
};

/**
 * The most one order can keep for good, in bytes, whatever it holds: what a
 * checkout holds in the room while it is open (lib/order-admission.ts), and
 * the reserve for orders is counted in. What an order really keeps is
 * charged as it is written (lib/order-data.ts), and is far less. This is at
 * least everything an order can write that is kept for as long as the store
 * is (its buyer's contact and access, the community, the license key, the
 * podcast and Discord access a product gives, the sale an affiliate earns
 * on, its review's marks...), each at the most it can weigh, and
 * ITEM_DATA_BYTES more for each product it hands over
 * (tests/store-data-registry.ts adds them up and holds these above the sums).
 * What an order keeps only for a while is priced on its own, at every order
 * of the window (the registry's parts by the order).
 */
export const ORDER_DATA_BYTES = 4_608;

/**
 * What each product an order hands over keeps for good besides: its place in
 * the buyer's record of what they bought (lib/learn.ts, recordEnrollment).
 * A course's student row is written when they first open it, and takes its
 * own room then (touchStudent). 4,352 until 9 November 2026; a podcast's listener is
 * also listed by its product since (lib/podcast-access.ts, audit A1), a member's
 * key and ENTRY_BYTES more.
 */
export const ITEM_DATA_BYTES = 4_416;

/** The most products one order can hand over: a cart of MAX_CART, each with MAX_BUMPS added, every one a bundle of MAX_BUNDLE_ITEMS. */
export const MAX_ORDER_ITEMS = (MAX_CART + MAX_BUMPS) * MAX_BUNDLE_ITEMS;

/** The products a checkout of these hands over at the most: a bundle's each, every other one itself. */
export function itemsHandedOver(products: { bundle?: readonly string[] | null }[]): number {
  return Math.max(1, products.reduce((n, product) => n + (Array.isArray(product.bundle) && product.bundle.length > 0 ? product.bundle.length : 1), 0));
}

/** What an order of this many products takes from the room; a checkout holds it while it is open (lib/order-admission.ts). */
export function orderDataBytes(items: number): number {
  const n = Number.isSafeInteger(items) && items > 0 ? Math.min(items, MAX_ORDER_ITEMS) : 1;
  return ORDER_DATA_BYTES + n * ITEM_DATA_BYTES;
}

/**
 * What the records kept beside a product weigh at the most, in bytes,
 * counted in the room with the product from the day it is made: its stock
 * and copies sold, when its buyers were last written to and the latest send,
 * the prices made for a tier or yearly switch (four each), its team event
 * type and round-robin counts, the Discord roles it gives, its introductory
 * coupon, its waitlist and pre-order flags, its reviews' summary and the
 * email platform's tags for it, each at its largest with its key. Once the
 * product is deleted they stay counted for as long as the store is
 * (lib/store.ts): some are kept until they expire, some are never let go.
 */
export const PRODUCT_SIDE_BYTES = 8_192;

/**
 * How long a booked call's line in the store's diary is kept after the call
 * ended (18 October 2026). The diary is what makes a time unavailable; a call
 * long over makes nothing unavailable, and Stripe keeps the booking itself
 * (its checkout, with the time in its details), which is what every page and
 * refund reads. So the line is let go, and the room it took given back, on
 * the first look at the diary this many days after the call (lib/calls.ts).
 */
export const PAST_CALL_DAYS = 90;

/** Windows of a plan's orders, of one product each, that what a store keeps leaves room for. */
export const ORDER_RESERVE_WINDOWS = 2;

/**
 * What each entry a write adds is counted at besides its own bytes: the key
 * or field it is kept under, and what Redis keeps beside it. A review
 * ceiling, rounded up: keys here are under 120 characters.
 */
export const ENTRY_BYTES = 128;

/** Writes are counted in steps of this many bytes, rounded up. */
export const DATA_STEP_BYTES = 16;

export type DataFields = PlanFields & { tier?: Tier };

/** The room of this store, in bytes. */
export function dataRoomFor(store: DataFields, nowSeconds = Date.now() / 1000): number {
  const standing = standingOf(store, nowSeconds);
  if (standing === "paid") return DATA_ROOM_BYTES[store.tier ?? "creator"] ?? DATA_ROOM_BYTES.creator;
  return NON_PAYING_DATA_ROOM_BYTES[standing];
}

/** What is kept back from the room for orders, in bytes: ORDER_RESERVE_WINDOWS windows of the store's order figure. */
export function orderReserveFor(store: DataFields, nowSeconds = Date.now() / 1000): number {
  const orders = paidOrdersLimitFor(store, nowSeconds) ?? 0;
  return Math.min(dataRoomFor(store, nowSeconds), ORDER_RESERVE_WINDOWS * orders * orderDataBytes(1));
}

/** How far what a store chooses to keep may fill its room, in bytes. */
export function contentRoomFor(store: DataFields, nowSeconds = Date.now() / 1000): number {
  return Math.max(0, dataRoomFor(store, nowSeconds) - orderReserveFor(store, nowSeconds));
}

/**
 * What a record counts for, in bytes: the UTF-8 length of what is written,
 * and ENTRY_BYTES for each key, field or member it is kept under, rounded up
 * to DATA_STEP_BYTES. Strings and numbers are measured as written.
 */
export function dataBytes(values: (string | number | null | undefined)[] | string, entries = 1): number {
  const list = typeof values === "string" ? [values] : values;
  let bytes = Math.max(0, Math.floor(entries)) * ENTRY_BYTES;
  for (const value of list) {
    if (value === null || value === undefined) continue;
    const text = typeof value === "string" ? value : String(value);
    bytes += utf8Length(text);
  }
  return Math.ceil(bytes / DATA_STEP_BYTES) * DATA_STEP_BYTES;
}

/**
 * dataBytes for values known only by their total UTF-8 length, as a Redis script reports one (string.len counts
 * bytes): dataBytesOfLength(utf8Length(a) + utf8Length(b), n) === dataBytes([a, b], n).
 */
export function dataBytesOfLength(utf8Bytes: number, entries = 1): number {
  const bytes = Math.max(0, Math.floor(entries)) * ENTRY_BYTES + Math.max(0, Math.floor(utf8Bytes));
  return Math.ceil(bytes / DATA_STEP_BYTES) * DATA_STEP_BYTES;
}

/** UTF-8 bytes of a string, without a TextEncoder (so it runs anywhere). */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) n += 1;
    else if (code < 0x800) n += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

/** "12.4 MB", "640 KB": bytes, the way the studio says them. */
export function dataWords(bytes: number): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (b >= MB) return `${(Math.round((b / MB) * 10) / 10).toLocaleString("en-US")} MB`;
  return `${Math.max(b > 0 ? 1 : 0, Math.round(b / 1000)).toLocaleString("en-US")} KB`;
}

/** The rooms in one sentence, for the pricing page, the help center and the terms. */
export function dataRoomListWords(names: Record<Tier, string>): string {
  return `${dataWords(DATA_ROOM_BYTES.creator)} on ${names.creator}, ${dataWords(DATA_ROOM_BYTES.pro)} on ${names.pro} and ${dataWords(DATA_ROOM_BYTES.scale)} on ${names.scale}`;
}

/** What the creator is told when something does not fit; `larger` whether this store can move to a larger plan now (lib/larger-plan.ts). */
export function dataFullWords(used: number, room: number, larger = false): string {
  return `Your store's data room is full (${dataWords(used)} of ${dataWords(room)}). Delete something you no longer need, such as old posts, drafts, pages or contacts${larger ? ", or move to a larger plan" : ""}.`;
}

/** What a buyer or visitor is told when what they wrote does not fit: it is the store's room, not theirs. */
export const DATA_FULL_BUYER_WORDS = "This store has no room for that right now, so it was not saved. Try again later.";
