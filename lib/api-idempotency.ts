/**
 * The Idempotency-Key header on the API's writes, kept (complement WG (a) of 616 [WP15], unit 2, 10 November 2026).
 * The rules are lib/api-idempotency-rules.ts; this file reads and keeps the record and wraps a write.
 *
 *   nl:api:idem:<sha(store id, key)>  JSON  the write under way, or its answer, for 24 hours from when it began
 *
 * The key's name says neither the store nor the key: both are hashed. The record may hold the write's answer (an
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

const recordKey = (sid: string, key: string) => `nl:api:idem:${createHash("sha256").update(`${sid}\n${key}`).digest("hex")}`;
/**
 *   nl:api:idem:p:<sha(store id, address)>  set  the records whose answer is about that address, 24 hours
 *
 * (unit 3) so deleting a person from the store deletes those answers at once (forgetIdempotentPerson), instead of
 * leaving them until they expire. The name says neither the store nor the address.
 */
const personKey = (sid: string, email: string) => `nl:api:idem:p:${createHash("sha256").update(`${sid}\n${email.trim().toLowerCase()}`).digest("hex")}`;
/** The most records one person's index lists: every keyed write about them in 24 hours is one API request, and a month's figure is at most 10,000. */
const MAX_PERSON_RECORDS = 10_000;
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
  const rk = recordKey(sid, read.key);
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
    // The person's index first: an answer about an address is never kept where an erasure could not find it.
    const pk = typeof person === "string" && person.trim() ? personKey(sid, person) : null;
    const indexed = pk
      ? repliesFor(await redisPipeline([["SADD", pk, rk], ["EXPIRE", pk, IDEMPOTENCY_SECONDS]]).catch(() => null), 2)
      : [0, 1];
    // When the index could not be written, the answer is not kept and the claim is held, so a repeat is told 409.
    if (indexed && typeof indexed[0] === "number" && indexed[1] === 1) await redisPipeline([["SET", rk, after.record, "XX", "EX", left]]).catch(() => {});
  }
  return done.response;
}

/**
 * Deletes every kept answer about this address in this store (unit 3): the person's erasure (lib/person-erasure.ts)
 * calls it. Returns how many records went. Every reply is read exactly; an unknown one throws, so the erasure is
 * pressed again rather than said done.
 */
export async function forgetIdempotentPerson(sid: string, email: string): Promise<number> {
  if (!sid || !email) return 0;
  const pk = personKey(sid, email);
  const read = repliesFor(await redisPipeline([["SMEMBERS", pk]]), 1);
  const members = read && Array.isArray(read[0]) && read[0].every((m) => typeof m === "string") ? (read[0] as string[]) : null;
  if (!members) throw new Error("the kept API answers of a person could not be read");
  const ours = members.filter((m) => /^nl:api:idem:[0-9a-f]{64}$/.test(m)).slice(0, MAX_PERSON_RECORDS);
  const replies = repliesFor(await redisPipeline([...ours.map((m) => ["DEL", m]), ["DEL", pk]]), ours.length + 1);
  if (!replies || replies.some((r) => typeof r !== "number")) throw new Error("the kept API answers of a person could not be deleted");
  return (replies.slice(0, ours.length) as number[]).reduce((sum, n) => sum + n, 0);
}

/** The record's exact reply: null when Redis says there is none, the string otherwise; any other shape is passed on as unknown. */
async function getRecord(rk: string): Promise<unknown> {
  const replies = repliesFor(await redisPipeline([["GET", rk]]).catch(() => null), 1);
  if (!replies) return undefined;
  return replies[0];
}

async function claim(rk: string, value: string): Promise<"ok" | "taken" | "unknown"> {
  const replies = repliesFor(await redisPipeline([["SET", rk, value, "NX", "EX", IDEMPOTENCY_SECONDS]]).catch(() => null), 1);
  if (!replies) return "unknown";
  return replies[0] === "OK" ? "ok" : replies[0] === null ? "taken" : "unknown";
}

/** The largest answer a keyed write here may give: what the rules keep. */
export const KEYED_WRITE_LARGEST = MAX_KEPT_ANSWER_BYTES;
