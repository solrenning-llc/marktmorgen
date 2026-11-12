/**
 * The Idempotency-Key header on the API's writes, kept (complement WG (a) of 616 [WP15], unit 2, 10 November 2026).
 * The rules are lib/api-idempotency-rules.ts; this file reads and keeps the record and wraps a write.
 *
 *   nl:api:idem:<store id>:<sha(key)>  JSON  the write under way, or its answer, for 24 hours from when it began
 *
 * The key the client sent is never in the name, only its hash. The store's id is, in clear, as in every other store
 * key (nl:api:keys:<store id>): it is no secret, and no store value goes into a fast hash. The record may hold the write's answer (an
 * address it gave a product to, say) for those 24 hours, then it is gone by itself. One record per keyed write; every
 * write is one of the plan's API requests, already counted and refused at the plan's figure before it gets here
 * (lib/api-guard.ts), so a store keeps at most its month's API figure of them, and fewer in any 24 hours.
 *
 * Wired, for now, only on POST /api/v1/access and POST /api/v1/leads. Without the header nothing changes. Since unit 3 an
 * answer about an address is listed under that address, and deleting the person deletes it at once.
 */
import { createHash } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import {
  IDEMPOTENCY_HEADER, IDEMPOTENCY_SECONDS, MAX_KEPT_ANSWER_BYTES, TOO_LARGE_WORDS, UNKNOWN_WORDS, type Effect, afterWrite, decide,
  readIdempotencyKey, requestFingerprint, takesKey,
} from "@/lib/api-idempotency-rules";

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
const recordName = (sid: string, hash: string) => `nl:api:idem:${sid}:${hash}`;
/**
 *   nl:api:idem:p:<store id>:<sha(address)>  sorted set  the records whose answer is about that address, each by the
 *                                             hash of its key and scored by when it ends (ms); and, for 24 hours after
 *                                             the person was deleted, ERASED_MARK
 *
 * (unit 3) so deleting a person from the store deletes those answers at once (forgetIdempotentPerson), instead of
 * leaving them until they expire. The name says the store, as every store key does, and never the address: only its
 * hash, and no store value goes into a fast hash. Each keep first drops the lines whose answer has ended, so the index
 * lists only answers still kept (review of #3542); it ends 24 hours after its latest keep.
 */
const personKey = (sid: string, email: string) => `nl:api:idem:p:${sid}:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
/**
 * The line an erasure leaves in the person's index, for 24 hours: a keyed write that passed the grant's check before
 * the person was deleted and lists its answer after the erasure read the index sees it and keeps nothing (review of
 * #3542). Never a key's hash (those are 64 hex).
 */
const ERASED_MARK = "erased";
/** How long past its end a line is still listed: a clock between the server and the database that runs apart by less than this never drops a line of an answer still kept. */
const LINE_SLACK_MS = 60_000;
/** The most records one person's index lists: every keyed write about them in 24 hours is one API request, and a month's figure is at most 10,000. */
const MAX_PERSON_RECORDS = 10_000;
/** Records deleted, and lines taken out of the index, per pipeline: no pipeline nears the database's request size. */
export const ERASE_BATCH = 500;
const isHash = (m: unknown): m is string => typeof m === "string" && /^[0-9a-f]{64}$/.test(m);
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "application/json" };
const answer = (status: number, error: string, message: string) => Response.json({ error, message }, { status, headers });

export type KeyedWrite = { response: Response; effect: Effect };

/**
 * Runs a write once per Idempotency-Key. `path` and `body` make the fingerprint (the body as the route parsed it, so
 * the same JSON sent with other spacing is the same request); `largest` is the most the write's answer can weigh.
 * Without the header, `run` runs as it always has. A repeat of a finished write gets its answer back, marked
 * `Idempotent-Replayed: true`, and runs nothing; anything unknown runs nothing.
 */
export async function onceForKey(request: Request, sid: string, path: string, body: unknown, largest: number, run: () => Promise<KeyedWrite>, person?: string, now = Date.now()): Promise<Response> {
  const read = readIdempotencyKey(request.headers.get(IDEMPOTENCY_HEADER));
  if (read.kind === "none") return (await run()).response;
  if (read.kind === "invalid") return answer(400, "idempotency_key", read.message);
  if (!takesKey(largest)) return answer(400, "idempotency_key", TOO_LARGE_WORDS);
  if (!sid) return answer(503, "unavailable", UNKNOWN_WORDS);
  const hash = keyHash(read.key);
  const rk = recordName(sid, hash);
  const fp = requestFingerprint(request.method, path, JSON.stringify(body ?? null));
  let decision = decide(await getRecord(rk), fp, now);
  if (decision.kind === "run" && decision.replaces !== undefined) {
    // Past its 24 hours yet still held: the database drops it within a second (it is kept exactly 24 hours from when
    // the write began), so this try runs nothing and is told to send the same key again.
    return answer(409, "idempotency_key", "A request with this Idempotency-Key is still being closed. Nothing was done this time. Send it again with the same key in a moment.");
  }
  if (decision.kind === "run") {
    // Claimed only where no record is: two tries at once, one claim takes.
    const claimed = await claim(rk, decision.claim);
    if (claimed === "unknown") return answer(503, "unavailable", UNKNOWN_WORDS);
    if (claimed === "taken") {
      // Another try claimed it first: what it holds now decides, and this one runs nothing.
      decision = decide(await getRecord(rk), fp, now);
      if (decision.kind === "run") return answer(409, "idempotency_key", "A request with this Idempotency-Key is being processed. Nothing was done this time.");
    }
  }
  if (decision.kind === "replay") return new Response(decision.body, { status: decision.status, headers: { ...headers, "Idempotent-Replayed": "true" } });
  if (decision.kind !== "run") return answer(decision.status, decision.kind === "unknown" ? "unavailable" : "idempotency_key", decision.message);
  // A write that throws may have acted: the claim stays, and a repeat is told 409, never run twice.
  const done = await run();
  const text = await done.response.clone().text();
  // A server error after a write that may have acted is not an answer to give back for 24 hours ("try again" would
  // then never work with this key): the claim is held instead, so a repeat is told 409 and runs nothing.
  const after = done.effect === "maybe" && done.response.status >= 500 ? { action: "hold" as const } : afterWrite(fp, now, done.response.status, text, done.effect);
  if (after.action === "release") await redisPipeline([["DEL", rk]]).catch(() => {});
  if (after.action === "keep") {
    // Kept until 24 hours after the write began, never longer.
    const left = Math.max(1, Math.ceil((now + IDEMPOTENCY_SECONDS * 1_000 - Date.now()) / 1_000));
    // The person's index first: an answer about an address is never kept where an erasure could not find it. In the
    // same pipeline, in this order: the lines whose answer has ended go, this answer is listed until it ends, the index
    // lives 24 hours more, and the erasure's mark is read. The answer is kept only when all four replies are exactly
    // as expected and no erasure has marked the person; otherwise the claim is held, so a repeat is told 409 and runs
    // nothing. An erasure that deletes this record between the listing and the keep leaves nothing to keep (XX).
    const pk = typeof person === "string" && person.trim() ? personKey(sid, person) : null;
    const indexed = pk
      ? repliesFor(await redisPipeline([
        ["ZREMRANGEBYSCORE", pk, "-inf", Date.now() - LINE_SLACK_MS],
        ["ZADD", pk, now + IDEMPOTENCY_SECONDS * 1_000, hash],
        ["EXPIRE", pk, IDEMPOTENCY_SECONDS],
        ["ZSCORE", pk, ERASED_MARK],
      ]).catch(() => null), 4)
      : null;
    const listed = pk === null || (indexed !== null && typeof indexed[0] === "number" && (indexed[1] === 0 || indexed[1] === 1) && indexed[2] === 1 && indexed[3] === null);
    if (listed) await redisPipeline([["SET", rk, after.record, "XX", "EX", left]]).catch(() => {});
  }
  return done.response;
}

/**
 * Deletes every kept answer about this address in this store (unit 3): the person's erasure (lib/person-erasure.ts)
 * calls it. Returns how many records went. Every reply is read exactly; an unknown one throws, so the erasure is
 * pressed again rather than said done.
 *
 * First, in one pipeline, the erasure's mark goes into the index (for 24 hours) and then the index is read: a keyed
 * write that lists its answer after this read sees the mark and keeps nothing. Then each batch of records is deleted,
 * and only once that is confirmed are exactly those lines taken out; a line listed after the read stays, so nothing is
 * ever kept unlisted (review of #3542). The index itself is left to end by itself, with the mark.
 */
export async function forgetIdempotentPerson(sid: string, email: string, now = Date.now()): Promise<number> {
  if (!sid || !email) return 0;
  const pk = personKey(sid, email);
  const read = repliesFor(await redisPipeline([
    ["ZADD", pk, now + IDEMPOTENCY_SECONDS * 1_000, ERASED_MARK],
    ["EXPIRE", pk, IDEMPOTENCY_SECONDS],
    ["ZRANGEBYSCORE", pk, "-inf", "+inf"],
  ]), 3);
  const members = read && (read[0] === 0 || read[0] === 1) && read[1] === 1 && Array.isArray(read[2]) && read[2].every((m) => typeof m === "string") ? (read[2] as string[]) : null;
  if (!members) throw new Error("the kept API answers of a person could not be read");
  // Only lines that name a record of this store: the index is the store's own, and a line is a key's hash.
  const ours = [...new Set(members.filter(isHash))];
  // More than the most a plan allows would mean a figure grew: refused out loud, never cut short in silence.
  if (ours.length > MAX_PERSON_RECORDS) throw new Error("a person has more kept API answers than any plan allows");
  let gone = 0;
  for (let i = 0; i < ours.length; i += ERASE_BATCH) {
    const batch = ours.slice(i, i + ERASE_BATCH);
    const deleted = repliesFor(await redisPipeline([["DEL", ...batch.map((h) => recordName(sid, h))]]), 1);
    if (!deleted || typeof deleted[0] !== "number" || !Number.isSafeInteger(deleted[0]) || deleted[0] < 0 || deleted[0] > batch.length) {
      throw new Error("the kept API answers of a person could not be deleted");
    }
    gone += deleted[0];
    const unlisted = repliesFor(await redisPipeline([["ZREM", pk, ...batch]]), 1);
    if (!unlisted || typeof unlisted[0] !== "number") throw new Error("the kept API answers of a person could not be deleted");
  }
  return gone;
}

/**
 * How many lines the person's index has, for the erasure's size (lib/person-erasure.ts erasureSize), read exactly:
 * the records forgetIdempotentPerson deletes are at most this many (and the mark of an earlier erasure, if any).
 */
export async function idempotentLines(sid: string, email: string): Promise<number> {
  if (!sid || !email) return 0;
  const read = repliesFor(await redisPipeline([["ZCARD", personKey(sid, email)]]), 1);
  if (!read || typeof read[0] !== "number" || !Number.isSafeInteger(read[0]) || read[0] < 0) throw new Error("the kept API answers of a person could not be counted");
  return read[0];
}

/** The record's exact reply: null when Redis says there is none, the string otherwise; any other shape is passed on as unknown. */
async function getRecord(rk: string): Promise<unknown> {
  const replies = repliesFor(await redisPipeline([["GET", rk]]).catch(() => null), 1);
  if (!replies) return undefined;
  return replies[0];
}

async function claim(rk: string, value: string): Promise<"ok" | "taken" | "unknown"> {
  const replies = repliesFor(await redisPipeline([["SET", rk, value, "NX", "EX", IDEMPOTENCY_SECONDS]]).catch(() => null), 1);
  if (replies && replies[0] === "OK") return "ok";
  if (replies && replies[0] === null) return "taken";
  // Unknown: the claim may have been written with its reply lost. This try runs nothing and answers 503, "send the same
  // request again with the same key", so a claim of exactly this value is let go first; otherwise that retry would be
  // told 409 for 24 hours (quality review on #3537). Only this exact value is deleted: it holds this request's
  // fingerprint and the millisecond this try began, so it is another try's only when that try sent the same key and
  // body in the same millisecond. Nothing runs either way.
  const read = repliesFor(await redisPipeline([["GET", rk]]).catch(() => null), 1);
  if (read && read[0] === value) await redisPipeline([["DEL", rk]]).catch(() => {});
  return "unknown";
}

/** The largest answer a keyed write here may give: what the rules keep. */
export const KEYED_WRITE_LARGEST = MAX_KEPT_ANSWER_BYTES;
