/**
 * Saved groups of a store's list, and three ways to narrow an email by money
 * (added 12 October 2026).
 *
 * Until now an email could go to everybody, to the buyers or the people who
 * have not bought, to those who got one product, leaving out those who got
 * another. Kissmetrics' Populations, Segment's audiences and the cohorts of
 * Amplitude and Mixpanel add what a store knows and a list does not: how much
 * somebody has spent, where they first found the store, and how long it has
 * been since they last bought. Those three are what turn "everyone who
 * bought" into the letter for the best customers, or for the ones who went
 * quiet.
 *
 * None of the three is written down about anybody. Each is worked out from
 * the store's own sales on the creator's Stripe account (lib/stats.ts,
 * readPaidSales), only when an email asks for one, and the answer is kept ten
 * minutes so a creator changing the boxes does not ask Stripe each time:
 *
 *   nl:stats:<statsId>:ledger   JSON { c: currency, p: partial, v: 4, r: [[address, cents, last ms, channel, orders], …] }, ten minutes
 *   nl:mail:segs:<listId>       hash: <id> → JSON Segment, the store's saved groups
 *
 * A group is a name over the choices the composer already has: who, one
 * product, one left out, and the three above. Choosing it fills them in.
 */
import { importedBuyers, importedWhoKey } from "@/lib/imported-purchases";
import { IMPORTED_CHANNEL } from "@/lib/channel-names";
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { normaliseEmail } from "@/lib/auth";
import { WHO, type Who, readTags } from "@/lib/contacts";
import { paypalPaymentId, readPayPalRefundsWithCoverage } from "@/lib/paypal-sales";
import { rfmGroup } from "@/lib/rfm-rules";
import { ALL_TIME_PAGES, readInvoicePayments, readPaidSales, readRenewalPayments, readStoreDisputes, readStoreRefunds, readsSales } from "@/lib/stats";
import { hasProduct } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { MAX_SEGMENTS, MAX_SEGMENT_NAME, type Narrow, type Segment, isNarrowed, readNarrow } from "@/lib/segments-rules";

export { type Narrow, NO_NARROW, QUIET_DAYS, ACTIVE_DAYS, MAX_SEGMENTS, MAX_SEGMENT_NAME, type Segment, readNarrow, isNarrowed } from "@/lib/segments-rules";

const LEDGER_SECONDS = 600;
const SEGMENT_ID = /^[0-9a-f]{12}$/;

const ledgerKey = (statsId: string) => `nl:stats:${statsId}:ledger`;
const segmentsKey = (listId: string) => `nl:mail:segs:${listId}`;

/**
 * What one address has spent here, when it last bought, where it first came
 * from ("direct" when nowhere was named), and how many times it bought: each
 * checkout once, an offer taken after paying not counted again (270 [GR1]).
 */
export type LedgerEntry = { cents: number; last: number; channel: string; orders: number };
export type Ledger = { buyers: Map<string, LedgerEntry>; partial: boolean };

type Row = [string, number, number, string, number];
/** The cached rows' shape; a reading kept in an older one is read again (3: a sale in another currency counts as a purchase; 4: renewals, refunds and disputes; 5: invoices' payments; 6: each renewal counted as a time they bought). */
const LEDGER_SHAPE = 6;
/** Pages of a hundred refunds read for the ledger; `partial` when there were more. */
const TAKEN_BACK_PAGES = 10;
/** How long the renewals are read for one ledger before the reading stops, partial: inside the email route's minute. */
const RENEWALS_SECONDS = 25;

/**
 * Every buyer of this store, from its sales on the creator's Stripe account,
 * as far back as a reading reaches (ALL_TIME_PAGES pages of each). Support
 * for the creator's work is not a purchase. A sale in another currency (from
 * before the store changed its own) is a purchase like any other: its order,
 * its date and its channel count, but not its money, because amounts in two
 * currencies do not add up, so "spent with you" counts the store's currency
 * only (22 [E5], unit 2c).
 */
/** Thrown by buyerLedger when what reading Stripe again costs could not be counted first: nothing was read. */
export class LedgerNotCounted extends Error {
  constructor() {
    super("the reading of the store's buyers could not be counted");
    this.name = "LedgerNotCounted";
  }
}

/**
 * Studio requests one reading of the buyers from Stripe costs at the most,
 * when its ten-minute copy ran out (tests/plan-cost-registry.ts,
 * BUYER_LEDGER), besides what it reads and writes by size (below): for a
 * caller that counts them (`count`, below).
 */
export const BUYER_LEDGER_UNITS = 8;
/** Bytes of the ledger's copy, or of the imported buyers, that one studio request covers when read (tests/plan-cost-registry.ts, LEDGER_MB). */
export const LEDGER_BYTES_PER_UNIT = 1_000_000;
/** The most one imported buyer weighs: its address and when it came, read, then written in the copy as a row. */
export const IMPORTED_BUYER_BYTES = 2 * (254 + 64);

/** Studio requests reading (or writing) `bytes` of the buyers costs, by size. */
export const ledgerUnits = (bytes: number) => Math.ceil(Math.max(0, bytes) / LEDGER_BYTES_PER_UNIT);

/**
 * `count`, when given, is asked before anything big is read, with the studio
 * requests it costs, and answers whether they were counted; when they were
 * not, nothing more is read and LedgerNotCounted is thrown. The ten-minute
 * copy is counted by its size (measured first, STRLEN), and a reading from
 * Stripe as BUYER_LEDGER_UNITS and the imported buyers by how many there are
 * (HLEN), both before they are read.
 */
export async function buyerLedger(store: Store, count?: (units: number) => Promise<boolean>): Promise<Ledger> {
  if (!readsSales(store) && !store.pastBuyers) return { buyers: new Map(), partial: false };
  const counted = async (units: number) => !count || units <= 0 || (await count(units).catch(() => false));
  if (store.statsId && isRedisConfigured()) {
    const [size] = await redisPipeline([["STRLEN", ledgerKey(store.statsId)]]);
    if (Number(size) > 0 && !(await counted(ledgerUnits(Number(size))))) throw new LedgerNotCounted();
    const [cached] = Number(size) > 0 ? await redisPipeline([["GET", ledgerKey(store.statsId)]]) : [null];
    if (typeof cached === "string" && cached) {
      try {
        const kept = JSON.parse(cached) as { c?: string; p?: boolean; r?: Row[]; v?: number };
        if (kept.c === store.currency && kept.v === LEDGER_SHAPE && Array.isArray(kept.r)) {
          return { buyers: new Map(kept.r.map(([e, cents, last, channel, orders]) => [e, { cents, last, channel, orders }])), partial: kept.p === true };
        }
      } catch {
        // Read again below.
      }
    }
  }
  // Stripe's pages, and the imported buyers read and written in the copy, by how many there are: before any is read.
  const [imported] = store.statsId && isRedisConfigured() ? await redisPipeline([["HLEN", importedWhoKey(store.statsId)]]) : [0];
  if (!(await counted(BUYER_LEDGER_UNITS + ledgerUnits(Number(imported || 0) * IMPORTED_BUYER_BYTES)))) throw new LedgerNotCounted();
  // Checkouts and offers after paying; and, on a Stripe account, the renewals
  // of memberships and payment plans, and what refunds and disputes took back
  // (270 [GR1], unit 2): a member who pays every month is not quiet since they
  // joined, and a purchase given back is not a purchase.
  const stripe = Boolean(store.stripeAccountId);
  const none = { rows: [], partial: false };
  const until = Date.now() + RENEWALS_SECONDS * 1000;
  const [paid, renewals, refunds, disputes, paypalBack, invoicePayments] = await Promise.all([
    readPaidSales(store, 0, ALL_TIME_PAGES),
    // Renewals stop reading after RENEWALS_SECONDS, partial, so a store with years of them is not a timeout.
    stripe ? readRenewalPayments(store, 0, ALL_TIME_PAGES, until) : Promise.resolve(none),
    stripe ? readStoreRefunds(store, 0, TAKEN_BACK_PAGES) : Promise.resolve(none),
    stripe ? readStoreDisputes(store, 0) : Promise.resolve(none),
    // PayPal's refunds, as the numbers read them (lib/stats.ts): unread is partial, never none.
    store.paypalSeller ? readPayPalRefundsWithCoverage(store.statsId, 0).catch(() => null) : Promise.resolve(none),
    // Each invoice's payment (270 [GR1], unit 3a): a membership's payment, or its first through checkout, is refunded by that payment.
    stripe ? readInvoicePayments(store, 0, ALL_TIME_PAGES, until).catch(() => null) : Promise.resolve({ byInvoice: new Map<string, string[]>(), partial: false }),
  ]);
  const { sales } = paid;
  const readPartial = paid.partial || renewals.partial || refunds.partial || disputes.partial || !paypalBack || paypalBack.partial;
  // An invoice whose payment had to be looked up and was not found (the list unread, cut short, or a charge with no payment
  // intent) leaves its refunds unmatched: the reading is then partial, never "none refunded".
  let missed = false;
  const paymentsOfInvoice = (invoice: unknown): string[] => {
    if (typeof invoice !== "string" || !invoice) return [];
    const found = invoicePayments?.byInvoice.get(invoice) ?? [];
    if (!found.length || found.some((intent) => !intent)) missed = true;
    return found.filter(Boolean);
  };
  // What was given back of each payment, by the payment: refunds (Stripe's and PayPal's), and disputes that took or hold the money.
  const takenBack = new Map<string, number>();
  const backs = [...refunds.rows, ...disputes.rows, ...(paypalBack?.rows ?? []).map((r) => ({ cents: r.cents, paymentIntent: paypalPaymentId(r.capture) }))];
  for (const back of backs) if (back.paymentIntent) takenBack.set(back.paymentIntent, (takenBack.get(back.paymentIntent) ?? 0) + back.cents);
  const kept = (paymentIntents: string[], cents: number) => Math.max(0, cents - paymentIntents.reduce((sum, intent) => sum + (takenBack.get(intent) ?? 0), 0));
  const buyers = new Map<string, LedgerEntry & { firstAt: number }>();
  for (const sale of sales) {
    if ((sale.row.metadata as Record<string, string> | null | undefined)?.kind === "tip") continue;
    const details = sale.row.customer_details as { email?: unknown } | null | undefined;
    const raw = sale.upsell ? sale.row.receipt_email : details?.email;
    if (typeof raw !== "string" || !raw.trim()) continue;
    // Given back in full: not a purchase (a free copy, which cost nothing, still is).
    // A checkout that started a subscription carries no payment of its own: its first invoice's is the one refunded.
    const sessionInvoice = sale.row.invoice && typeof sale.row.invoice === "object" ? (sale.row.invoice as { id?: unknown }).id : sale.row.invoice;
    const left = kept(sale.paymentIntent ? [sale.paymentIntent] : paymentsOfInvoice(sessionInvoice), sale.cents);
    if (sale.cents > 0 && left === 0) continue;
    const email = normaliseEmail(raw);
    const row = buyers.get(email) ?? { cents: 0, last: 0, channel: "direct", orders: 0, firstAt: Infinity };
    if (sale.currency === store.currency) row.cents += left;
    if (!sale.upsell) row.orders += 1;
    row.last = Math.max(row.last, sale.created);
    // Where they first came from: the channel on their earliest checkout.
    if (!sale.upsell && sale.created < row.firstAt) {
      row.firstAt = sale.created;
      row.channel = sale.first || sale.source || "direct";
    }
    buyers.set(email, row);
  }
  // A renewal is a payment: it moves the last purchase, adds what was kept in the store's currency, and counts as one more time they bought.
  for (const renewal of renewals.rows) {
    const left = kept(renewal.paymentIntent ? [renewal.paymentIntent] : paymentsOfInvoice(renewal.invoice), renewal.cents);
    if (left === 0) continue;
    const email = normaliseEmail(renewal.email);
    // A buyer known only by a renewal came from the channel the subscription was sold through.
    const row = buyers.get(email) ?? { cents: 0, last: 0, channel: renewal.channel || "direct", orders: 0, firstAt: Infinity };
    if (renewal.currency === store.currency) row.cents += left;
    // Each payment kept is one more time they bought, for how often (lib/rfm-rules.ts): a member of a year is not "new".
    row.orders += 1;
    row.last = Math.max(row.last, renewal.created);
    buyers.set(email, row);
  }
  // Partial when any list was cut short or unread, or when an invoice's payment was needed and not found.
  const partial = readPartial || missed;
  const out: Ledger = { buyers: new Map([...buyers].map(([e, r]) => [e, { cents: r.cents, last: r.last, channel: r.channel, orders: r.orders }])), partial };
  // Buyers brought over from another platform (lib/imported-purchases.ts): history, never a sale.
  // Nothing spent here and no purchase date here; they first came "imported".
  for (const email of (await importedBuyers(store.statsId).catch(() => new Map<string, number>())).keys()) {
    if (!out.buyers.has(email)) out.buyers.set(email, { cents: 0, last: 0, channel: IMPORTED_CHANNEL, orders: 0 });
  }
  if (store.statsId && isRedisConfigured()) {
    const rows: Row[] = [...out.buyers].map(([e, r]) => [e, r.cents, r.last, r.channel, r.orders]);
    await redisPipeline([["SET", ledgerKey(store.statsId), JSON.stringify({ c: store.currency, p: partial, r: rows, v: LEDGER_SHAPE }), "EX", LEDGER_SECONDS]]).catch(() => {});
  }
  return out;
}

/** Whether one address is in what the three narrowings ask for. */
export function keeps(narrow: Narrow, ledger: Ledger, now = Date.now()): (email: string) => boolean {
  return (email) => {
    const row = ledger.buyers.get(normaliseEmail(email));
    if (narrow.minSpent > 0 && (row?.cents ?? 0) < narrow.minSpent) return false;
    if (narrow.channel && (!row || row.channel !== narrow.channel)) return false;
    // Has bought, and not in these days: the ones who went quiet, not the ones who never bought.
    if (narrow.quietDays > 0 && (!row || row.last >= now - narrow.quietDays * 86_400_000)) return false;
    // Bought here in these days (461 [EL5]): the buyers still active. Never someone who never bought.
    if (narrow.activeDays && (!row || !row.last || row.last < now - narrow.activeDays * 86_400_000)) return false;
    // One group of the store's buyers (lib/rfm-rules.ts, 270 [GR1], unit 3b), worked out from the same row.
    if (narrow.group && (!row || rfmGroup(row, now) !== narrow.group)) return false;
    return true;
  };
}

/** The channels the store's buyers first came from, the most buyers first: the choices "first found you through" offers. */
export function ledgerChannels(ledger: Ledger): string[] {
  const by = new Map<string, number>();
  for (const row of ledger.buyers.values()) by.set(row.channel, (by.get(row.channel) ?? 0) + 1);
  return [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([channel]) => channel);
}

/** The narrowing for an audience: null when there is none, so nothing is read from Stripe. */
export async function keepFor(store: Store, narrow: Narrow | null | undefined): Promise<((email: string) => boolean) | undefined> {
  if (!isNarrowed(narrow)) return undefined;
  return keeps(narrow, await buyerLedger(store));
}

// ------------------------------------------------------------ saved groups

function parseSegment(raw: unknown): Segment | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Segment>;
    if (typeof value.id !== "string" || !SEGMENT_ID.test(value.id) || typeof value.name !== "string" || !value.name) return null;
    return {
      id: value.id,
      name: value.name.slice(0, MAX_SEGMENT_NAME),
      who: WHO.includes(value.who as Who) ? (value.who as Who) : "all",
      productId: typeof value.productId === "string" ? value.productId : "",
      notProductId: typeof value.notProductId === "string" ? value.notProductId : "",
      label: typeof value.label === "string" ? readTags([value.label])[0] ?? "" : "",
      ...readNarrow(value),
    };
  } catch {
    return null;
  }
}

/** The store's saved groups, by name. */
export async function listSegments(listId: string | null): Promise<Segment[]> {
  if (!listId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HVALS", segmentsKey(listId)]]);
  return (Array.isArray(raw) ? raw : []).map(parseSegment).filter((s): s is Segment => s !== null).sort((a, b) => a.name.localeCompare(b.name));
}

export type SegmentResult = { ok: true; segments: Segment[] } | { ok: false; reason: "name" | "empty" | "product" | "full" | "setup" };

/** Saves a group under a name; the same name again replaces it. */
export async function saveSegment(store: Store, raw: Record<string, unknown>): Promise<SegmentResult> {
  if (!store.listId || !isRedisConfigured()) return { ok: false, reason: "setup" };
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim().slice(0, MAX_SEGMENT_NAME) : "";
  if (!name) return { ok: false, reason: "name" };
  const who: Who = WHO.includes(raw.who as Who) ? (raw.who as Who) : "all";
  const productId = typeof raw.productId === "string" && raw.productId ? raw.productId : "";
  const notProductId = typeof raw.notProductId === "string" && raw.notProductId ? raw.notProductId : "";
  if ((productId && !hasProduct(store, productId)) || (notProductId && !hasProduct(store, notProductId))) return { ok: false, reason: "product" };
  const narrow = readNarrow(raw.narrow);
  const label = typeof raw.label === "string" ? readTags([raw.label])[0] ?? "" : "";
  if (who === "all" && !productId && !notProductId && !label && !isNarrowed(narrow)) return { ok: false, reason: "empty" };
  const existing = await listSegments(store.listId);
  const same = existing.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!same && existing.length >= MAX_SEGMENTS) return { ok: false, reason: "full" };
  const segment: Segment = { id: same?.id ?? randomBytes(6).toString("hex"), name, who, productId, notProductId, label, ...narrow };
  await redisPipeline([["HSET", segmentsKey(store.listId), segment.id, JSON.stringify(segment)]]);
  return { ok: true, segments: await listSegments(store.listId) };
}

export async function removeSegment(store: Store, id: unknown): Promise<Segment[]> {
  if (store.listId && typeof id === "string" && SEGMENT_ID.test(id) && isRedisConfigured()) {
    await redisPipeline([["HDEL", segmentsKey(store.listId), id]]);
  }
  return listSegments(store.listId);
}

/**
 * Lets the ten-minute copy of the store's buyers go (lib/person-erasure.ts),
 * so a deleted person is not in it: it is read again from Stripe when next
 * needed, without them in the list's own records.
 */
export async function forgetLedgerCopy(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([["DEL", ledgerKey(statsId)]]);
  return Number(gone) || 0;
}
