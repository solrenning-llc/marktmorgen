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
 *
 * What the service delivered is read only from its answer in its own shape
 * (inventory of money calls, finding 9, rule 24): any other answer is unknown,
 * never "nothing delivered", and nothing is refunded on it (deliveredIn,
 * unknownLook). The same holds for its answer to the request to write them:
 * only a 4xx or a 2xx saying `success: false` is a refusal, refunded at once;
 * any other answer keeps the request for the sweep (finding R32).
 *
 * Only the service's own captions count as delivered (Claude 5 on #3427):
 * while a request holds a language (ordered, being written, or kept for a
 * person), a caption in it is not added or removed by hand (withOwnCaptions),
 * and a language once delivered stays delivered, so a caption by hand is never
 * charged as the AI's and what the AI never wrote is given back.
 *
 * A request kept for a person (what was delivered still unknown after every
 * automatic look) is marked `kept`: never shown as being written, never a
 * refund owed (none was decided), listed for its store apart with what was
 * charged (autoCaptionsMoney), and counted once, with the other cases kept for
 * a person, for the owner's monthly report (autoCaptionsKeptMonth).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor, stringList, UnknownReplyError } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { askStream, noteCaptionLanguages, streamCaptions, streamConfig, streamRecord } from "@/lib/stream";
import { readStreamPath, STREAM_ID_PATTERN } from "@/lib/stream-rules";
import { captionLabel } from "@/lib/captions";
import { chargeNow, isBillingConfigured, onPlatformAt, refundCharge, refundsOnIntent } from "@/lib/billing";
import type { Store } from "@/lib/store";
import { GIVE_UP_HOURS, MAX_AUTO_MINUTES, autoCaptionCents, chargedMinutes, readAutoAsk } from "@/lib/auto-captions-rules";

const pendingKey = (id: string) => `nl:stream:auto:${id}`;
/** Held while a caption in one language is added or removed by hand (withOwnCaptions), so no request for it starts meanwhile. */
const ownKey = (id: string, lang: string) => `nl:stream:auto:${id}:own:${lang}`;
/** How long a change by hand holds its language at the most: its calls to the service end long before. */
const OWN_HOLD_SECONDS = 120;
/** The videos of one store folder with captions money not settled: a refund owed, or a charge kept for a person. */
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
/**
 * Past GIVE_UP_HOURS, a request whose answer from the service stays unknown is looked at, further apart each time,
 * for this long; then kept for a person, never refunded on an unknown answer and never dropped.
 */
const DELIVERY_LOOKS_MS = 14 * 86_400_000;
/** Each month's counts of what was kept for a person, for the owner's report: numbers only, no store, no person. */
const keptMonthKey = (month: string) => `nl:stream:autokept:month:${month}`;
const KEPT_KINDS = ["delivery", "order", "refund"] as const;
type KeptKind = (typeof KEPT_KINDS)[number];
/** Counts one case kept for a person in the month it was kept (lib/paypal-payouts.ts countUnknown keeps its counts the same way). */
const countKept = (kind: KeptKind, now: number): (string | number)[][] => {
  const key = keptMonthKey(new Date(now).toISOString().slice(0, 7));
  return [["HINCRBY", key, kind, 1], ["EXPIRE", key, REFUND_KEEP_SECONDS]];
};
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
  /** When it was kept for a person: what the service delivered was still unknown after every automatic look (unknownLook). */
  kept?: number;
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
      ...(typeof value.kept === "number" && Number.isSafeInteger(value.kept) ? { kept: value.kept } : {}),
      ...(value.owed !== undefined ? { owed: parseOwed(value.owed) ?? { cents: null, key: `nl-captions:unreadable:${value.at}:refund`, since: value.at, looks: REFUND_LOOKS_MAX, stuck: true as const } } : {}),
    };
  } catch {
    return null;
  }
}

export type AutoAnswer =
  | { ok: true; writing: string[]; cents: number }
  | { ok: false; reason: "off" | "unknown" | "not_ready" | "language" | "long" | "busy" | "held" | "checking" | "owed" | "refund_pending" | "refunded" | "credited" | "plan" | "card" | "declined" | "unavailable" };

/** What captions for this video cost, by how many languages: its length as charged. Null when it cannot have them yet. */
export async function autoQuote(pathname: string): Promise<{ minutes: number; seconds: number } | null> {
  const record = await streamRecord(pathname);
  if (!record || record.state !== "ready" || !record.seconds) return null;
  return { minutes: chargedMinutes(record.seconds), seconds: record.seconds };
}

/**
 * Charges for captions in the languages asked, and asks the service to write
 * them. Nothing is charged unless all of it can be asked for; a request the
 * service refuses (a 4xx, or a 2xx saying `success: false`) is refunded at
 * once. Any other answer is unknown, never a refusal: the request is kept,
 * charged and queued, and the sweep uses it or gives it back on a known
 * answer.
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
  // A caption by hand in an asked language, in flight or landed since the read above, is never charged as the AI's:
  // read after the claim, so a change by hand either sees this order or is seen here (withOwnCaptions).
  const free = await askedFree(record.id, pathname, asked.languages);
  if (free !== "free") {
    await releaseMark(key, value);
    return { ok: false, reason: free === "language" ? "language" : "unavailable" };
  }
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
  // Only a stated refusal gives the charge back here (finding R32, Claude 5 on #3286, #3345 and #3346; rule 24): a
  // 4xx, or a 2xx saying `success: false`. Any other answer that is not a plain 200 (no answer, a request cut off, a
  // 5xx whatever its body says) is unknown: the service may be writing them, so nothing is given back on it and the
  // request stays as written above, charged and queued. The sweep settles it on an answer that says what was
  // delivered: used, or given back once after GIVE_UP_HOURS; a retry meanwhile is told they are being written and
  // charges nothing more.
  const refused = (answer.status >= 400 && answer.status < 500) || (answer.status >= 200 && answer.status < 300 && success === false);
  if (!refused && answer.status !== 200) {
    console.error("the video service's answer to writing captions is unknown; the request is kept and looked at, nothing given back on it", record.id, answer.status);
  }
  if (refused) {
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
 * Whether the asked languages are still free once the order holds the video: no change by hand to one of them in
 * flight (its hold, ownKey), none listed here since, and none the service itself lists. The service's own list is
 * read (its free GET /videos/<id>, read as the sweep reads it, deliveredIn), because a change by hand whose answer was
 * lost is not written down here and its hold runs out after OWN_HOLD_SECONDS, while the sweep counts every asked
 * language the service lists as the AI's (Claude 2's MEDIUM on #3427). A language it lists that is not written down
 * here is written down, so the studio lists what the player offers. Read exactly (rule 24): anything else, a 404
 * included, is "unknown", never free, and nothing is charged.
 */
async function askedFree(id: string, pathname: string, langs: string[]): Promise<"free" | "language" | "unknown"> {
  try {
    const holds = repliesFor(await redisPipeline(langs.map((lang) => ["GET", ownKey(id, lang)])), langs.length);
    if (!holds || holds.some((hold) => hold !== null)) return "unknown";
    const listed = ((await streamCaptions([pathname]))[pathname] ?? []).map((t) => t.lang);
    if (langs.some((lang) => listed.includes(lang))) return "language";
    const answer = await askStream("GET", `/videos/${id}`);
    const there = answer.status === 200 ? deliveredIn(answer.data) : null;
    if (!there) {
      console.error("the video service's list of a video's captions could not be read exactly; nothing charged", id, answer.status);
      return "unknown";
    }
    const landed = langs.filter((lang) => there.includes(lang));
    if (!landed.length) return "free";
    await noteCaptionLanguages(id, landed);
    return "language";
  } catch (error) {
    console.error("whether captions by hand are being changed for a video could not be read; nothing charged", id, error);
    return "unknown";
  }
}

/**
 * A change by hand to a video's captions in one language (`change`: added or removed), run only while no AI captions
 * request holds that language, so a caption by hand is never counted as delivered by the AI (Claude 5 on #3427).
 * Refused with "auto_writing" while a request holds it (its order, or captions not yet delivered in it), "auto_held"
 * while a request kept for a person holds it, "changing" while another change by hand in it holds it, and
 * "unavailable" when that cannot be read exactly (rule 24). A
 * request settled, owed a refund, or holding other languages lets it run. The language is held (ownKey) for the
 * change, so no request for it starts meanwhile (askedFree); the hold is let go when the change's outcome is known
 * (`known`), and otherwise kept until it runs out, since the service may still take it.
 */
export async function withOwnCaptions<T>(pathname: string, lang: string, change: () => Promise<T>, known: (result: T) => boolean): Promise<{ ok: true; result: T } | { ok: false; reason: "auto_writing" | "auto_held" | "changing" | "unavailable" }> {
  const parts = readStreamPath(pathname);
  // No request can hold a video that is not one, a language there is none of, or anything without the database.
  if (!parts || !STREAM_ID_PATTERN.test(parts.id) || !captionLabel(lang) || !isRedisConfigured()) return { ok: true, result: await change() };
  const own = ownKey(parts.id, lang);
  const value = claimValue();
  const claimed = await claimMark(own, OWN_HOLD_SECONDS, value);
  // Held by another change by hand in this language (in flight, or its answer lost): said so (Claude 2's LOW on
  // #3427). A claim that cannot be read is not known to be anyone's (rule 24).
  if (claimed === "taken") return { ok: false, reason: "changing" };
  if (claimed !== "ours") return { ok: false, reason: "unavailable" };
  let letGo = true;
  try {
    const read = repliesFor(await redisPipeline([["GET", pendingKey(parts.id)]]), 1);
    if (!read || (read[0] !== null && typeof read[0] !== "string")) return { ok: false, reason: "unavailable" };
    const raw = read[0];
    if (raw !== null) {
      const order = parseOrder(raw);
      const pending = order ? null : parsePending(raw);
      // Neither an order nor a request (one still being charged, or in no known shape): not known free.
      if (!order && !pending) return { ok: false, reason: "unavailable" };
      if (order && order.langs.includes(lang)) return { ok: false, reason: "auto_writing" };
      if (pending && !pending.owed && pending.langs.includes(lang) && !pending.got.includes(lang)) {
        return { ok: false, reason: pending.kept !== undefined ? "auto_held" : "auto_writing" };
      }
    }
    letGo = false;
    const result = await change();
    letGo = known(result);
    return { ok: true, result };
  } finally {
    if (letGo) await releaseMark(own, value);
  }
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
  if (!order) {
    const pending = parsePending(held[0]);
    return { ok: false, reason: pending?.owed ? "owed" : pending?.kept !== undefined ? "held" : "busy" };
  }
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
    const left = repliesFor(await redisPipeline([["ZREM", QUEUE, id]]), 1);
    // Counted the first time it leaves the queue; a reply that does not say it was not queued is counted too, so a charge kept for a person is never left out of the owner's report.
    if (!left || left[0] !== 0) await redisPipeline(countKept("order", now));
    return "kept";
  }
  await redisPipeline([["ZADD", QUEUE, now + Math.min(REFUND_LOOK_MAX_MS, Math.max(LOOK_AGAIN_MS, age / 4)), id]]);
  return "kept";
}

/**
 * The languages the service lists captions in, from its answer about a video: its `captions` list, every entry with
 * its language. Null when the answer is in any other shape (no list, a list of another type, an entry without a
 * language): what was delivered is then unknown, never "none", since captions it may have written must never be
 * refunded. A list the service answers empty is none delivered.
 */
function deliveredIn(data: unknown): string[] | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const list = (data as { captions?: unknown }).captions;
  if (!Array.isArray(list)) return null;
  const langs: string[] = [];
  for (const entry of list) {
    const lang = entry && typeof entry === "object" ? (entry as { srclang?: unknown }).srclang : undefined;
    if (typeof lang !== "string" || !lang) return null;
    langs.push(lang.toLowerCase().slice(0, 2));
  }
  return langs;
}

/**
 * Asks the service what it has written for one video, lists each language as
 * it arrives, and settles the request once it is all there, or refunds what
 * is not after GIVE_UP_HOURS, only on an answer that says what was delivered
 * (unknownLook has the rest).
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
  const there = answer.status === 200 ? deliveredIn(answer.data) : null;
  if (!there) return unknownLook(id, pending, raw as string, answer.status, now);
  // Delivered once is delivered: a language the service listed stays so if it is removed by hand later, and only the
  // service's own captions are listed in a language the request holds (withOwnCaptions).
  const got = pending.langs.filter((lang) => pending.got.includes(lang) || there.includes(lang));
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
 * Marks a request kept for a person only while its record is still the one read before asking the service, keeping
 * its time to live (the EXPIRE just before it): 1 marked, 0 changed or gone meanwhile, and nothing written over it.
 */
const MARK_KEPT = [
  "-- marktmorgen:auto-captions-kept:v1",
  'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end',
  'redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL")',
  "return 1",
].join("\n");

/**
 * The service's answer did not say what it delivered: not a 200, or a 200 in a
 * shape that is not its own. Nothing is listed or refunded on it, and the
 * languages already listed stay listed. Before GIVE_UP_HOURS the video is
 * asked about again as usual. Past it, a refund may be owed and captions may
 * have been delivered, so neither is decided: the record is kept as long as a
 * refund owed is (it would otherwise run out with what is owed), looked at
 * further apart, and settled by the first answer that says what was
 * delivered. After DELIVERY_LOOKS_MS it is kept for a person, said so, and no
 * longer queued; never refunded on an unknown answer, never dropped.
 *
 * Only the life of the record there now is extended (EXPIRE), never the copy
 * read before asking the service written back: the hook may have settled and
 * deleted it, or written a refund owed or a language listed, meanwhile. The
 * reply is read exactly (rule 24): 1 is kept, 0 is gone (settled elsewhere:
 * nothing is queued again), anything else is unknown and nothing else is
 * written. The one write into the record, the kept mark, lands only while it
 * is still the one read (MARK_KEPT), its reply read the same way.
 */
async function unknownLook(id: string, pending: Pending, raw: string, status: number, now: number): Promise<"waiting"> {
  const past = now - pending.at - GIVE_UP_HOURS * 3_600_000;
  if (status === 200) console.error("the video service answered about a video in a shape that does not say which captions it delivered; nothing is refunded on it", id);
  if (past <= 0) {
    await redisPipeline([["ZADD", QUEUE, now + LOOK_AGAIN_MS, id]]);
    return "waiting";
  }
  const kept = repliesFor(await redisPipeline([["EXPIRE", pendingKey(id), REFUND_KEEP_SECONDS]]), 1)?.[0];
  if (kept === 0) return "waiting";
  if (kept !== 1) throw new UnknownReplyError("keeping an AI captions request whose delivery is unknown");
  if (past > DELIVERY_LOOKS_MS) {
    console.error("which AI captions were delivered is still unknown after every automatic look; nothing refunded, the request kept for a person", id, status);
    // Marked kept the first time, only over the record read before asking the service (MARK_KEPT): one settled, owed
    // or listed meanwhile is never written over, and stays as it is now, with its place in the queue. Then it is listed
    // for its store and counted once for the owner's report; a later look (the service's announcement) keeps it as it is.
    const first = pending.kept === undefined;
    if (first) {
      const marked = repliesFor(await redisPipeline([["EVAL", MARK_KEPT, 1, pendingKey(id), raw, JSON.stringify({ ...(JSON.parse(raw) as object), kept: now })]]), 1)?.[0];
      if (marked === 0) return "waiting";
      if (marked !== 1) {
        // The mark may have landed: counted, so a case kept for a person is never left out of the owner's report.
        await redisPipeline(countKept("delivery", now));
        throw new UnknownReplyError("marking an AI captions request kept for a person");
      }
    }
    await redisPipeline([["ZREM", QUEUE, id], ...keepListed(pending), ...(first ? countKept("delivery", now) : [])]);
    return "waiting";
  }
  console.error("which AI captions were delivered is unknown past the give-up; nothing refunded, the request kept and looked at again", id, status);
  await redisPipeline([["ZADD", QUEUE, now + Math.min(REFUND_LOOK_MAX_MS, Math.max(LOOK_AGAIN_MS, past / 4)), id]]);
  return "waiting";
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
  // Out of its store's listing too, where a request kept for a person was listed; then out of the queue, unless a newer
  // record was written meanwhile (unqueue).
  const folder = readStreamPath(pending.path)?.folder;
  await redisPipeline([["DEL", pendingKey(id)], ...(folder ? [["SREM", owedKey(folder), id]] : [])]);
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
      // Once: a stuck refund is never looked at again (above).
      ...countKept("refund", now),
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

/**
 * The five-minute job's part: every video whose captions are due a look, until `deadline`. Each look is on its own:
 * one that fails is counted and said, stays due for the next run, moved behind the videos due before it (only if
 * still queued: XX), so a look that keeps failing never holds the head of the queue, and the rest are looked at. A
 * list of due videos that does not read is unknown (UnknownReplyError), never an empty queue.
 */
export async function sweepAutoCaptions(deadline: number, now = Date.now()): Promise<{ looked: number; done: number; failed: number }> {
  const counts = { looked: 0, done: 0, failed: 0 };
  if (!isRedisConfigured() || !streamConfig()) return counts;
  const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", QUEUE, 0, now, "LIMIT", 0, 30]]), 1);
  const due = replies ? stringList(replies[0]) : null;
  if (!due) throw new UnknownReplyError("the AI captions due a look");
  for (const id of due) {
    if (Date.now() > deadline) break;
    counts.looked += 1;
    try {
      if ((await syncAutoCaptions(id, now)) === "done") counts.done += 1;
    } catch (error) {
      counts.failed += 1;
      console.error("a look at a video's AI captions failed; it stays due for the next run", id, error);
      try {
        await redisPipeline([["ZADD", QUEUE, "XX", now, id]]);
      } catch (moveError) {
        console.error("a failed look at a video's AI captions keeps its place in the queue", id, moveError);
      }
    }
  }
  return counts;
}

/**
 * Where AI captions stand for each of these videos, by path, in one read: the languages still being written
 * (`writing`, videos with none left out) and the videos whose captions are kept for a person (`held`): never being
 * written, and never offered again until a person settles them.
 */
export async function autoCaptionStates(pathnames: string[]): Promise<{ writing: Record<string, string[]>; held: string[] }> {
  const wanted = pathnames.flatMap((path) => {
    const parts = readStreamPath(path);
    return parts ? [{ path, id: parts.id }] : [];
  });
  const writing: Record<string, string[]> = {};
  const held: string[] = [];
  if (!wanted.length || !isRedisConfigured()) return { writing, held };
  const rows = await redisPipeline(wanted.map(({ id }) => ["GET", pendingKey(id)]));
  wanted.forEach(({ path }, i) => {
    const pending = parsePending(rows[i]);
    // A request whose refund is owed is no longer being written; one kept for a person is not either.
    if (!pending || pending.owed) return;
    if (pending.kept !== undefined) {
      held.push(path);
      return;
    }
    const left = pending.langs.filter((lang) => !pending.got.includes(lang));
    if (left.length) writing[path] = left;
  });
  return { writing, held };
}

/** The languages still being written for each of these videos, by path. Videos with none are left out. */
export async function autoWriting(pathnames: string[]): Promise<Record<string, string[]>> {
  return (await autoCaptionStates(pathnames)).writing;
}

/**
 * The AI captions money not settled in one store folder, deleted videos included, read exactly (rule 24): refunds
 * Stripe has not confirmed (`owed`: cents owed and whether automatic looks have stopped), and charges kept for a
 * person (`unconfirmed`: what was charged; no refund was decided, since what the service delivered is unknown, so it
 * is never a refund owed, never refunded and never delivered). A list or a record in an unknown shape throws
 * UnknownReplyError, never "nothing owed"; a listed record confirmed gone is not listed.
 */
export async function autoCaptionsMoney(folder: string): Promise<{ owed: { id: string; cents: number; stuck: boolean }[]; unconfirmed: { id: string; cents: number }[] }> {
  const out: { owed: { id: string; cents: number; stuck: boolean }[]; unconfirmed: { id: string; cents: number }[] } = { owed: [], unconfirmed: [] };
  if (!isRedisConfigured() || !/^[0-9a-f]{32}$/.test(folder)) return out;
  const listed = repliesFor(await redisPipeline([["SMEMBERS", owedKey(folder)]]), 1);
  const members = listed ? stringList(listed[0]) : null;
  if (!members) throw new UnknownReplyError("the store's AI captions money not settled");
  const ids = members.filter((m) => STREAM_ID_PATTERN.test(m)).sort().slice(0, 100);
  if (!ids.length) return out;
  const rows = repliesFor(await redisPipeline(ids.map((id) => ["GET", pendingKey(id)])), ids.length);
  if (!rows) throw new UnknownReplyError("the store's AI captions money not settled");
  ids.forEach((id, i) => {
    const raw = rows[i];
    if (raw === null) return;
    if (typeof raw !== "string") throw new UnknownReplyError("an AI captions record");
    const pending = parsePending(raw);
    if (!pending || readStreamPath(pending.path)?.folder !== folder) return;
    if (pending.owed) out.owed.push({ id, cents: pending.owed.cents ?? pending.cents, stuck: pending.owed.stuck === true });
    else if (pending.kept !== undefined) out.unconfirmed.push({ id, cents: pending.cents });
  });
  return out;
}

/** Refunds for AI captions not yet confirmed by Stripe in one store folder, deleted videos included: cents owed and whether automatic looks have stopped. */
export async function autoRefundsOwed(folder: string): Promise<{ id: string; cents: number; stuck: boolean }[]> {
  return (await autoCaptionsMoney(folder)).owed;
}

/**
 * The month's counts of AI captions kept for a person, for the owner's monthly report (lib/company-margin-report.ts,
 * 465 [MR2], wired by its owner, as lib/paypal-payouts.ts payoutUnknownMonth): requests whose delivered captions
 * stayed unknown (`delivery`), charges Stripe's invoices never settled (`order`) and refunds Stripe never confirmed
 * (`refund`). Numbers only, no store, no person. Null when not read exactly: never zero.
 */
export async function autoCaptionsKeptMonth(month: string): Promise<Record<KeptKind, number> | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !isRedisConfigured()) return null;
  const reply = repliesFor(await redisPipeline([["HMGET", keptMonthKey(month), ...KEPT_KINDS]]), 1);
  const raw = reply ? repliesFor(reply[0], KEPT_KINDS.length) : null;
  if (!raw) return null;
  const counts = raw.map((v) => (v === null ? 0 : typeof v === "string" && /^(0|[1-9][0-9]{0,14})$/.test(v) ? Number(v) : NaN));
  if (!counts.every(Number.isSafeInteger)) return null;
  return { delivery: counts[0], order: counts[1], refund: counts[2] };
}
