/**
 * Events for the creator's webhooks that could not be queued when they happened, kept and tried again (#4284, #4275).
 *
 * Some events are noticed once and by nothing else: a free copy's confirmed address (`lead.captured`, the free
 * download route) and a confirmed list sign-up (`list.joined`, the join confirmation). When emitEvent
 * (lib/webhooks.ts) could not record such an event (its once-only mark or its deliveries not written, a Redis
 * answer that could not be read), the route only logged it and went on, and the creator's integration never heard
 * of the lead. Now the event is kept here and the five-minute job (app/api/cron/mail) gives it to emitEvent again
 * until it is queued. The event's id is made from its seed (eventIdFor), so a replay never sends it twice.
 *
 *   nl:hookout:<event id>   the event as it was asked for: the store, the type, the seed and the data (JSON), at
 *                           most OUTBOX_RECORD_MAX_BYTES, kept OUTBOX_KEEP_SECONDS (a week, as a delivery is)
 *   nl:hookout:due          sorted set: event id → when it is next tried
 *
 * Each record names one person (the data's `email`): it expires within the week its delivery would have been kept
 * (lib/person-data.ts), and a replay first asks whether that person was deleted from the store, read exactly
 * (lib/suppression.ts); deleted, or the store gone, the event is let go and never sent. An answer that cannot be
 * read tries again later, never sends on a guess.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { type Store } from "@/lib/store";
import { storeForIdExactly } from "@/lib/store-exact";
import { suppressedAmongCommand, wholeErasedReply } from "@/lib/suppression";
import { type WebhookEvent, emitEvent, eventIdFor } from "@/lib/webhooks";

/** How long a kept event is tried again: the week a delivery is kept (lib/webhooks.ts, lib/person-data.ts). */
export const OUTBOX_KEEP_SECONDS = 7 * 86_400;
/** The most one kept event's record may hold; a bigger one is not kept (and said). */
export const OUTBOX_RECORD_MAX_BYTES = 4_096;
/** Kept events one run of the job tries, at the most. */
export const OUTBOX_PER_RUN = 50;
/** The first wait before a kept event is tried again; each later try waits twice as long, never past a day. */
export const OUTBOX_FIRST_WAIT_SECONDS = 300;
/**
 * Commands one kept event costs the job, at the most, besides emitEvent's own: the record's GET, the deleted
 * person's HMGET, the store's two exact reads (lib/store-exact.ts), and its DEL and ZREM, or a SET and a ZADD to
 * wait again. And the job's own ZRANGEBYSCORE once a run.
 */
export const OUTBOX_COMMANDS_PER_EVENT = 6;
export const OUTBOX_JOB_COMMANDS = 1;

const DUE = "nl:hookout:due";
const recordKey = (eventId: string) => `nl:hookout:${eventId}`;
const EVENT_ID = /^evt_[0-9a-f]{32}$/;

type Kept = { sid: string; type: WebhookEvent; seed: string; data: Record<string, unknown>; at: number; tries: number };

function readKept(raw: unknown): Kept | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Kept> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { sid, type, seed, data, at, tries } = value;
    if (typeof sid !== "string" || typeof type !== "string" || typeof seed !== "string" || !data || typeof data !== "object" || Array.isArray(data)) return null;
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(tries) || (tries as number) < 0) return null;
    return { sid, type: type as WebhookEvent, seed, data: data as Record<string, unknown>, at: at as number, tries: tries as number };
  } catch {
    return null;
  }
}

const waitFor = (tries: number) => Math.min(86_400, OUTBOX_FIRST_WAIT_SECONDS * 2 ** Math.min(tries, 10));

/**
 * Tells the creator's webhooks of an event noticed only once, now; and when that could not be recorded, keeps it to
 * be tried again by the job. Never throws: a route that hands a buyer their file or confirms their sign-up goes on.
 * Answers how it went: "sent" (queued now, or already sent before), "kept" (to be tried again) or "lost" (neither
 * could be written; said in the log).
 */
export async function emitOrKeep(store: Store, type: WebhookEvent, seed: string, data: Record<string, unknown>, now = Date.now()): Promise<"sent" | "kept" | "lost"> {
  try {
    await emitEvent(store, type, seed, data, now);
    return "sent";
  } catch (error) {
    console.error(`queueing the ${type} webhook failed; kept to be tried again`, error);
  }
  if (!store.statsId || !store.sid || !isRedisConfigured()) return "lost";
  const eventId = eventIdFor(store.statsId, type, seed);
  const record = JSON.stringify({ sid: store.sid, type, seed, data, at: now, tries: 0 } satisfies Kept);
  if (Buffer.byteLength(record) > OUTBOX_RECORD_MAX_BYTES) {
    console.error(`a ${type} webhook could not be queued and is too big to keep; it is not sent`);
    return "lost";
  }
  try {
    const replies = repliesFor(
      await redisPipeline([
        ["SET", recordKey(eventId), record, "NX", "EX", OUTBOX_KEEP_SECONDS],
        ["ZADD", DUE, Math.floor(now / 1000) + OUTBOX_FIRST_WAIT_SECONDS, eventId],
      ]),
      2,
    );
    // Kept when the record is written (or already was, by an earlier try of the same event) and the date is in.
    if (replies && (replies[0] === "OK" || replies[0] === null) && (countOf(replies[1]) === 0 || countOf(replies[1]) === 1)) return "kept";
  } catch (error) {
    console.error(`keeping a ${type} webhook to try again failed`, error);
    return "lost";
  }
  console.error(`keeping a ${type} webhook to try again was answered in an unknown shape`);
  return "lost";
}

/** Lets a kept event go: its record and its place in line. */
async function forget(eventId: string): Promise<void> {
  await redisPipeline([["DEL", recordKey(eventId)], ["ZREM", DUE, eventId]]);
}

/**
 * The five-minute job's pass: each kept event that is due is given to emitEvent again, at most OUTBOX_PER_RUN a run
 * and never past `deadline`. Queued (or already sent): let go. Its person deleted from the store, its store gone, or
 * its record expired or unreadable: let go, nothing sent. Not queued again, or a question that could not be read:
 * tried later, waiting twice as long each time, until its week is over.
 */
export async function replayKept(deadline: number, now = Date.now()): Promise<{ tried: number; sent: number; dropped: number; later: number }> {
  const out = { tried: 0, sent: 0, dropped: 0, later: 0 };
  if (!isRedisConfigured()) return out;
  const nowSeconds = Math.floor(now / 1000);
  const listed = repliesFor(await redisPipeline([["ZRANGEBYSCORE", DUE, 0, nowSeconds, "LIMIT", 0, OUTBOX_PER_RUN]]), 1)?.[0];
  if (!Array.isArray(listed)) {
    console.error("the kept webhook events could not be listed; tried next run");
    return out;
  }
  for (const id of listed) {
    if (Date.now() >= deadline) break;
    if (typeof id !== "string" || !EVENT_ID.test(id)) {
      await redisPipeline([["ZREM", DUE, String(id)]]);
      continue;
    }
    out.tried += 1;
    try {
      const [raw] = repliesFor(await redisPipeline([["GET", recordKey(id)]]), 1) ?? [undefined];
      // Expired with its week, or never readable: nothing to send.
      if (raw === null || (raw !== undefined && !readKept(raw))) {
        await forget(id);
        out.dropped += 1;
        continue;
      }
      const kept = raw === undefined ? null : readKept(raw);
      if (!kept) throw new Error("a kept webhook event could not be read");
      const store = await storeForIdExactly(kept.sid);
      if (store === "unknown") throw new Error("a kept webhook event's store could not be read");
      // The store is gone, or its address changed hands: what was kept is not this store's to send.
      if (store === "none" || !store.statsId || eventIdFor(store.statsId, kept.type, kept.seed) !== id) {
        await forget(id);
        out.dropped += 1;
        continue;
      }
      // Never sent about a person deleted from the store since (lib/suppression.ts), read exactly: unknown waits.
      const email = typeof kept.data.email === "string" ? kept.data.email : "";
      if (email && store.listId) {
        const [reply] = repliesFor(await redisPipeline([suppressedAmongCommand(store.listId, [email])]), 1) ?? [undefined];
        const [print] = wholeErasedReply(reply, 1);
        if (print !== null) {
          await forget(id);
          out.dropped += 1;
          continue;
        }
      }
      await emitEvent(store, kept.type, kept.seed, kept.data, now);
      await forget(id);
      out.sent += 1;
    } catch (error) {
      console.error("trying a kept webhook event again failed; tried later", error);
      out.later += 1;
      const [raw] = await redisPipeline([["GET", recordKey(id)]]).catch(() => [undefined]);
      const kept = readKept(raw);
      const tries = (kept?.tries ?? 0) + 1;
      await redisPipeline([
        ...(kept ? [["SET", recordKey(id), JSON.stringify({ ...kept, tries }), "XX", "KEEPTTL"] as (string | number)[]] : []),
        ["ZADD", DUE, "XX", nowSeconds + waitFor(tries), id],
      ]).catch(() => undefined);
    }
  }
  return out;
}
