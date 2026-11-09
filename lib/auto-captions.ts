/**
 * Captions written by AI for a lesson's video (lib/auto-captions-rules.ts
 * says what they cost, and why that way).
 *
 * Pressed in the studio: the price is charged on the card the plan is paid
 * with, then the video service is asked to write them. It answers on its own
 * time, a few minutes for most lessons; it is asked again until every
 * language asked for is there (and told by its announcement too,
 * app/api/stream/hook), and each language is listed for the lesson as it
 * arrives. What has not arrived after GIVE_UP_HOURS is refunded.
 *
 *   nl:stream:auto:<video>   what is being written, and the charge for it
 *   nl:stream:autoq          which videos to ask about, and when
 *
 * A charge is made once (inventory of money calls, 8 November 2026): an order
 * is written before it, holding the video, and the charge's idempotency key
 * comes from that order, never from the clock of an attempt. An answer from
 * Stripe that never came back is not taken for "nothing was charged": the
 * order is kept and queued, a retry charges nothing more, and Stripe's own
 * invoice decides (paid: used or refunded; void or never made: the order
 * goes). A charge that succeeded is recorded with its payment before anything
 * else, so a process that dies after it leaves a record the sweep refunds.
 * An invoice Stripe paid wholly from the creator's credit balance (it is paid
 * when finalized, with no payment) is a charge like any other: it is used, and
 * whatever of it is owed back goes back to that balance, never to a card.
 *
 * A refund Stripe has not confirmed as succeeded is never taken as done: the
 * record is kept with what is owed (`owed`), the video is asked about again,
 * and each look first reads the payment's refunds from Stripe. A new refund
 * is asked for only when Stripe lists none still in flight and not enough
 * returned, under a key that follows what Stripe listed, so two looks at
 * once ask for the same one and money is never returned twice.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { askStream, noteCaptionLanguages, streamCaptions, streamConfig, streamRecord } from "@/lib/stream";
import { readStreamPath, STREAM_ID_PATTERN } from "@/lib/stream-rules";
import { captionLabel } from "@/lib/captions";
import { chargeNow, isBillingConfigured, onPlatformAt, refundCharge, refundsOnIntent } from "@/lib/billing";
import type { Store } from "@/lib/store";
import { GIVE_UP_HOURS, MAX_AUTO_MINUTES, autoCaptionCents, chargedMinutes, readAutoAsk } from "@/lib/auto-captions-rules";

const pendingKey = (id: string) => `nl:stream:auto:${id}`;
/** The videos of one store folder with a captions refund owed. */
const owedKey = (folder: string) => `nl:stream:autoowed:${folder}`;
const QUEUE = "nl:stream:autoq";
const KEEP_SECONDS = 7 * 86_400;
const LOOK_FIRST_MS = 3 * 60_000;
const LOOK_AGAIN_MS = 10 * 60_000;
/** A refund owed is looked at again at most this many times, 10 minutes apart and doubling to six hours: about ten days. */
export const REFUND_LOOKS_MAX = 40;
const REFUND_LOOK_MAX_MS = 6 * 3_600_000;
/** A refund owed is kept long after the last look, so it is never lost while somebody may still ask about it. */
const REFUND_KEEP_SECONDS = 400 * 86_400;
/**
 * An order is settled from Stripe's invoice only this long after it was written: by then the request that wrote it
 * has ended (each Stripe call gives up after 20 seconds, and a request lasts minutes at most), so an invoice not
 * listed was never made and one listed open will never be paid by it.
 */
export const ORDER_SETTLE_MS = 15 * 60_000;
/** An order Stripe's invoices cannot settle is looked at, further apart each time, for this long; then kept for a person. */
const ORDER_LOOKS_MS = 14 * 86_400_000;
/** The API version chargeNow writes its invoices with (lib/billing.ts, CHARGE_VERSION), where an invoice names its payment. */
const CHARGE_READ_VERSION = "2024-06-20";

/**
 * What a charge is for, written before it is made and holding the video
 * (SET NX, lib/claim-mark.ts). `order` is new each time and makes the charge's
 * idempotency key; the rest is what a refund needs if the charge is found
 * paid and nothing was asked of the service.
 */
type Order = {
  order: string;
  at: number;
  cents: number;
  langs: string[];
  path: string;
  customer: string;
};

function parseOrder(raw: unknown): Order | null {
  if (typeof raw !== "string" || !raw.startsWith("{")) return null;
  try {
    const value = JSON.parse(raw) as Partial<Order>;
    if (typeof value.order !== "string" || !value.order || typeof value.at !== "number" || !Number.isSafeInteger(value.cents) || (value.cents as number) <= 0) return null;
    if (!Array.isArray(value.langs) || !value.langs.every((l) => typeof l === "string") || typeof value.path !== "string" || typeof value.customer !== "string") return null;
    return { order: value.order, at: value.at, cents: value.cents as number, langs: value.langs, path: value.path, customer: value.customer };
  } catch {
    return null;
  }
}

/** The mark on the order's invoice; `nl-` before it is the charge's idempotency key. */
const orderSign = (id: string, order: Order) => `captions:${id}:${order.order}`;

type Owed = {
  /** Cents to return, or null for the whole payment. */
  cents: number | null;
  /** The idempotency key of the first refund asked for. */
  key: string;
  since: number;
  looks: number;
  /** Looked at REFUND_LOOKS_MAX times without being confirmed: no more automatic looks. */
  stuck?: true;
};

/** A charge paid wholly from the customer's credit balance: what is owed back goes back there. */
type Credit = { customer: string; invoice: string };

type Pending = {
  /** The languages asked for, the one spoken first. */
  langs: string[];
  /** Those the service has delivered. */
  got: string[];
  /** When it was asked, in ms. */
  at: number;
  cents: number;
  /** The payment it was charged with, for a refund; empty when the credit balance paid it. */
  pi: string;
  path: string;
  /** Paid from the credit balance: refunds go back to it. */
  credit?: Credit;
  /** A refund asked for and not yet confirmed by Stripe. */
  owed?: Owed;
};

function parseOwed(raw: unknown): Owed | undefined {
  const value = raw as Partial<Owed> | null | undefined;
  if (!value || typeof value !== "object") return undefined;
  const cents = value.cents === null ? null : Number.isSafeInteger(value.cents) && (value.cents as number) > 0 ? (value.cents as number) : undefined;
  if (cents === undefined || typeof value.key !== "string" || !value.key || typeof value.since !== "number" || !Number.isSafeInteger(value.looks)) return undefined;
  return { cents, key: value.key, since: value.since, looks: value.looks as number, ...(value.stuck === true ? { stuck: true as const } : {}) };
}

function readCredit(raw: unknown): Credit {
  const value = raw as Partial<Credit> | null;
  return {
    customer: typeof value?.customer === "string" ? value.customer : "",
    invoice: typeof value?.invoice === "string" ? value.invoice : "",
  };
}

function parsePending(raw: unknown): Pending | null {
  if (typeof raw !== "string" || !raw.startsWith("{")) return null;
  try {
    const value = JSON.parse(raw) as Partial<Pending>;
    if (!Array.isArray(value.langs) || typeof value.at !== "number" || typeof value.cents !== "number" || typeof value.pi !== "string" || typeof value.path !== "string") return null;
    return {
      langs: value.langs.filter((l): l is string => typeof l === "string"),
      got: Array.isArray(value.got) ? value.got.filter((l): l is string => typeof l === "string") : [],
      at: value.at,
      cents: value.cents,
      pi: value.pi,
      path: value.path,
      // One that does not read is kept, never dropped: a refund to it is then not confirmed, so it is owed and shown.
      ...(value.credit !== undefined ? { credit: readCredit(value.credit) } : {}),
      ...(value.owed !== undefined ? { owed: parseOwed(value.owed) ?? { cents: null, key: `nl-captions:unreadable:${value.at}:refund`, since: value.at, looks: REFUND_LOOKS_MAX, stuck: true as const } } : {}),
    };
  } catch {
    return null;
  }
}

export type AutoAnswer =
  | { ok: true; writing: string[]; cents: number }
  | { ok: false; reason: "off" | "unknown" | "not_ready" | "language" | "long" | "busy" | "checking" | "owed" | "refund_pending" | "refunded" | "credited" | "plan" | "card" | "declined" | "unavailable" };

/** What captions for this video cost, by how many languages: its length as charged. Null when it cannot have them yet. */
export async function autoQuote(pathname: string): Promise<{ minutes: number; seconds: number } | null> {
  const record = await streamRecord(pathname);
  if (!record || record.state !== "ready" || !record.seconds) return null;
  return { minutes: chargedMinutes(record.seconds), seconds: record.seconds };
}

/**
 * Charges for captions in the languages asked, and asks the service to write
 * them. Nothing is charged unless all of it can be asked for; a request the
 * service refuses is refunded at once.
 */
export async function requestAutoCaptions(store: Store, pathname: string, spoken: unknown, also: unknown, now = Date.now()): Promise<AutoAnswer> {
  if (!streamConfig() || !isRedisConfigured() || !isBillingConfigured()) return { ok: false, reason: "off" };
  const record = await streamRecord(pathname);
  if (!record) return { ok: false, reason: "unknown" };
  if (record.state !== "ready" || !record.seconds) return { ok: false, reason: "not_ready" };
  const minutes = chargedMinutes(record.seconds);
  if (minutes > MAX_AUTO_MINUTES) return { ok: false, reason: "long" };
  const already = ((await streamCaptions([pathname]))[pathname] ?? []).map((t) => t.lang);
  const asked = readAutoAsk(spoken, also, already);
  // A language it already has captions in is the creator's to replace by hand.
  if (!asked || asked.languages.some((lang) => already.includes(lang))) return { ok: false, reason: "language" };
  if (!store.subscriptionActive || !store.subscriptionId || !store.stripeCustomerId) return { ok: false, reason: "plan" };

  const key = pendingKey(record.id);
  const cents = autoCaptionCents(record.seconds, asked.languages.length);
  const order: Order = { order: claimValue(now), at: now, cents, langs: asked.languages, path: pathname, customer: store.stripeCustomerId };
  const value = JSON.stringify(order);
  // The order is written before the charge and kept as long as a refund may be owed: it is the only trace of a charge whose answer was lost.
  const claim = await claimMark(key, REFUND_KEEP_SECONDS, value);
  // An uncertain claim must not authorize a charge or remove another request. Queued all the same (NX: a request
  // already queued keeps its time), so an order whose write landed is settled by the sweep, not kept unseen.
  if (claim === "unknown") {
    await redisPipeline([["ZADD", QUEUE, "NX", now + ORDER_SETTLE_MS, record.id]]);
    return { ok: false, reason: "unavailable" };
  }
  if (claim === "taken") return heldBy(record.id, now);
  // Queued before the charge, so the sweep finds this order if nothing after the charge runs.
  const queued = repliesFor(await redisPipeline([["ZADD", QUEUE, now + ORDER_SETTLE_MS, record.id]]), 1);
  if (!queued || (queued[0] !== 0 && queued[0] !== 1)) {
    await releaseMark(key, value);
    return { ok: false, reason: "unavailable" };
  }

  const names = asked.languages.map((lang) => captionLabel(lang) ?? lang).join(", ");
  const sign = orderSign(record.id, order);
  const charged = await chargeNow({
    customerId: store.stripeCustomerId,
    subscriptionId: store.subscriptionId,
    cents,
    description: `AI captions for "${record.name}" (${minutes} min) in ${names}`,
    mark: sign,
    idempotencyKey: `nl-${sign}`,
  });
  let pi = "";
  let credit: Credit | undefined;
  if (charged.ok) {
    pi = charged.paymentIntent;
  } else {
    // No card: no invoice was made. Otherwise Stripe's invoice says what happened, never the error alone.
    const found = charged.reason === "card" ? "none" : await orderCharge(record.id, order, false);
    if (found === "none") {
      await releaseMark(key, value);
      return { ok: false, reason: charged.reason === "error" ? "unavailable" : charged.reason };
    }
    if (found === "unknown") return { ok: false, reason: "checking" };
    if ("pi" in found) pi = found.pi;
    else credit = { customer: store.stripeCustomerId, invoice: found.credit };
  }

  // Charged: recorded with its payment before anything else, and queued, so a refund is never lost.
  const pending: Pending = { langs: asked.languages, got: [], at: now, cents, pi, path: pathname, ...(credit ? { credit } : {}) };
  const written = JSON.stringify(pending);
  const wrote = repliesFor(await redisPipeline([
    ["SET", key, written, "EX", KEEP_SECONDS],
    ["ZADD", QUEUE, now + LOOK_FIRST_MS, record.id],
  ]), 2);
  if (!wrote || wrote[0] !== "OK" || (wrote[1] !== 0 && wrote[1] !== 1)) {
    // An answer lost is not a write lost (Claude 2 on #3286): read back, as claimMark does. Holding this record, the
    // write landed and the service is asked. Anything else (the order, or a read that does not read) is not known
    // written: the service is not asked, and the order or the record, both queued, refunds it.
    const back = repliesFor(await redisPipeline([["GET", key]]), 1);
    if (!back || back[0] !== written) return { ok: false, reason: "checking" };
  }

  const answer = await askStream("POST", `/videos/${record.id}/transcribe?force=true`, {
    sourceLanguage: asked.spoken,
    targetLanguages: asked.languages,
    generateTitle: false,
    generateDescription: false,
    generateChapters: false,
    generateMoments: false,
  });
  const success = (answer.data as { success?: unknown } | null)?.success;
  if (answer.status !== 200 || success === false) {
    console.error("the video service would not write captions", answer.status, answer.data);
    const refundKey = `nl-${sign}:refund`;
    if (await giveBack(pending, null, refundKey)) {
      await redisPipeline([["DEL", key]]);
      return { ok: false, reason: credit ? "credited" : "refunded" };
    }
    await owe(record.id, pending, null, refundKey, now);
    return { ok: false, reason: "refund_pending" };
  }
  return { ok: true, writing: asked.languages, cents };
}

/**
 * Why a video is held by another request: a refund owed, captions being
 * written, or an order whose charge is not settled yet. An order old enough
 * is settled here from Stripe's invoice, never charged again: paid, it is
 * refunded (nothing was asked of the service for it); never made or void, it
 * goes, and the next request is a new order.
 */
async function heldBy(id: string, now: number): Promise<AutoAnswer> {
  const held = repliesFor(await redisPipeline([["GET", pendingKey(id)]]), 1);
  if (!held) return { ok: false, reason: "unavailable" };
  const order = parseOrder(held[0]);
  if (!order) return { ok: false, reason: parsePending(held[0])?.owed ? "owed" : "busy" };
  if (now - order.at < ORDER_SETTLE_MS) return { ok: false, reason: "checking" };
  const settled = await settleOrder(id, held[0] as string, order, now);
  return { ok: false, reason: settled === "refund" ? "owed" : settled === "gone" ? "unavailable" : "checking" };
}

/**
 * What Stripe's invoices say became of an order's charge: its payment when the
 * invoice is paid, "none" when no charge was made or can be (never made, or
 * void), "unknown" otherwise. Only `final` (the order is ORDER_SETTLE_MS old)
 * takes an invoice not listed, or a draft, for none, and voids one left open.
 */
async function orderCharge(id: string, order: Order, final: boolean): Promise<{ pi: string } | { credit: string } | "none" | "unknown"> {
  const sign = orderSign(id, order);
  try {
    const query = new URLSearchParams({
      customer: order.customer,
      "created[gte]": String(Math.floor(order.at / 1000) - 120),
      "created[lte]": String(Math.floor((order.at + ORDER_SETTLE_MS) / 1000) + 120),
      limit: "100",
    });
    const listed = await onPlatformAt(CHARGE_READ_VERSION, "GET", `/invoices?${query}`);
    if (!listed || listed.object !== "list" || !Array.isArray(listed.data) || listed.has_more !== false) return "unknown";
    const rows = listed.data as unknown[];
    // A row that cannot be read may be this order's invoice.
    if (!rows.every((row) => row && typeof row === "object" && (row as { object?: unknown }).object === "invoice" && typeof (row as { id?: unknown }).id === "string")) return "unknown";
    const mine = (rows as Record<string, unknown>[]).filter((row) => (row.metadata as { mark?: unknown } | null | undefined)?.mark === sign);
    if (mine.length > 1) {
      console.error("more than one invoice carries a captions order's mark", id);
      return "unknown";
    }
    if (!mine.length) return final ? "none" : "unknown";
    const invoice = mine[0];
    if (invoice.customer !== order.customer || invoice.currency !== "usd") return "unknown";
    if (invoice.status === "paid") {
      const pi = invoice.payment_intent;
      if (typeof pi === "string" && /^pi_[A-Za-z0-9]{8,64}$/.test(pi)) return { pi };
      // Paid wholly from the credit balance (Claude 2 and Claude 6 on #3286): Stripe marks such an invoice paid when it
      // is finalized, with no payment, nothing due and nothing paid by card, for the whole price. Only exactly that.
      if (pi === null && invoice.amount_due === 0 && invoice.amount_paid === 0 && invoice.total === order.cents && typeof invoice.id === "string" && /^in_[A-Za-z0-9]{6,64}$/.test(invoice.id)) {
        return { credit: invoice.id };
      }
      return "unknown";
    }
    if (invoice.status === "void") return "none";
    if (!final) return "unknown";
    if (invoice.status === "draft") return "none";
    if (invoice.status === "open" || invoice.status === "uncollectible") {
      const voided = await onPlatformAt(CHARGE_READ_VERSION, "POST", `/invoices/${encodeURIComponent(String(invoice.id))}/void`, new URLSearchParams(), `nl-${sign}:void`);
      return voided?.id === invoice.id && voided.status === "void" ? "none" : "unknown";
    }
    return "unknown";
  } catch (error) {
    console.error("a captions order's invoice could not be read", id, error);
    return "unknown";
  }
}

/**
 * Settles an order ORDER_SETTLE_MS old from Stripe's invoice: paid, it is kept
 * as a refund owed in full and refunded by the sweep (collectRefund); none,
 * the order goes; unknown, it stays, looked at again further apart, and after
 * ORDER_LOOKS_MS it is kept for a person and no longer queued.
 */
async function settleOrder(id: string, raw: string, order: Order, now: number): Promise<"refund" | "gone" | "kept"> {
  const found = await orderCharge(id, order, true);
  if (found === "none") {
    // Not taken out of the queue here (Claude 2 on #3286): by the time this ends, a newer order may hold the video and
    // be queued under the same id. Left there, the entry is dropped by the sweep once it finds the video free.
    await releaseMark(pendingKey(id), raw);
    return "gone";
  }
  if (found !== "unknown") {
    const paid = "pi" in found ? { pi: found.pi } : { pi: "", credit: { customer: order.customer, invoice: found.credit } };
    const pending: Pending = { langs: order.langs, got: [], at: order.at, cents: order.cents, path: order.path, ...paid };
    await owe(id, pending, null, `nl-${orderSign(id, order)}:refund`, now);
    return "refund";
  }
  const age = now - order.at;
  if (age > ORDER_LOOKS_MS) {
    console.error("a captions charge could not be settled from Stripe after every automatic look; kept for a person", id);
    await redisPipeline([["ZREM", QUEUE, id]]);
    return "kept";
  }
  await redisPipeline([["ZADD", QUEUE, now + Math.min(REFUND_LOOK_MAX_MS, Math.max(LOOK_AGAIN_MS, age / 4)), id]]);
  return "kept";
}

/** The languages the service lists captions in, from its answer about a video. */
function deliveredIn(data: unknown): string[] {
  const list = (data as { captions?: unknown } | null)?.captions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c) => {
    const lang = (c as { srclang?: unknown } | null)?.srclang;
    return typeof lang === "string" ? [lang.toLowerCase().slice(0, 2)] : [];
  });
}

/**
 * Asks the service what it has written for one video, lists each language as
 * it arrives, and settles the request once it is all there, or refunds what
 * is not after GIVE_UP_HOURS.
 */
export async function syncAutoCaptions(id: string, now = Date.now()): Promise<"done" | "waiting" | "none"> {
  if (!STREAM_ID_PATTERN.test(id) || !isRedisConfigured()) return "none";
  const key = pendingKey(id);
  const read = repliesFor(await redisPipeline([["GET", key]]), 1);
  // Unread is not absent: the video stays queued (an order taken out of the queue would be found only by a retry).
  if (!read) return "waiting";
  const raw = read[0];
  const order = parseOrder(raw);
  if (order) {
    if (now - order.at < ORDER_SETTLE_MS) {
      await redisPipeline([["ZADD", QUEUE, order.at + ORDER_SETTLE_MS, id]]);
      return "waiting";
    }
    return (await settleOrder(id, raw as string, order, now)) === "gone" ? "done" : "waiting";
  }
  const pending = parsePending(raw);
  if (!pending) {
    if (raw !== "charging") await unqueue(id, raw, now);
    return "none";
  }
  if (pending.owed) return collectRefund(id, pending, pending.owed, now);
  const answer = await askStream("GET", `/videos/${id}`);
  if (answer.status === 404) {
    // The video is gone, deleted with its lesson: what was not written is given back.
    return (await settle(id, pending, pending.got, now)) ? "done" : "waiting";
  }
  if (answer.status !== 200) {
    await redisPipeline([["ZADD", QUEUE, now + LOOK_AGAIN_MS, id]]);
    return "waiting";
  }
  const there = deliveredIn(answer.data);
  const got = pending.langs.filter((lang) => there.includes(lang));
  const fresh = got.filter((lang) => !pending.got.includes(lang));
  if (fresh.length) await noteCaptionLanguages(id, fresh);
  // A language delivered at an earlier look stays delivered (R47): captions taken off since are not refunded.
  const delivered = pending.langs.filter((lang) => got.includes(lang) || pending.got.includes(lang));
  if (delivered.length === pending.langs.length || now - pending.at > GIVE_UP_HOURS * 3_600_000) {
    return (await settle(id, pending, delivered, now)) ? "done" : "waiting";
  }
  await redisPipeline([
    ["SET", key, JSON.stringify({ ...pending, got: delivered }), "EX", KEEP_SECONDS],
    ["ZADD", QUEUE, now + LOOK_AGAIN_MS, id],
  ]);
  return "waiting";
}

/**
 * Takes a video out of the queue once its key was read holding `left` (null: nothing there). A newer order or
 * record may have been written and queued between that read and the ZREM (Claude 2 on #3286, N1), so the key is read
 * again after it: still `left`, the video stays out; anything else, or a read that does not read exactly (rule 24),
 * and it is queued again (NX: an entry already back keeps its time), so a paid order is never left unqueued.
 */
async function unqueue(id: string, left: unknown, now: number): Promise<void> {
  await redisPipeline([["ZREM", QUEUE, id]]);
  const back = repliesFor(await redisPipeline([["GET", pendingKey(id)]]), 1);
  if (back && back[0] === left) return;
  await redisPipeline([["ZADD", QUEUE, "NX", back ? now : now + LOOK_AGAIN_MS, id]]);
}

/**
 * The request is over: a refund for each language that never came. The
 * record goes only once Stripe confirms the refund succeeded; otherwise what
 * is owed is kept and looked at again (collectRefund).
 */
async function settle(id: string, pending: Pending, got: string[], now: number): Promise<boolean> {
  const missing = pending.langs.length - got.length;
  if (missing > 0) {
    const cents = got.length === 0 ? null : Math.floor((pending.cents * missing) / pending.langs.length);
    if (cents === null || cents > 0) {
      const key = `nl-captions:${id}:${pending.at}:refund`;
      if (!(await giveBack(pending, cents, key))) {
        await owe(id, { ...pending, got }, cents, key, now);
        return false;
      }
    }
  }
  await redisPipeline([["DEL", pendingKey(id)]]);
  await unqueue(id, null, now);
  return true;
}

/** Gives back `cents` (null: all of it) of a charge: to the card it was paid with, or to the credit balance that paid it. True only when confirmed. */
async function giveBack(pending: Pending, cents: number | null, key: string): Promise<boolean> {
  return pending.credit ? creditBack(pending.credit, cents ?? pending.cents, pending.cents, key) : refundCharge(pending.pi, cents, key);
}

const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;
const INVOICE_PATTERN = /^in_[A-Za-z0-9]{6,64}$/;
/** The most pages of a customer's balance history read; one longer than that is not known whole. */
const CREDIT_HISTORY_PAGES = 10;

/**
 * What a captions charge paid from the balance already got back: the sum of every captions credit on the customer's
 * history carrying this invoice (`metadata[invoice]`), whatever path made it and under whatever key, as Stripe caps a
 * card refund at what was paid (Claude 6 on #3286). "unknown" when the history cannot be read whole or a row exactly
 * (rule 24): a row carrying the captions mark whose invoice, amount or currency does not read is never taken for
 * "not this invoice's", so a credit is never made twice.
 */
async function creditedFor(credit: Credit): Promise<number | "unknown"> {
  let after = "";
  let returned = 0;
  for (let page = 0; page < CREDIT_HISTORY_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (after) query.set("starting_after", after);
    const list = await onPlatformAt(CHARGE_READ_VERSION, "GET", `/customers/${credit.customer}/balance_transactions?${query}`);
    if (!list || list.object !== "list" || typeof list.has_more !== "boolean" || !Array.isArray(list.data) || list.data.length > 100) return "unknown";
    let last = "";
    for (const row of list.data as unknown[]) {
      if (!row || typeof row !== "object") return "unknown";
      const { id, amount, currency, metadata } = row as { id?: unknown; amount?: unknown; currency?: unknown; metadata?: unknown };
      if (typeof id !== "string" || !id) return "unknown";
      if (metadata !== null && (typeof metadata !== "object" || Array.isArray(metadata))) return "unknown";
      const fields = (metadata ?? {}) as Record<string, unknown>;
      const mark = fields.nl_captions_credit;
      if (mark !== undefined && typeof mark !== "string") return "unknown";
      if (typeof mark === "string") {
        if (typeof fields.invoice !== "string") return "unknown";
        if (fields.invoice === credit.invoice) {
          if (!Number.isSafeInteger(amount) || (amount as number) >= 0 || currency !== "usd") return "unknown";
          returned -= amount as number;
        }
      }
      last = id;
    }
    if (list.has_more === false) return returned;
    if (!last) return "unknown";
    after = last;
  }
  return "unknown";
}

/**
 * Puts back on the customer's credit balance what is owed of a charge paid from it (`cents`, never more than its
 * `total`), once: the balance history is read first for every captions credit already made for this invoice (one
 * whose answer was lost, one made by another path, even past Stripe's 24-hour idempotency window), and only what is
 * left is sent, under one idempotency key that follows the invoice and what it already got back, never the caller's.
 * Two paths at once ask for the same one. True only when the history shows enough back, or Stripe confirms exactly
 * what was left.
 */
async function creditBack(credit: Credit, cents: number, total: number, key: string): Promise<boolean> {
  if (!CUSTOMER_PATTERN.test(credit.customer) || !INVOICE_PATTERN.test(credit.invoice) || !Number.isSafeInteger(cents) || cents <= 0 || !Number.isSafeInteger(total) || total <= 0) return false;
  try {
    const returned = await creditedFor(credit);
    if (returned === "unknown") return false;
    const target = Math.min(cents, total);
    if (returned >= target) {
      if (returned > target) console.error("a captions charge paid from the credit balance already got back more than owed", credit.invoice);
      return true;
    }
    const left = target - returned;
    const body = new URLSearchParams({
      amount: String(-left),
      currency: "usd",
      description: "Refund of AI captions that were not written",
      "metadata[nl_captions_credit]": key,
      "metadata[invoice]": credit.invoice,
    });
    const made = await onPlatformAt(CHARGE_READ_VERSION, "POST", `/customers/${credit.customer}/balance_transactions`, body, `nl-captions-credit:${credit.invoice}:${returned}`);
    return made?.object === "customer_balance_transaction" && typeof made.id === "string" && made.amount === -left && made.currency === "usd" && made.customer === credit.customer;
  } catch (error) {
    console.error("a captions credit back was not confirmed", credit.invoice, error);
    return false;
  }
}

/** Keeps a refund that was not confirmed, and asks about it again in LOOK_AGAIN_MS. */
async function owe(id: string, pending: Pending, cents: number | null, key: string, now: number): Promise<void> {
  const owed: Owed = { cents, key, since: now, looks: 0 };
  console.error("a captions refund was not confirmed; it is kept and looked at again", id);
  const folder = readStreamPath(pending.path)?.folder;
  await redisPipeline([
    ["SET", pendingKey(id), JSON.stringify({ ...pending, owed }), "EX", REFUND_KEEP_SECONDS],
    ["ZADD", QUEUE, now + LOOK_AGAIN_MS, id],
    // Listed by store too, so a refund owed for a video since deleted is still shown.
    ...(folder ? [["SADD", owedKey(folder), id], ["EXPIRE", owedKey(folder), REFUND_KEEP_SECONDS]] : []),
  ]);
}

/** The store's listing lives as long as the record it points at. */
function keepListed(pending: Pending): (string | number)[][] {
  const parts = readStreamPath(pending.path);
  return parts ? [["SADD", owedKey(parts.folder), parts.id], ["EXPIRE", owedKey(parts.folder), REFUND_KEEP_SECONDS]] : [];
}

/** A refund owed is settled: the record and its listings go. */
async function closeOwed(id: string, pending: Pending, now: number): Promise<void> {
  const folder = readStreamPath(pending.path)?.folder;
  await redisPipeline([["DEL", pendingKey(id)], ...(folder ? [["SREM", owedKey(folder), id]] : [])]);
  await unqueue(id, null, now);
}

/**
 * One look at a refund owed: Stripe's own list of the payment's refunds
 * decides. Enough returned: done. One pending or waiting for an action: wait.
 * None in flight and not enough returned: ask for what is left, under a key
 * that follows what was listed (the first key while nothing was listed).
 * Unreadable, unconfirmed or still waiting: looked at again, at most
 * REFUND_LOOKS_MAX times; then kept, marked stuck, and no longer queued.
 */
async function collectRefund(id: string, pending: Pending, owed: Owed, now: number): Promise<"done" | "waiting"> {
  if (owed.stuck) {
    await redisPipeline([["ZREM", QUEUE, id]]);
    return "waiting";
  }
  if (await (pending.credit ? creditBack(pending.credit, owed.cents ?? pending.cents, pending.cents, owed.key) : cardRefundSettled(id, pending, owed))) {
    await closeOwed(id, pending, now);
    return "done";
  }
  const looks = owed.looks + 1;
  if (looks >= REFUND_LOOKS_MAX) {
    console.error("a captions refund is still not confirmed after every automatic look", id);
    await redisPipeline([
      ["SET", pendingKey(id), JSON.stringify({ ...pending, owed: { ...owed, looks, stuck: true } }), "EX", REFUND_KEEP_SECONDS],
      ["ZREM", QUEUE, id],
      ...keepListed(pending),
    ]);
    return "waiting";
  }
  await redisPipeline([
    ["SET", pendingKey(id), JSON.stringify({ ...pending, owed: { ...owed, looks } }), "EX", REFUND_KEEP_SECONDS],
    ...keepListed(pending),
    ["ZADD", QUEUE, now + Math.min(REFUND_LOOK_MAX_MS, LOOK_AGAIN_MS * 2 ** Math.min(looks, 10)), id],
  ]);
  return "waiting";
}

/** A refund to the card, as Stripe lists the payment's refunds: true once enough is returned. */
async function cardRefundSettled(id: string, pending: Pending, owed: Owed): Promise<boolean> {
  const listed = await refundsOnIntent(pending.pi);
  // Never more than the card paid: what an invoice took from a credit balance cannot go back to the card.
  const target = listed ? Math.min(owed.cents ?? pending.cents, listed.paid) : owed.cents ?? pending.cents;
  if (listed && listed.returned >= target) {
    if (target < (owed.cents ?? pending.cents)) console.error("a captions refund was capped at what the card paid; the rest was paid from a credit balance", id);
    return true;
  }
  if (!listed || listed.inFlight !== 0) return false;
  // The first key while Stripe lists nothing: had a refund been made under it, it would be listed.
  const fresh = listed.failed === 0 && listed.returned === 0 && target === (owed.cents ?? pending.cents);
  const left = target - listed.returned;
  return refundCharge(pending.pi, fresh ? owed.cents : left, fresh ? owed.key : `${owed.key}:${listed.failed}:${listed.returned}`);
}

/** The five-minute job's part: every video whose captions are due a look, until `deadline`. */
export async function sweepAutoCaptions(deadline: number, now = Date.now()): Promise<{ looked: number; done: number }> {
  const counts = { looked: 0, done: 0 };
  if (!isRedisConfigured() || !streamConfig()) return counts;
  const [due] = await redisPipeline([["ZRANGEBYSCORE", QUEUE, 0, now, "LIMIT", 0, 30]]);
  for (const id of Array.isArray(due) ? due : []) {
    if (Date.now() > deadline || typeof id !== "string") break;
    counts.looked += 1;
    if ((await syncAutoCaptions(id, now)) === "done") counts.done += 1;
  }
  return counts;
}

/** The languages still being written for each of these videos, by path. Videos with none are left out. */
export async function autoWriting(pathnames: string[]): Promise<Record<string, string[]>> {
  const wanted = pathnames.flatMap((path) => {
    const parts = readStreamPath(path);
    return parts ? [{ path, id: parts.id }] : [];
  });
  if (!wanted.length || !isRedisConfigured()) return {};
  const rows = await redisPipeline(wanted.map(({ id }) => ["GET", pendingKey(id)]));
  const out: Record<string, string[]> = {};
  wanted.forEach(({ path }, i) => {
    const pending = parsePending(rows[i]);
    // A request whose refund is owed is no longer being written.
    const left = pending && !pending.owed ? pending.langs.filter((lang) => !pending.got.includes(lang)) : [];
    if (left.length) out[path] = left;
  });
  return out;
}

/** Refunds for AI captions not yet confirmed by Stripe in one store folder, deleted videos included: cents owed and whether automatic looks have stopped. */
export async function autoRefundsOwed(folder: string): Promise<{ id: string; cents: number; stuck: boolean }[]> {
  if (!isRedisConfigured() || !/^[0-9a-f]{32}$/.test(folder)) return [];
  const [members] = await redisPipeline([["SMEMBERS", owedKey(folder)]]);
  const ids = (Array.isArray(members) ? members : []).filter((m): m is string => typeof m === "string" && STREAM_ID_PATTERN.test(m)).sort().slice(0, 100);
  if (!ids.length) return [];
  const rows = await redisPipeline(ids.map((id) => ["GET", pendingKey(id)]));
  return ids.flatMap((id, i) => {
    const pending = parsePending(rows[i]);
    return pending?.owed && readStreamPath(pending.path)?.folder === folder ? [{ id, cents: pending.owed.cents ?? pending.cents, stuck: pending.owed.stuck === true }] : [];
  });
}
