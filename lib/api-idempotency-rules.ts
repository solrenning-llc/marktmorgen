/**
 * The Idempotency-Key header on the REST API's writes: the rules, unit 1 (complement WG (a) of 616 [WP15],
 * 10 November 2026).
 *
 * A script, Zapier or an AI agent that sends a write again because the network dropped the answer must not give a
 * buyer a second access, a second email or a second code. With the header, the first answer is kept and a repeat gets
 * it back without the write running again. This follows the IETF draft "The Idempotency-Key HTTP Header Field"
 * (draft-ietf-httpapi-idempotency-key-header-08, 22 October 2026, read 10 November 2026): the key is a Structured
 * Field String (quoted), a repeat after the first one finished gets "a response consistent with the request being
 * completed", the same key with another payload gets 422, and a repeat while the first one runs gets 409. The
 * resource must publish its expiry policy: here, 24 hours.
 *
 * What this file decides, and nothing more: how the header is read, the fingerprint of a request, what a kept record
 * says to a new request, what is kept after a write, and the most it can cost. Pure: no IO, no clock (the caller
 * passes `now`). Nothing calls it yet: no route reads the header, no record is written (VR state "testado num PR").
 *
 * Without the header nothing changes. An unknown record (a read that failed or a reply of another shape) runs
 * nothing: it is never taken for "no record" (rule 24), since that would run the write twice.
 */
import { createHash } from "node:crypto";
import { UPSTASH_MICRO_USD_PER_GB_MONTH, UPSTASH_MICRO_USD_PER_GB_TRANSFER, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS } from "@/lib/spend-cost-table";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
/** The longest key taken, in characters (Whop's limit, the item's figure). */
export const MAX_IDEMPOTENCY_KEY = 255;
/** How long a kept answer is given back: the expiry policy the draft asks the API to publish. */
export const IDEMPOTENCY_SECONDS = 24 * 3_600;
/** The largest answer kept. A write whose answer can be larger does not take a key (see `takesKey`). */
export const MAX_KEPT_ANSWER_BYTES = 8_192;
/** Room for the record's own fields beyond the answer: state, fingerprint (64), status, times. */
const RECORD_ROOM_BYTES = 256;
/** The most one record can weigh. */
export const MAX_IDEMPOTENCY_RECORD_BYTES = MAX_KEPT_ANSWER_BYTES + RECORD_ROOM_BYTES;
/** Database commands one keyed write adds at most: read the record, claim it, keep the answer. */
export const IDEMPOTENCY_COMMANDS = 3;

export type KeyRead = { kind: "none" } | { kind: "key"; key: string } | { kind: "invalid"; message: string };

/**
 * The header's key. The draft's form is a quoted String ("…", with \" and \\ escaped); a bare value of the same
 * characters, as most APIs take it, is taken too. Printable ASCII only (what a Structured Field String may hold),
 * 1 to 255 characters. No header, or an empty one, is "none": nothing changes for that request.
 */
export function readIdempotencyKey(header: string | null | undefined): KeyRead {
  if (header === null || header === undefined) return { kind: "none" };
  const raw = header.trim();
  if (!raw) return { kind: "none" };
  let key = raw;
  if (raw.startsWith("\"")) {
    if (raw.length < 2 || !raw.endsWith("\"")) return invalid;
    key = "";
    const inner = raw.slice(1, -1);
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === "\\") {
        const next = inner[i + 1];
        if (next !== "\"" && next !== "\\") return invalid;
        key += next;
        i++;
      } else if (c === "\"") {
        return invalid;
      } else {
        key += c;
      }
    }
  }
  if (!key || key.length > MAX_IDEMPOTENCY_KEY || !/^[\x20-\x7e]+$/.test(key) || key.trim() !== key) return invalid;
  return { kind: "key", key };
}

const invalid: KeyRead = {
  kind: "invalid",
  message: `The ${IDEMPOTENCY_HEADER} header must be 1 to ${MAX_IDEMPOTENCY_KEY} printable characters, for example a UUID, with no spaces at either end. Nothing was done.`,
};

/**
 * What makes two requests "the same": the method, the path and the exact body bytes. The same key on another
 * endpoint or with another body is a key used again for something else (422), never a repeat.
 */
export function requestFingerprint(method: string, path: string, body: string): string {
  return createHash("sha256").update(`${method.toUpperCase()}\n${path}\n`).update(body).digest("hex");
}

/** A kept record: a write under way, or one that finished with the answer to give back. */
export type IdempotencyRecord =
  | { state: "pending"; fp: string; at: number }
  | { state: "done"; fp: string; at: number; status: number; body: string };

/** A kept record read exactly, or null when it is not one (a record of any other shape is unknown, never absent). */
export function readRecord(raw: unknown): IdempotencyRecord | null {
  if (typeof raw !== "string" || raw.length > MAX_IDEMPOTENCY_RECORD_BYTES * 2) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.fp !== "string" || !/^[0-9a-f]{64}$/.test(r.fp) || typeof r.at !== "number" || !Number.isSafeInteger(r.at)) return null;
  if (r.state === "pending" && Object.keys(r).length === 3) return { state: "pending", fp: r.fp, at: r.at };
  if (r.state === "done" && typeof r.status === "number" && Number.isInteger(r.status) && r.status >= 200 && r.status <= 599 &&
      typeof r.body === "string" && Object.keys(r).length === 5) {
    return { state: "done", fp: r.fp, at: r.at, status: r.status, body: r.body };
  }
  return null;
}

export type Decision =
  /**
   * No record: claim it and run the write only if the claim took. The claim is a write that only sets a missing key
   * (kept 24 h); for a record past its 24 hours that the database still holds, `replaces` is its exact value, and the
   * claim sets only while the key still holds it. Two requests at once: one claim takes, the other reads again.
   */
  | { kind: "run"; claim: string; replaces?: string }
  /** The same request finished before: give its answer back, run nothing. */
  | { kind: "replay"; status: number; body: string }
  /** The same key for another request: 422, run nothing. */
  | { kind: "mismatch"; status: 422; message: string }
  /** The same request is still running, or its first try never said how it ended: 409, run nothing. */
  | { kind: "in_flight"; status: 409; message: string }
  /** The record could not be read: run nothing, ask to try again. */
  | { kind: "unknown"; status: 503; message: string };

export const MISMATCH_WORDS = `This ${IDEMPOTENCY_HEADER} was already used for a different request (another endpoint or another body). Nothing was done. Use a new key for a new request.`;
export const IN_FLIGHT_WORDS = `A request with this ${IDEMPOTENCY_HEADER} is still being processed, or its first try did not finish. Nothing was done this time. Wait and send it again with the same key; if it keeps answering this, check whether the first try took effect before using a new key.`;
export const UNKNOWN_WORDS = `We could not check this ${IDEMPOTENCY_HEADER} just now, so nothing was done. Send the same request again with the same key in a moment.`;

/**
 * What a kept record says to a new request. `found` is the database's reply for the key: null when Redis answered
 * that there is none (the only "no record"), anything else read exactly. A record older than 24 hours is treated as
 * gone, as the database would have dropped it.
 */
export function decide(found: unknown, fp: string, now: number): Decision {
  if (found === null) return { kind: "run", claim: JSON.stringify({ state: "pending", fp, at: now }) };
  const record = readRecord(found);
  if (!record) return { kind: "unknown", status: 503, message: UNKNOWN_WORDS };
  if (now - record.at >= IDEMPOTENCY_SECONDS * 1_000) return { kind: "run", claim: JSON.stringify({ state: "pending", fp, at: now }), replaces: found as string };
  if (record.fp !== fp) return { kind: "mismatch", status: 422, message: MISMATCH_WORDS };
  if (record.state === "pending") return { kind: "in_flight", status: 409, message: IN_FLIGHT_WORDS };
  return { kind: "replay", status: record.status, body: record.body };
}

/**
 * Whether a write may take a key: only one whose largest answer fits what is kept. Checked before the write runs, so
 * a key is refused before any effect, never after (the item's "resposta acima do tamanho máximo guardado é recusada
 * antes do efeito").
 */
export const takesKey = (largestAnswerBytes: number) =>
  Number.isSafeInteger(largestAnswerBytes) && largestAnswerBytes > 0 && largestAnswerBytes <= MAX_KEPT_ANSWER_BYTES;

export const TOO_LARGE_WORDS = `This endpoint does not take an ${IDEMPOTENCY_HEADER}: its answer can be larger than we keep. Nothing was done. Send it without the header.`;

/** Whether the write could have changed anything, as the route knows it when it answers. */
export type Effect = "none" | "maybe" | "done";

/**
 * What is kept after the write answered. A write that changed nothing (refused by its checks, over the plan's figure,
 * not authorized) lets the key go, so the same request can be sent again once fixed. A write that changed something,
 * or may have, keeps its answer for 24 hours, so a repeat never runs it again. An answer larger than is kept, which
 * `takesKey` should have stopped, keeps the claim as it is: a repeat is told 409, never run twice.
 */
export function afterWrite(fp: string, startedAt: number, status: number, body: string, effect: Effect):
  { action: "release" } | { action: "keep"; record: string } | { action: "hold" } {
  if (effect === "none") return { action: "release" };
  if (new TextEncoder().encode(body).length > MAX_KEPT_ANSWER_BYTES || !Number.isInteger(status) || status < 200 || status > 599) return { action: "hold" };
  return { action: "keep", record: JSON.stringify({ state: "done", fp, at: startedAt, status, body }) };
}

/**
 * The most the header can cost a store in a month, in micro-dollars, before it is turned on: every API request of
 * the plan's month (`apiRequests`, lib/store-allowance-rules.ts) sent with a key, each adding its three commands,
 * moving its largest record twice (write and read) and keeping it, counted as if kept the whole month (it is kept
 * 24 hours). Upstash pay-as-you-go figures with no free quota (lib/spend-cost-table.ts). Rounded up.
 */
export function idempotencyWorstMicroUsd(apiRequests: number): number {
  if (!Number.isSafeInteger(apiRequests) || apiRequests < 0) throw new Error("a plan's API requests must be a whole number");
  const gb = (apiRequests * MAX_IDEMPOTENCY_RECORD_BYTES) / 1e9;
  const commands = (apiRequests * IDEMPOTENCY_COMMANDS * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e6;
  const transfer = 2 * gb * UPSTASH_MICRO_USD_PER_GB_TRANSFER;
  const storage = gb * UPSTASH_MICRO_USD_PER_GB_MONTH;
  return Math.ceil(commands + transfer + storage);
}
