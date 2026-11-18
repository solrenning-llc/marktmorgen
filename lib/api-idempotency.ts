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
 * Wired, for now, only on POST /api/v1/access and POST /api/v1/leads. Without the header nothing changes.
 *
 * A person deleted from the store after a write was answered is never named again by a repeat of it (Codex X7 on
 * #3537): the repeat carries the same request, so the same address, which is read against the store's deletion prints
 * (lib/suppression.ts) before an answer is given back. Deleted since: the kept answer is written over with one that
 * names nobody, and the repeat is told so, running nothing.
 */
import { createHash } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { suppressedAtCommand } from "@/lib/suppression";
import {
  IDEMPOTENCY_HEADER, IDEMPOTENCY_SECONDS, MAX_KEPT_ANSWER_BYTES, TOO_LARGE_WORDS, UNKNOWN_WORDS, type Effect, afterWrite, decide,
  readIdempotencyKey, requestFingerprint, takesKey,
} from "@/lib/api-idempotency-rules";

const recordKey = (sid: string, key: string) => `nl:api:idem:${sid}:${createHash("sha256").update(key).digest("hex")}`;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "application/json" };
const answer = (status: number, error: string, message: string) => Response.json({ error, message }, { status, headers });

export type KeyedWrite = { response: Response; effect: Effect };

/**
 * Runs a write once per Idempotency-Key. `path` and `body` make the fingerprint (the body as the route parsed it, so
 * the same JSON sent with other spacing is the same request); `largest` is the most the write's answer can weigh.
 * Without the header, `run` runs as it always has. A repeat of a finished write gets its answer back, marked
 * `Idempotent-Replayed: true`, and runs nothing; anything unknown runs nothing.
 */
export async function onceForKey(request: Request, sid: string, path: string, body: unknown, largest: number, run: () => Promise<KeyedWrite>, now = Date.now(), listId: string | null | undefined = undefined): Promise<Response> {
  const read = readIdempotencyKey(request.headers.get(IDEMPOTENCY_HEADER));
  if (read.kind === "none") return (await run()).response;
  if (read.kind === "invalid") return answer(400, "idempotency_key", read.message);
  if (!takesKey(largest)) return answer(400, "idempotency_key", TOO_LARGE_WORDS);
  if (!sid) return answer(503, "unavailable", UNKNOWN_WORDS);
  const rk = recordKey(sid, read.key);
  const fp = requestFingerprint(request.method, path, JSON.stringify(body ?? null));
  let found = await getRecord(rk);
  let decision = decide(found, fp, now);
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
      found = await getRecord(rk);
      decision = decide(found, fp, now);
      if (decision.kind === "run") return answer(409, "idempotency_key", "A request with this Idempotency-Key is being processed. Nothing was done this time.");
    }
  }
  if (decision.kind === "replay") {
    const gone = await deletedSinceWrite(listId, body, found);
    if (gone === "unknown") return answer(503, "unavailable", UNKNOWN_WORDS);
    if (gone) {
      // The kept answer named somebody deleted since: written over with one that names nobody, for what is left of
      // its 24 hours, so the address is not kept here either, and nothing runs again under this key.
      await withhold(rk, found);
      return answer(409, "idempotency_key", DELETED_WORDS);
    }
    return new Response(decision.body, { status: decision.status, headers: { ...headers, "Idempotent-Replayed": "true" } });
  }
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
    await redisPipeline([["SET", rk, after.record, "XX", "EX", left]]).catch(() => {});
  }
  return done.response;
}

/** What a repeat is told when the person its write named was deleted from the store after it was answered. */
export const DELETED_WORDS = "The person this request named was deleted from the store after it was answered, so the answer is not given back. Nothing was done this time.";

/**
 * Whether the address the request names (`email`) was deleted from this store at or after the second its kept write
 * began: "unknown" when the deletion print or the record does not read (rule 24), never "not deleted". A store with
 * no list, or a request with no address, names nobody to check.
 */
async function deletedSinceWrite(listId: string | null | undefined, body: unknown, found: unknown): Promise<boolean | "unknown"> {
  const email = body && typeof body === "object" && typeof (body as { email?: unknown }).email === "string" ? (body as { email: string }).email : "";
  if (!listId || !email) return false;
  let at: number;
  try {
    at = Number((JSON.parse(String(found)) as { at?: unknown }).at);
  } catch {
    return "unknown";
  }
  if (!Number.isSafeInteger(at)) return "unknown";
  const replies = repliesFor(await redisPipeline([suppressedAtCommand(listId, email)]).catch(() => null), 1);
  if (!replies) return "unknown";
  const raw = replies[0];
  if (raw === null) return false;
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || !/^\d{1,12}$/.test(text)) return "unknown";
  return Number(text) >= Math.floor(at / 1_000);
}

/** The kept record, its answer replaced by one that names nobody, until 24 hours after its write began. */
async function withhold(rk: string, found: unknown): Promise<void> {
  const record = JSON.parse(String(found)) as { fp: string; at: number };
  const left = Math.max(1, Math.ceil((record.at + IDEMPOTENCY_SECONDS * 1_000 - Date.now()) / 1_000));
  const body = JSON.stringify({ error: "idempotency_key", message: DELETED_WORDS });
  await redisPipeline([["SET", rk, JSON.stringify({ state: "done", fp: record.fp, at: record.at, status: 409, body }), "XX", "EX", left]]).catch(() => {});
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
