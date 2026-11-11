/**
 * A buyer's request to move their purchases to another address, kept
 * (611 [WP10], unit 2, 10 November 2026; the rules are in
 * lib/purchase-move-rules.ts).
 *
 *   nl:pm:r:<id>             string  the request: both addresses, the scope, when it was asked
 *   nl:pm:t:<sha(token)>     string  what a link is for: the request and which address it went to
 *   nl:pm:c:<id>:<side>      string  that address confirmed, and when (a mark, taken once)
 *   nl:pm:done:<id>          string  the request was claimed for its move (a mark, taken once)
 *   nl:pm:day:<fingerprint>  string  how many requests an address started today, under a one-way fingerprint
 *   nl:pm:retry:<fingerprint> string  the request id reused by a same-day retry, under a one-way fingerprint
 *
 * Everything ends by itself: the request, its links and its confirmations
 * when its day is up (MOVE_CONFIRM_SECONDS), the claim and the day's count
 * a day after that. Each confirmation is its own mark, so two pressed at the
 * same moment are both kept; the claim is one mark, so a move is done once.
 * The links' secrets are never kept, only their fingerprints. A reply that
 * is not exactly what was asked for is unknown, never "nobody" or "done"
 * (rule 24).
 *
 * No route, page or email uses this yet (the next unit): asking returns the
 * two links for the caller to email, after taking each email from a store's
 * allowance, and a claim says only that the move may now be made.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { claimMark, claimValue } from "@/lib/claim-mark";
import {
  type MoveRequest,
  type MoveSide,
  type MoveState,
  MOVE_CONFIRM_SECONDS,
  applyMove,
  confirmMove,
  dailyMoves,
  moveState,
  newMoveRequest,
  parseMoveRequest,
  readMoveScope,
} from "@/lib/purchase-move-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";

/** A link's secret: 48 hex characters. */
export const MOVE_TOKEN = /^[0-9a-f]{48}$/;
/** How long the claim and the day's count are kept: a day after the request's own day. */
export const MOVE_MARK_SECONDS = 2 * 86_400;
/** The most one request's record may weigh; two addresses of at most 254 characters and a store's id fit well inside. */
export const MAX_MOVE_RECORD_BYTES = 1_024;

const ID = /^[0-9a-f]{32}$/;
/** A mark's value as claimValue writes it: the time in milliseconds, a point, nine digits. */
const MARK_VALUE = /^(\d{13})\.\d{9}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const requestKey = (id: string) => `nl:pm:r:${id}`;
const tokenKey = (token: string) => `nl:pm:t:${sha(token)}`;
const confirmKey = (id: string, side: MoveSide) => `nl:pm:c:${id}:${side}`;
const doneKey = (id: string) => `nl:pm:done:${id}`;
/** One address's count of the day (UTC), under a fingerprint that cannot be turned back into the address. */
const dayKey = (address: string, nowMs: number) => `nl:pm:day:${sha(`nimbus-pm-day:${Math.floor(nowMs / 86_400_000)}:${address}`).slice(0, 32)}`;
/** A same-address, same-destination retry finds the existing request without storing either address in a key. */
const retryKey = (from: string, to: string, scope: MoveRequest["scope"], nowMs: number) =>
  `nl:pm:retry:${sha(`nimbus-pm-retry:v1:${Math.floor(nowMs / 86_400_000)}:${JSON.stringify([scope, from, to])}`).slice(0, 32)}`;
const retryToken = (id: string, side: MoveSide): string | null => {
  const key = process.env.NIMBUS_DATA_KEY;
  if (!key) return null;
  return createHmac("sha256", key).update(`nimbus-pm-link:v1:${id}:${side}`).digest("hex").slice(0, 48);
};
const seconds = (ms: number) => Math.floor(ms / 1000);

type Kept = Pick<MoveRequest, "from" | "to" | "scope" | "createdAt">;
type Grant = { id: string; side: MoveSide };
type RetryIndex = { id: string; claim: string };

function parseRetryIndex(raw: unknown): RetryIndex | null {
  const value = parseJson(raw) as { id?: unknown; claim?: unknown } | undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "claim,id") return null;
  if (typeof value.id !== "string" || !ID.test(value.id) || typeof value.claim !== "string" || !ID.test(value.claim)) return null;
  return { id: value.id, claim: value.claim };
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length > MAX_MOVE_RECORD_BYTES) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parseGrant(raw: unknown): Grant | null {
  const value = parseJson(raw) as { id?: unknown; side?: unknown } | undefined;
  if (!value || typeof value !== "object") return null;
  if (typeof value.id !== "string" || !ID.test(value.id) || (value.side !== "from" && value.side !== "to")) return null;
  return { id: value.id, side: value.side };
}

/** A mark's time in seconds; null when there is no mark; throws when it cannot be read. */
function markTime(raw: unknown, what: string): number | null {
  if (raw === null) return null;
  const match = typeof raw === "string" ? MARK_VALUE.exec(raw) : null;
  if (!match) throw new UnknownReplyError(what);
  return Math.floor(Number(match[1]) / 1000);
}

/**
 * The day's count and its expiry in one step: Redis runs a script whole, so
 * a count is never left without its end, whatever the batch around it
 * answers (Codex T on #3608). Billed as three commands (the EVAL, INCR and
 * EXPIRE), one more than the two-command batch it replaces. Answers the new
 * count. lib/redis-memory.ts models it for the tests.
 */
export const MOVE_DAY_COUNT = `-- marktmorgen:purchase-move-day:v1
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return n`;

/**
 * Selects and writes one same-day retry identity atomically. The retry index is written first within
 * the script: if a later write fails, every later ask sees that one identity and fails closed rather
 * than creating another. The opaque claim nonce lets a caller reconcile a lost EVAL reply.
 */
export const MOVE_RETRY_CREATE = `-- marktmorgen:purchase-move-retry-create:v1
local current = redis.call('GET', KEYS[1])
if current then return {0, current} end
local held = redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[5], 'NX')
if held ~= 'OK' then return {-1, ''} end
local request = redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[5], 'NX')
if request ~= 'OK' then return {-1, ARGV[1]} end
local from = redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[5], 'NX')
if from ~= 'OK' then return {-1, ARGV[1]} end
local to = redis.call('SET', KEYS[4], ARGV[4], 'EX', ARGV[5], 'NX')
if to ~= 'OK' then return {-1, ARGV[1]} end
return {1, ARGV[1]}`;

export type MoveAsk = { ok: true; id: string; fromToken: string; toToken: string } | { ok: false; reason: "email" | "same" | "scope" | "over" | "unknown" };

/**
 * A buyer asks to move their purchases from one address to another, for one
 * store (its id) or "all". Counts against the old address's three a day
 * before anything is written; the request and both links end with its day.
 */
export async function askPurchaseMove(input: { from: unknown; to: unknown; scope: unknown; now?: number }): Promise<MoveAsk> {
  const now = input.now ?? Date.now();
  const made = newMoveRequest({ from: input.from, to: input.to, scope: readMoveScope(input.scope), now: seconds(now) });
  if (typeof made === "string") return { ok: false, reason: made };
  if (!isRedisConfigured()) return { ok: false, reason: "unknown" };
  const record: Kept = { from: made.from, to: made.to, scope: made.scope, createdAt: made.createdAt };
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json, "utf8") > MAX_MOVE_RECORD_BYTES) return { ok: false, reason: "unknown" };

  const day = dayKey(made.from, now);
  const counted = repliesFor(await redisPipeline([["EVAL", MOVE_DAY_COUNT, 1, day, MOVE_MARK_SECONDS]]), 1);
  const count = counted ? countOf(counted[0]) : null;
  const allowed = dailyMoves(count === null || count < 1 ? null : count - 1);
  if (allowed !== "within") return { ok: false, reason: allowed === "over" ? "over" : "unknown" };

  const retry = retryKey(made.from, made.to, made.scope, now);
  const id = randomBytes(16).toString("hex");
  const claim = randomBytes(16).toString("hex");
  const indexValue = JSON.stringify({ id, claim } satisfies RetryIndex);
  const fromToken = retryToken(id, "from") ?? "";
  const toToken = retryToken(id, "to") ?? "";
  if (!fromToken || !toToken) return { ok: false, reason: "unknown" };

  const result = repliesFor(
    await redisPipeline([[
      "EVAL",
      MOVE_RETRY_CREATE,
      4,
      retry,
      requestKey(id),
      tokenKey(fromToken),
      tokenKey(toToken),
      indexValue,
      json,
      JSON.stringify({ id, side: "from" } satisfies Grant),
      JSON.stringify({ id, side: "to" } satisfies Grant),
      MOVE_CONFIRM_SECONDS,
    ]]),
    1,
  )?.[0];
  const decision =
    Array.isArray(result) &&
    result.length === 2 &&
    (result[0] === -1 || result[0] === 0 || result[0] === 1) &&
    typeof result[1] === "string"
      ? { status: result[0], index: result[1] }
      : null;

  const reuse = async (raw: unknown): Promise<MoveAsk> => {
    const kept = parseRetryIndex(raw);
    if (!kept) return { ok: false, reason: "unknown" };
    const keptFromToken = retryToken(kept.id, "from") ?? "";
    const keptToToken = retryToken(kept.id, "to") ?? "";
    if (!keptFromToken || !keptToToken) return { ok: false, reason: "unknown" };
    const existing = repliesFor(
      await redisPipeline([[ "GET", requestKey(kept.id) ], [ "GET", tokenKey(keptFromToken) ], [ "GET", tokenKey(keptToToken) ]]),
      3,
    );
    if (!existing || typeof existing[0] !== "string" || existing[1] === null || existing[2] === null) return { ok: false, reason: "unknown" };
    const prior = parseJson(existing[0]) as Partial<Kept> | undefined;
    const parsed = prior && parseMoveRequest({ ...prior, fromConfirmedAt: null, toConfirmedAt: null, appliedAt: null });
    const fromGrant = parseGrant(existing[1]);
    const toGrant = parseGrant(existing[2]);
    if (
      !parsed ||
      parsed.from !== made.from ||
      parsed.to !== made.to ||
      JSON.stringify(parsed.scope) !== JSON.stringify(made.scope) ||
      seconds(now) >= parsed.createdAt + MOVE_CONFIRM_SECONDS ||
      !fromGrant || fromGrant.id !== kept.id || fromGrant.side !== "from" ||
      !toGrant || toGrant.id !== kept.id || toGrant.side !== "to"
    ) return { ok: false, reason: "unknown" };
    return { ok: true, id: kept.id, fromToken: keptFromToken, toToken: keptToToken };
  };

  if (decision?.status === 1) {
    if (decision.index !== indexValue) return { ok: false, reason: "unknown" };
    return { ok: true, id, fromToken, toToken };
  }
  if (decision?.status === 0) return reuse(decision.index);
  if (decision?.status === -1) return { ok: false, reason: "unknown" };

  // EVAL may have committed before its reply was lost or malformed. Read the exact index and grants;
  // never make another identity on an uncertain result.
  const reconciled = repliesFor(await redisPipeline([["GET", retry]]), 1);
  if (!reconciled || typeof reconciled[0] !== "string") return { ok: false, reason: "unknown" };
  return reuse(reconciled[0]);
}

/**
 * A request as it stands: its record with each confirmation and the claim,
 * read in one go. Null when it is gone (its day ended, or there never was
 * one); throws UnknownReplyError when any part cannot be read.
 */
export async function readPurchaseMove(id: string): Promise<MoveRequest | null> {
  if (!ID.test(id) || !isRedisConfigured()) return null;
  const what = "a purchase move request";
  const replies = repliesFor(
    await redisPipeline([["GET", requestKey(id)], ["GET", confirmKey(id, "from")], ["GET", confirmKey(id, "to")], ["GET", doneKey(id)]]),
    4,
  );
  if (!replies) throw new UnknownReplyError(what);
  if (replies[0] === null) return null;
  const record = parseJson(replies[0]);
  if (!record || typeof record !== "object") throw new UnknownReplyError(what);
  const request = parseMoveRequest({
    ...(record as object),
    fromConfirmedAt: markTime(replies[1], what),
    toConfirmedAt: markTime(replies[2], what),
    appliedAt: markTime(replies[3], what),
  });
  if (!request) throw new UnknownReplyError(what);
  return request;
}

/**
 * What a link is for, without confirming anything: its request and which
 * address it went to, for the page that asks the person to press Confirm
 * (611 [WP10], unit 3). Null when the link is unknown or its request is
 * gone; throws UnknownReplyError when any part cannot be read.
 */
export async function readMoveLink(token: string): Promise<{ id: string; side: MoveSide; request: MoveRequest } | null> {
  if (!MOVE_TOKEN.test(token) || !isRedisConfigured()) return null;
  const held = repliesFor(await redisPipeline([["GET", tokenKey(token)]]), 1);
  if (!held) throw new UnknownReplyError("a purchase move link");
  if (held[0] === null) return null;
  const grant = parseGrant(held[0]);
  if (!grant) throw new UnknownReplyError("a purchase move link");
  const request = await readPurchaseMove(grant.id);
  return request ? { id: grant.id, side: grant.side, request } : null;
}

export type MoveConfirm ={ ok: true; id: string; side: MoveSide; state: MoveState } | { ok: false; reason: "link" | "expired" | "done" | "unknown" };

/** One address's link pressed: that address has confirmed. Pressing again changes nothing. */
export async function confirmPurchaseMove(token: string, now = Date.now()): Promise<MoveConfirm> {
  if (!MOVE_TOKEN.test(token) || !isRedisConfigured()) return { ok: false, reason: "link" };
  try {
    const held = repliesFor(await redisPipeline([["GET", tokenKey(token)]]), 1);
    if (!held) return { ok: false, reason: "unknown" };
    if (held[0] === null) return { ok: false, reason: "link" };
    const grant = parseGrant(held[0]);
    if (!grant) return { ok: false, reason: "unknown" };
    const request = await readPurchaseMove(grant.id);
    if (!request) return { ok: false, reason: "link" };
    const next = confirmMove(request, grant.side, seconds(now));
    if (next === "done" || next === "expired" || next === "unknown") return { ok: false, reason: next };
    if (next !== "already") {
      const claimed = await claimMark(confirmKey(grant.id, grant.side), MOVE_CONFIRM_SECONDS, claimValue(now));
      if (claimed === "unknown") return { ok: false, reason: "unknown" };
    }
    const after = await readPurchaseMove(grant.id);
    if (!after) return { ok: false, reason: "link" };
    const state = moveState(after, seconds(now));
    if (state === "unknown") return { ok: false, reason: "unknown" };
    return { ok: true, id: grant.id, side: grant.side, state };
  } catch (error) {
    if (error instanceof UnknownReplyError) return { ok: false, reason: "unknown" };
    throw error;
  }
}

export type MoveClaim = { ok: true; request: MoveRequest } | { ok: false; reason: "gone" | "not-ready" | "done" | "expired" | "unknown" };

/**
 * Claims a request for its move, once: only when both addresses confirmed in
 * time and nobody claimed it before. Only the run that gets `ok` moves the
 * purchases (the next units); every other gets a reason and does nothing.
 */
export async function claimPurchaseMove(id: string, now = Date.now()): Promise<MoveClaim> {
  let request: MoveRequest | null;
  try {
    request = await readPurchaseMove(id);
  } catch (error) {
    if (error instanceof UnknownReplyError) return { ok: false, reason: "unknown" };
    throw error;
  }
  if (!request) return { ok: false, reason: "gone" };
  const applied = applyMove(request, seconds(now));
  if (typeof applied === "string") return { ok: false, reason: applied };
  const claimed = await claimMark(doneKey(id), MOVE_MARK_SECONDS, claimValue(now));
  if (claimed === "taken") return { ok: false, reason: "done" };
  if (claimed === "unknown") return { ok: false, reason: "unknown" };
  return { ok: true, request: applied };
}
