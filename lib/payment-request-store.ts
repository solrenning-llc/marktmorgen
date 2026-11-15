/**
 * Where payment requests are kept (lib/payment-request-rules.ts says what
 * one is), and the receipt a paid one gets.
 *
 *   nl:payreq:r:<id>               the request, as JSON, for KEEP_DAYS from the day it was made
 *   nl:payreq:s:<sid>              the store's requests: id -> when made
 *   nl:payreq:o:<sid>              the store's open requests: id -> when its link stops taking payment
 *   nl:payreq:p:<sid>:<person>     one person's requests in the store (lib/person-key.ts), for the cap and for deleting them
 *   nl:payreq:due                  reminders waiting: "<sid>|<id>" -> when due, read by the daily job
 *   nl:payreq:stores               stores with open requests, read by the five-minute job (lib/checkout-sweep.ts)
 *   nl:payreq:lock:<id>            a checkout being opened for it, a minute
 *   nl:payreq:w:<id>               its record being made or changed, ten seconds at the most
 *
 * Every request is counted in the store's data room before it is written
 * (lib/store-data.ts), at its record, its four index entries and what its
 * record can still grow by (RECORD_GROWTH_BYTES), in the month it expires
 * by itself. The counts (open, kept, per person) are taken the way a store
 * figure is: added, read back, and given back when over, so two at once can
 * never both pass a full count.
 *
 * Every change to a record is read again and written under its own lock
 * (changeRequest), so one hand never writes back what it read before another
 * hand's change: a reminder that was still being emailed, or a checkout still
 * being opened at Stripe, could otherwise put a paid request back to open
 * (docs/security-audit-2026-10-18.md, MM-SA-02). The write itself is fenced
 * (SAVE): it lands only while that lock still holds its writer's token, and a
 * change lands only over a record still there, so a hand held up past its
 * lock, or a record erased or deleted meanwhile, is never written back
 * (lib/person-erasure.ts). A request is made under its lock the same way.
 *
 * Nothing here is the record of a payment: that is the checkout and the
 * charge on the creator's own Stripe account, read by every door that asks
 * (lib/refunds.ts). What is kept here is what the creator asked for and
 * what became of it, so the studio can say it and the buyer's page can show it.
 */
import { personKey } from "@/lib/person-key";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { type Held, LockBusyError, releaseLock, takeLock, withLock } from "@/lib/redis-lock";
import { type Store } from "@/lib/store";
import { dataBytes } from "@/lib/store-data-rules";
import { takeData } from "@/lib/store-data";
import { sendEmail } from "@/lib/email";
import { requestWords } from "@/lib/buyer-words/requests";
import { speechFor } from "@/lib/buyer-words";
// Kept apart from the lock and reply helpers other work imports above, so the two never collide by name.
import * as exactReply from "@/lib/redis-reply";
import * as fencedLock from "@/lib/redis-lock";
import {
  ID_PATTERN,
  KEEP_DAYS,
  MAX_PER_PERSON,
  OPEN_DAYS,
  type PaymentRequest,
  type RequestDraft,
  newRequestId,
  nextReminderAt,
  parseRequest,
  requestLimitsFor,
  statusOf,
} from "@/lib/payment-request-rules";

const DAY = 86_400_000;
const recordKey = (id: string) => `nl:payreq:r:${id}`;
/** A request's own record, for the walk that closes a store's records (lib/closed-store-data.ts). */
export const requestRecordKey = recordKey;
const storeKey = (sid: string) => `nl:payreq:s:${sid}`;
const openKey = (sid: string) => `nl:payreq:o:${sid}`;
const personSet = (sid: string, email: string) => `nl:payreq:p:${sid}:${personKey(sid, email)}`;
const DUE = "nl:payreq:due";
const STORES = "nl:payreq:stores";
const lockKey = (id: string) => `nl:payreq:lock:${id}`;
const writeKey = (id: string) => `nl:payreq:w:${id}`;

/** What a record may still grow by after it is written: a checkout's id, a payment's, the times it was sent, a reason. */
export const RECORD_GROWTH_BYTES = 768;

const keepSeconds = (request: Pick<PaymentRequest, "createdAt">, now: number) => Math.max(60, Math.ceil((request.createdAt + KEEP_DAYS * DAY - now) / 1000));

/** What one request takes from the data room: its record and the entries that index it, rounded up, with room to grow. */
export function requestRoomBytes(request: PaymentRequest): number {
  return dataBytes([JSON.stringify(request), request.id, request.id, request.id, `${request.sid}|${request.id}`], 5) + RECORD_GROWTH_BYTES;
}

export type Created =
  | { ok: true; request: PaymentRequest }
  | { ok: false; reason: "open" | "kept" | "person" | "full" | "unavailable"; message: string };

const unavailable = (): Created => ({ ok: false, reason: "unavailable", message: "This can't be saved right now. Try again in a minute." });

/**
 * A request's record written in one step on the Redis side, only while its
 * write lock still holds the writer's token: "new" only when no record is
 * there yet, "edit" only over the record still there, with its open entry
 * and its reminder kept in step (an empty score takes the entry off). 1
 * written; 0 the lock is no longer the writer's; 2 the record is not as the
 * mode needs (already made, or gone: erased or deleted). The first line names
 * it for the local stand-in (lib/redis-memory.ts).
 */
const SAVE =
  '-- marktmorgen:payreq-save:v1\n' +
  'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end\n' +
  'local there = redis.call("EXISTS", KEYS[2])\n' +
  'if (ARGV[2] == "new" and there ~= 0) or (ARGV[2] ~= "new" and there ~= 1) then return 2 end\n' +
  'redis.call("SET", KEYS[2], ARGV[3], "EX", ARGV[4])\n' +
  'if ARGV[2] == "edit" then\n' +
  '  if ARGV[6] == "" then redis.call("ZREM", KEYS[3], ARGV[5]) else redis.call("ZADD", KEYS[3], ARGV[6], ARGV[5]) end\n' +
  '  if ARGV[8] == "" then redis.call("ZREM", KEYS[4], ARGV[7]) else redis.call("ZADD", KEYS[4], ARGV[8], ARGV[7]) end\n' +
  'end\n' +
  'return 1';

/**
 * Writes a request's record under its write lock (SAVE): "saved"; "lost" when
 * the lock ran out and may be another hand's, so nothing was written; "gone"
 * when the record is not as `mode` needs, so nothing was written either. A
 * reply of another shape throws UnknownReplyError (rule 24): never "saved".
 */
async function writeRecord(held: fencedLock.Held, request: PaymentRequest, mode: "new" | "edit", now: number): Promise<"saved" | "lost" | "gone"> {
  const member = `${request.sid}|${request.id}`;
  const open = mode === "edit" && statusOf(request, now) === "open" ? String(request.expiresAt) : "";
  const next = mode === "edit" ? nextReminderAt(request, now) : null;
  const reply = exactReply.repliesFor(
    await redisPipeline([[
      "EVAL", SAVE, 4, held.key, recordKey(request.id), openKey(request.sid), DUE,
      held.token, mode, JSON.stringify(request), keepSeconds(request, now), request.id, open, member, next === null ? "" : String(next),
    ]]),
    1,
  );
  const answer = reply?.[0];
  if (answer === 1) return "saved";
  if (answer === 0) return "lost";
  if (answer === 2) return "gone";
  throw new exactReply.UnknownReplyError("writing a payment request");
}

/** One request kept, within every count, before anything is sent. */
export async function createRequest(store: Store, draft: RequestDraft, now = Date.now()): Promise<Created> {
  if (!isRedisConfigured() || !store.sid) return unavailable();
  const limits = requestLimitsFor(store, now / 1000);
  if (limits.open <= 0) return { ok: false, reason: "open", message: "Payment requests need a plan, or a free trial, and a Stripe account that takes payments." };
  const request: PaymentRequest = {
    id: newRequestId(),
    sid: store.sid,
    ...draft,
    currency: store.currency,
    createdAt: now,
    expiresAt: now + OPEN_DAYS * DAY,
    state: "open",
    sent: [],
    failed: "",
    session: "",
    sessionAt: 0,
    paidAt: 0,
    amountPaid: 0,
    payment: "",
    refunded: 0,
    closedAt: 0,
  };
  const person = personSet(store.sid, draft.email);
  let held: fencedLock.Held | null = null;
  try {
    // A person's requests that are no longer kept leave their count first.
    const memberReply = await redisPipeline([["SMEMBERS", person]]);
    if (!Array.isArray(memberReply) || memberReply.length !== 1 || !Array.isArray(memberReply[0])) return unavailable();
    const members: unknown[] = memberReply[0];
    if (new Set(members).size !== members.length || !members.every((id) => typeof id === "string" && ID_PATTERN.test(id))) return unavailable();
    const ids = members as string[];
    if (ids.length) {
      const alive = await redisPipeline(ids.map((id) => ["EXISTS", recordKey(id)]));
      if (!Array.isArray(alive) || alive.length !== ids.length || !alive.every((value) => value === 0 || value === 1)) return unavailable();
      const gone = ids.filter((_, i) => alive[i] === 0);
      if (gone.length) await redisPipeline([["SREM", person, ...gone]]);
    }
    const keep = KEEP_DAYS * 86_400;
    // Its write lock, held from before its id is counted until its record is written: an erasure that finds the id
    // waits for the record and deletes it, and a creation held up past the lock writes nothing (writeRecord).
    held = await fencedLock.takeLock(writeKey(request.id), 10, 5_000);
    const counts = await redisPipeline([
      ["ZREMRANGEBYSCORE", openKey(store.sid), "-inf", String(now)],
      ["ZREMRANGEBYSCORE", storeKey(store.sid), "-inf", String(now - KEEP_DAYS * DAY)],
      ["ZADD", openKey(store.sid), String(request.expiresAt), request.id],
      ["ZADD", storeKey(store.sid), String(request.createdAt), request.id],
      ["SADD", person, request.id],
      ["ZCARD", openKey(store.sid)],
      ["ZCARD", storeKey(store.sid)],
      ["SCARD", person],
      ["EXPIRE", openKey(store.sid), keep],
      ["EXPIRE", storeKey(store.sid), keep],
      ["EXPIRE", person, keep],
    ]);
    // ZCARD and SCARD answer whole numbers from 0 up: anything else (null, "", a list, a reply cut short) is unknown
    // (rule 24), never 0, so a cap is never passed on a count that was not read.
    const exact = repliesFor(counts, 11);
    const count = (at: number) => (exact && typeof exact[at] === "number" && Number.isSafeInteger(exact[at]) && (exact[at] as number) >= 0 ? (exact[at] as number) : Number.NaN);
    const [open, kept, mine] = [count(5), count(6), count(7)];
    const undo = () => redisPipeline([["ZREM", openKey(store.sid), request.id], ["ZREM", storeKey(store.sid), request.id], ["SREM", person, request.id]]).catch(() => undefined);
    if (![open, kept, mine].every(Number.isSafeInteger)) {
      await undo();
      return unavailable();
    }
    if (open > limits.open) {
      await undo();
      return { ok: false, reason: "open", message: `Your store has ${limits.open.toLocaleString("en-US")} open requests, as many as your plan keeps open at once. Wait for one to be paid or expire, or cancel one.` };
    }
    if (kept > limits.kept) {
      await undo();
      return { ok: false, reason: "kept", message: `Your store keeps ${limits.kept.toLocaleString("en-US")} requests, as many as your plan keeps. Delete some you no longer need.` };
    }
    if (mine > MAX_PER_PERSON) {
      await undo();
      return { ok: false, reason: "person", message: `This person already has ${MAX_PER_PERSON} requests kept in your store. Delete some you no longer need.` };
    }
    // Its room, before it is written (lib/store-data.ts): it goes by itself after KEEP_DAYS.
    const room = await takeData(store, [{ until: request.createdAt + KEEP_DAYS * DAY, bytes: requestRoomBytes(request) }], now);
    if (!room.ok) {
      await undo();
      return room.reason === "full" ? { ok: false, reason: "full", message: room.message } : unavailable();
    }
    if ((await writeRecord(held, request, "new", now)) !== "saved") {
      await undo();
      return unavailable();
    }
    await redisPipeline([["SADD", STORES, store.sid]]);
    return { ok: true, request };
  } catch (error) {
    console.error("keeping a payment request failed", error);
    return unavailable();
  } finally {
    if (held) await fencedLock.releaseLock(held);
  }
}

/**
 * One request by its id, or null when its record is confirmed gone (GET answers exactly null). A reply cut short or
 * of another shape, or a record that is not a request, throws UnknownReplyError (rule 24), as reminderRequestOf does:
 * never the same null as a deleted request, which made a paid checkout's webhook skip the request, left open without
 * its receipt for the buyer to pay again.
 */
export async function readRequest(id: string): Promise<PaymentRequest | null> {
  if (!ID_PATTERN.test(id) || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", recordKey(id)]]), 1);
  if (!replies) throw new UnknownReplyError("a payment request's record");
  const [raw] = replies;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new UnknownReplyError("a payment request's record");
  let request: PaymentRequest | null;
  try {
    request = parseRequest(JSON.parse(raw));
  } catch {
    request = null;
  }
  if (!request) throw new UnknownReplyError("a payment request's record");
  return request;
}

/**
 * The daily reminder's read of one of this store's requests, exactly (rule 24):
 * null only when the record is confirmed absent (GET answered nil) or is
 * another store's. Any other reply (none, a number, an object, a record that
 * does not parse) throws UnknownReplyError, so the reminder is put off a day
 * rather than dropped for good; the record's own expiry (KEEP_DAYS) is what
 * at last makes it a real nil. Same one GET as readRequest.
 */
export async function reminderRequestOf(store: Pick<Store, "sid">, id: string): Promise<PaymentRequest | null> {
  if (!ID_PATTERN.test(id) || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", recordKey(id)]]), 1);
  if (!replies) throw new UnknownReplyError("a payment request's record");
  const [raw] = replies;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new UnknownReplyError("a payment request's record");
  let request: PaymentRequest | null;
  try {
    request = parseRequest(JSON.parse(raw));
  } catch {
    request = null;
  }
  if (!request) throw new UnknownReplyError("a payment request's record");
  return store.sid && request.sid === store.sid ? request : null;
}

/** One of this store's requests, or null: a request is only ever found under the store that made it. */
export async function requestOf(store: Pick<Store, "sid">, id: string): Promise<PaymentRequest | null> {
  const request = await readRequest(id);
  return request && store.sid && request.sid === store.sid ? request : null;
}

/**
 * The one way a request's record is changed after it is made: under its write
 * lock, `change` is handed the record as it is now and says what it becomes
 * (null leaves it as it is) and what to answer. Null when the request is not
 * one of this store's, or when its record was deleted (erased, or deleted by
 * the creator) before the change was written: nothing is written back. Throws
 * LockBusyError (lib/redis-lock.ts) when another change held it for longer
 * than five seconds, or when this change outlived its own lock: nothing was
 * written. A write that does not answer exactly throws UnknownReplyError.
 */
export async function changeRequest<T>(
  store: Pick<Store, "sid">,
  id: string,
  change: (current: PaymentRequest) => { next: PaymentRequest | null; answer: T },
  now = Date.now(),
): Promise<{ request: PaymentRequest; answer: T } | null> {
  if (!ID_PATTERN.test(id) || !isRedisConfigured()) return null;
  return withLock(writeKey(id), 10, 5_000, async (held) => {
    const current = await requestOf(store, id);
    if (!current) return null;
    const { next, answer } = change(current);
    if (next) {
      // Written back as it now is, for the rest of the days it is kept, its open entry and reminder in step.
      const written = await writeRecord(held, next, "edit", now);
      if (written === "gone") return null;
      if (written === "lost") throw new fencedLock.LockBusyError("a payment request's lock ran out before its change was written");
    }
    return { request: next ?? current, answer };
  });
}

/** The store's requests, newest first, at most its plan's kept figure; null when they cannot be read. */
export async function listRequests(store: Store, now = Date.now()): Promise<PaymentRequest[] | null> {
  if (!isRedisConfigured() || !store.sid) return null;
  try {
    const limit = Math.max(1, requestLimitsFor(store, now / 1000).kept, 20);
    const index = await redisPipeline([["ZREVRANGE", storeKey(store.sid), 0, limit - 1]]);
    if (!Array.isArray(index) || index.length !== 1 || !Array.isArray(index[0]) ||
        index[0].length > limit || new Set(index[0]).size !== index[0].length ||
        index[0].some(id => typeof id !== "string" || !ID_PATTERN.test(id))) return null;
    const list = index[0] as string[];
    if (!list.length) return [];
    const records = await redisPipeline([["MGET", ...list.map(recordKey)]]);
    if (!Array.isArray(records) || records.length !== 1 || !Array.isArray(records[0]) || records[0].length !== list.length) return null;
    const values = records[0];
    const out: PaymentRequest[] = [];
    const gone: string[] = [];
    list.forEach((id, i) => {
      const raw = values[i];
      let request: PaymentRequest | null = null;
      try {
        request = typeof raw === "string" ? parseRequest(JSON.parse(raw)) : null;
      } catch {
        request = null;
      }
      if (request && request.sid === store.sid && request.id === id) out.push(request);
      else if (raw === null) gone.push(id);
      else throw new Error("Payment request record unreadable");
    });
    if (gone.length) await redisPipeline([["ZREM", storeKey(store.sid), ...gone], ["ZREM", openKey(store.sid), ...gone]]);
    return out;
  } catch (error) {
    console.error("reading payment requests failed", error);
    return null;
  }
}

/**
 * One person's requests in the store, from their own set (at most
 * MAX_PER_PERSON, and twice that read at most): two commands whatever the
 * store keeps, for a page about one buyer (lib/buyer-waiting.ts). A record
 * gone is skipped; one that does not read as this store's is null, never a
 * guess.
 */
export async function requestsOfPerson(store: Pick<Store, "sid">, email: string): Promise<PaymentRequest[] | null> {
  if (!isRedisConfigured() || !store.sid) return null;
  try {
    const [members] = await redisPipeline([["SMEMBERS", personSet(store.sid, email)]]);
    if (!Array.isArray(members)) return null;
    const ids = members.map(String).filter((id) => ID_PATTERN.test(id)).slice(0, MAX_PER_PERSON * 2);
    if (!ids.length) return [];
    const [values] = await redisPipeline([["MGET", ...ids.map(recordKey)]]);
    if (!Array.isArray(values) || values.length !== ids.length) return null;
    const out: PaymentRequest[] = [];
    ids.forEach((id, i) => {
      const raw = values[i];
      if (raw === null) return;
      const request = typeof raw === "string" ? parseRequest(JSON.parse(raw)) : null;
      if (!request || request.sid !== store.sid || request.id !== id) throw new Error("Payment request record unreadable");
      out.push(request);
    });
    return out;
  } catch (error) {
    console.error("reading a person's payment requests failed", error);
    return null;
  }
}

/** How many of the store's requests are open now. */
export async function openCount(sid: string, now = Date.now()): Promise<number> {
  if (!isRedisConfigured() || !sid) throw new Error("Payment request count unavailable");
  const result = await redisPipeline([["ZREMRANGEBYSCORE", openKey(sid), "-inf", String(now)], ["ZCARD", openKey(sid)]]);
  if (!Array.isArray(result) || result.length !== 2 || !result.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) throw new Error("Payment request count could not be verified");
  return result[1] as number;
}

/** Withdraws an open request: its link stops taking payment and no reminder goes. */
export async function cancelRequest(store: Store, id: string, now = Date.now()): Promise<PaymentRequest | "not_open" | null> {
  const done = await changeRequest(store, id, (request) =>
    statusOf(request, now) !== "open" ? { next: null, answer: "not_open" as const } : { next: { ...request, state: "canceled", closedAt: now }, answer: "canceled" as const },
  now);
  if (!done) return null;
  return done.answer === "not_open" ? "not_open" : done.request;
}

/** Deletes a request that is no longer open from the store's list. Its payment, if any, stays on the creator's Stripe. */
export async function deleteRequest(store: Store, id: string, now = Date.now()): Promise<"deleted" | "open" | null> {
  const request = await requestOf(store, id);
  if (!request) return null;
  if (statusOf(request, now) === "open") return "open";
  await forget(request);
  return "deleted";
}

async function forget(request: PaymentRequest): Promise<void> {
  await redisPipeline([
    ["DEL", recordKey(request.id)],
    ["ZREM", storeKey(request.sid), request.id],
    ["ZREM", openKey(request.sid), request.id],
    ["ZREM", DUE, `${request.sid}|${request.id}`],
    ["SREM", personSet(request.sid, request.email), request.id],
  ]);
}

/**
 * Holds the request while a checkout is opened for it, so two presses at
 * once never open two payments side by side. What the press keeps to let
 * go of it, or null when it is not held (rule 24): held only on Redis's
 * exact "OK" to SET NX under this press's own token (lib/redis-lock.ts
 * takeLock); taken by another press, or a reply cut short or of another
 * shape, is not held, so the caller answers "busy" and opens nothing. No
 * waiting: a second press is answered at once.
 */
export async function holdForCheckout(id: string): Promise<Held | null> {
  try {
    return await takeLock(lockKey(id), 60, 0);
  } catch (error) {
    if (error instanceof LockBusyError) return null;
    throw error;
  }
}

/**
 * Lets go of the hold, only if it is still this press's own (one script,
 * lib/redis-lock.ts releaseLock): a press that ran past the lock's 60
 * seconds never deletes the lock the next press took since. Never throws;
 * a release that cannot run leaves the lock to run out at its expiry.
 */
export async function letGo(held: Held): Promise<void> {
  await releaseLock(held).catch(() => undefined);
}

/** A checkout as Stripe returns it, with what is read here. */
export type PaidSession = { id?: unknown; amount_total?: unknown; payment_intent?: unknown; created?: unknown };

const intentOf = (value: unknown): string =>
  typeof value === "string" ? value : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : "";

/**
 * Writes down that a request was paid, from a settled checkout of its own
 * on the creator's account. Once: a request already paid is answered as it
 * is. A payment that comes in after the request expired or was withdrawn
 * still paid it (its checkout was opened while it was open), so it is paid.
 */
export async function markPaid(store: Store, id: string, session: PaidSession, now = Date.now()): Promise<{ request: PaymentRequest; fresh: boolean } | null> {
  const done = await changeRequest(store, id, (request) => {
    if (request.state === "paid" || request.state === "refunded") return { next: null, answer: false };
    const paid: PaymentRequest = {
      ...request,
      state: "paid",
      paidAt: typeof session.created === "number" ? Math.min(now, session.created * 1000) : now,
      amountPaid: typeof session.amount_total === "number" ? session.amount_total : request.total,
      payment: intentOf(session.payment_intent).slice(0, 255),
      session: typeof session.id === "string" ? session.id.slice(0, 255) : request.session,
      failed: "",
      closedAt: now,
    };
    return { next: paid, answer: true };
  }, now);
  if (!done) return null;
  // 635 [GL3]: the first time it is written as paid, however that was learned, the workflow that starts on it,
  // for the person it was sent to, only while on the list (lib/payment-flow-trigger.ts; never throws). Loaded
  // here, not at the top, so the payment path and the workflows never load each other.
  if (done.answer) {
    const { paymentRequestPaid } = await import("@/lib/payment-flow-trigger");
    await paymentRequestPaid(store, done.request.email);
  }
  return { request: done.request, fresh: done.answer };
}

/** Requests whose reminder is due, at most `limit`, as "<sid>|<id>". */
export async function dueReminders(now = Date.now(), limit = 50): Promise<{ sid: string; id: string }[]> {
  if (!isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", DUE, "-inf", String(now), "LIMIT", 0, limit]]);
  return (Array.isArray(raw) ? raw.map(String) : []).flatMap((member) => {
    const [sid, id] = member.split("|");
    return sid && id && ID_PATTERN.test(id) ? [{ sid, id }] : [];
  });
}

/** Puts a reminder that could not go at a later time, so the job never tries it twice in a run. */
export async function delayReminder(sid: string, id: string, at: number): Promise<void> {
  await redisPipeline([["ZADD", DUE, String(at), `${sid}|${id}`]]).catch(() => undefined);
}

/** Takes a reminder off the list (its request is gone, or its store is). */
export async function dropReminder(sid: string, id: string): Promise<void> {
  await redisPipeline([["ZREM", DUE, `${sid}|${id}`]]).catch(() => undefined);
}

/** The stores with open requests, for the five-minute job. */
export async function storesWithRequests(): Promise<Set<string>> {
  if (!isRedisConfigured()) return new Set();
  const [raw] = await redisPipeline([["SMEMBERS", STORES]]);
  return new Set(Array.isArray(raw) ? raw.map(String) : []);
}

/** Leaves a store off that list once it has no open request. */
export async function settleStoreList(sid: string, now = Date.now()): Promise<void> {
  if ((await openCount(sid, now).catch(() => 1)) === 0) await redisPipeline([["SREM", STORES, sid]]).catch(() => undefined);
}

/** How many times an erasure reads the person's set again, for a request made while it ran. */
const FORGET_ROUNDS = 3;

/**
 * Deletes every request a store keeps for one person (lib/person-erasure.ts):
 * an open one is withdrawn by being deleted, so its link stops working and
 * no reminder goes. What they paid stays on the creator's Stripe account.
 * Answers how many were deleted.
 *
 * Exact (rule 24): the person's set is the only way to find their requests,
 * so it is read exactly, every member must be a request id, and every one is
 * erased however many there are. A reply of another shape throws
 * UnknownReplyError before anything is deleted (lib/person-erasure.ts then
 * says the erasure is not finished, and pressing again retries). Each request
 * goes under its write lock, the lock every change holds while it reads the
 * record and writes it back (changeRequest), so a change in progress finishes
 * first and cannot write the record back after it is gone; its record is
 * deleted first, and only then does its id leave the store's lists, the
 * reminders and the person's set, every count checked. So an id leaves the
 * set only with its record, and a retry still finds whatever is left. Only an
 * exact empty set is "nothing to erase".
 */
export async function forgetRequestsPerson(sid: string, email: string): Promise<number> {
  if (!isRedisConfigured() || !sid) return 0;
  const person = personSet(sid, email);
  let erased = 0;
  for (let round = 0; round < FORGET_ROUNDS; round += 1) {
    const listed = exactReply.repliesFor(await redisPipeline([["SMEMBERS", person]]), 1);
    const members = listed ? exactReply.stringList(listed[0]) : null;
    if (!members || new Set(members).size !== members.length || !members.every((id) => ID_PATTERN.test(id))) {
      throw new exactReply.UnknownReplyError("listing a person's payment requests");
    }
    if (!members.length) return erased;
    // Sorted, so two erasures of the same person take the locks in the same order.
    for (const id of [...members].sort()) {
      await forgetPersonRequest(sid, person, id);
      erased += 1;
    }
  }
  // Requests kept being made for them while this ran: not finished, and pressing again goes on.
  throw new Error("a person's payment requests kept changing during their erasure");
}

/** One of a person's requests: its record under its write lock, then its id out of every list, each count checked. */
async function forgetPersonRequest(sid: string, person: string, id: string): Promise<void> {
  const held = await fencedLock.takeLock(writeKey(id), 10, 5_000);
  try {
    // Only while the lock is still this erasure's: one held up past it deletes nothing and throws, and the id stays.
    if (!(await fencedLock.deleteIfHeldOnly(held, [recordKey(id)]))) throw new fencedLock.LockBusyError("a payment request's lock was lost before its erasure");
  } finally {
    await fencedLock.releaseLock(held);
  }
  const commands = [["ZREM", storeKey(sid), id], ["ZREM", openKey(sid), id], ["ZREM", DUE, `${sid}|${id}`], ["SREM", person, id]];
  const replies = exactReply.repliesFor(await redisPipeline(commands), commands.length);
  if (!replies?.every((reply) => {
    const n = exactReply.countOf(reply);
    return n !== null && n <= 1;
  })) throw new exactReply.UnknownReplyError("deleting a person's payment request");
}

/**
 * The paid request's receipt, emailed to the address it was sent to: what
 * was paid, to whom, when, and the link to its page, which shows the same
 * and can be printed. An order's email (lib/orders.ts counts it). Called
 * from the confirmation of a settled checkout (lib/purchase-email.ts), which
 * holds the once-only mark.
 */
export async function sendReceipt(input: { store: Store; request: PaymentRequest; base: string; from: string; idempotencyKey: string }): Promise<boolean> {
  const { store, request } = input;
  const said = speechFor(store.language, request.currency);
  const w = requestWords(store.language);
  const amount = said.money(request.amountPaid || request.total);
  const lines = request.lines.map((line) => `- ${line.text}${line.quantity > 1 ? ` × ${line.quantity}` : ""}: ${said.money(line.cents * line.quantity)}`);
  return sendEmail({
    meter: { by: "order" },
    from: input.from,
    to: request.email,
    replyTo: store.email,
    subject: w.receiptSubject(store.name, amount).slice(0, 180),
    text: [
      w.greeting(request.name),
      "",
      w.receiptLead(store.name, amount, said.date(request.paidAt || Date.now())),
      "",
      ...lines,
      "",
      `${w.reference}: ${request.payment || request.id}`,
      "",
      w.receiptLink,
      `${input.base}/pay/${request.id}`,
      "",
      w.statement(store.name),
      w.replyReaches(store.name),
      "",
      w.footer(store.name),
    ].join("\n"),
    idempotencyKey: input.idempotencyKey,
  });
}
