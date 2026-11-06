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
 * A refund Stripe has not confirmed as succeeded is never taken as done: the
 * record is kept with what is owed (`owed`), the video is asked about again,
 * and each look first reads the payment's refunds from Stripe. A new refund
 * is asked for only when Stripe lists none still in flight and not enough
 * returned, under a key that follows what Stripe listed, so two looks at
 * once ask for the same one and money is never returned twice.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { askStream, noteCaptionLanguages, streamCaptions, streamConfig, streamRecord } from "@/lib/stream";
import { readStreamPath, STREAM_ID_PATTERN } from "@/lib/stream-rules";
import { captionLabel } from "@/lib/captions";
import { chargeNow, isBillingConfigured, refundCharge, refundsOnIntent } from "@/lib/billing";
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

type Pending = {
  /** The languages asked for, the one spoken first. */
  langs: string[];
  /** Those the service has delivered. */
  got: string[];
  /** When it was asked, in ms. */
  at: number;
  cents: number;
  /** The payment it was charged with, for a refund. */
  pi: string;
  path: string;
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
      ...(value.owed !== undefined ? { owed: parseOwed(value.owed) ?? { cents: null, key: `nl-captions:unreadable:${value.at}:refund`, since: value.at, looks: REFUND_LOOKS_MAX, stuck: true as const } } : {}),
    };
  } catch {
    return null;
  }
}

export type AutoAnswer =
  | { ok: true; writing: string[]; cents: number }
  | { ok: false; reason: "off" | "unknown" | "not_ready" | "language" | "long" | "busy" | "owed" | "refund_pending" | "refunded" | "plan" | "card" | "declined" | "unavailable" };

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
  const receipt = await redisPipeline([["SET", key, "charging", "NX", "EX", 300]]);
  // An uncertain claim must not authorize a charge or remove another request.
  if (!Array.isArray(receipt) || receipt.length !== 1) return { ok: false, reason: "unavailable" };
  if (receipt[0] === null) {
    // A refund still owed for this video holds it: say so, not that captions are being written.
    const [held] = await redisPipeline([["GET", key]]);
    return { ok: false, reason: parsePending(held)?.owed ? "owed" : "busy" };
  }
  if (receipt[0] !== "OK") return { ok: false, reason: "unavailable" };

  const cents = autoCaptionCents(record.seconds, asked.languages.length);
  const names = asked.languages.map((lang) => captionLabel(lang) ?? lang).join(", ");
  const sign = `captions:${record.id}:${now}`;
  const charged = await chargeNow({
    customerId: store.stripeCustomerId,
    subscriptionId: store.subscriptionId,
    cents,
    description: `AI captions for "${record.name}" (${minutes} min) in ${names}`,
    mark: sign,
    idempotencyKey: `nl-${sign}`,
  });
  if (!charged.ok) {
    await redisPipeline([["DEL", key]]);
    return { ok: false, reason: charged.reason === "error" ? "unavailable" : charged.reason };
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
    if (await refundCharge(charged.paymentIntent, null, refundKey)) {
      await redisPipeline([["DEL", key]]);
      return { ok: false, reason: "refunded" };
    } else {
      await owe(record.id, { langs: asked.languages, got: [], at: now, cents, pi: charged.paymentIntent, path: pathname }, null, refundKey, now);
      return { ok: false, reason: "refund_pending" };
    }
    return { ok: false, reason: "unavailable" };
  }
  const pending: Pending = { langs: asked.languages, got: [], at: now, cents, pi: charged.paymentIntent, path: pathname };
  await redisPipeline([
    ["SET", key, JSON.stringify(pending), "EX", KEEP_SECONDS],
    ["ZADD", QUEUE, now + LOOK_FIRST_MS, record.id],
  ]);
  return { ok: true, writing: asked.languages, cents };
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
  const [raw] = await redisPipeline([["GET", key]]);
  const pending = parsePending(raw);
  if (!pending) {
    if (raw !== "charging") await redisPipeline([["ZREM", QUEUE, id]]);
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
  if (got.length === pending.langs.length || now - pending.at > GIVE_UP_HOURS * 3_600_000) {
    return (await settle(id, pending, got, now)) ? "done" : "waiting";
  }
  await redisPipeline([
    ["SET", key, JSON.stringify({ ...pending, got }), "EX", KEEP_SECONDS],
    ["ZADD", QUEUE, now + LOOK_AGAIN_MS, id],
  ]);
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
      if (!(await refundCharge(pending.pi, cents, key))) {
        await owe(id, { ...pending, got }, cents, key, now);
        return false;
      }
    }
  }
  await redisPipeline([["DEL", pendingKey(id)], ["ZREM", QUEUE, id]]);
  return true;
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
async function closeOwed(id: string, pending: Pending): Promise<void> {
  const folder = readStreamPath(pending.path)?.folder;
  await redisPipeline([["DEL", pendingKey(id)], ["ZREM", QUEUE, id], ...(folder ? [["SREM", owedKey(folder), id]] : [])]);
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
  const listed = await refundsOnIntent(pending.pi);
  // Never more than the card paid: what an invoice took from a credit balance cannot go back to the card.
  const target = listed ? Math.min(owed.cents ?? pending.cents, listed.paid) : owed.cents ?? pending.cents;
  if (listed && listed.returned >= target) {
    if (target < (owed.cents ?? pending.cents)) console.error("a captions refund was capped at what the card paid; the rest was paid from a credit balance", id);
    await closeOwed(id, pending);
    return "done";
  }
  if (listed && listed.inFlight === 0) {
    // The first key while Stripe lists nothing: had a refund been made under it, it would be listed.
    const fresh = listed.failed === 0 && listed.returned === 0 && target === (owed.cents ?? pending.cents);
    const left = target - listed.returned;
    const cents = fresh ? owed.cents : left;
    const key = fresh ? owed.key : `${owed.key}:${listed.failed}:${listed.returned}`;
    if (await refundCharge(pending.pi, cents, key)) {
      await closeOwed(id, pending);
      return "done";
    }
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

/**
 * Refunds for AI captions not yet confirmed by Stripe in one store folder, deleted videos included: cents owed and
 * whether automatic looks have stopped. A reply in an unknown shape throws UnknownReplyError, never "none owed"
 * (CX-123 rules 24 and 30): money owed is never hidden by a read that failed. A record gone (expired) is not owed.
 */
export async function autoRefundsOwed(folder: string): Promise<{ id: string; cents: number; stuck: boolean }[]> {
  if (!isRedisConfigured() || !/^[0-9a-f]{32}$/.test(folder)) return [];
  const members = stringList(repliesFor(await redisPipeline([["SMEMBERS", owedKey(folder)]]), 1)?.[0]);
  if (!members || !members.every((m) => STREAM_ID_PATTERN.test(m))) throw new UnknownReplyError("the caption refunds owed to a store");
  const ids = members.sort().slice(0, 100);
  if (!ids.length) return [];
  const rows = repliesFor(await redisPipeline(ids.map((id) => ["GET", pendingKey(id)])), ids.length);
  if (!rows) throw new UnknownReplyError("the caption refunds owed to a store");
  return ids.flatMap((id, i) => {
    if (rows[i] === null) return [];
    const pending = parsePending(rows[i]);
    if (!pending) throw new UnknownReplyError("a caption refund owed to a store");
    return pending?.owed && readStreamPath(pending.path)?.folder === folder ? [{ id, cents: pending.owed.cents ?? pending.cents, stuck: pending.owed.stuck === true }] : [];
  });
}
