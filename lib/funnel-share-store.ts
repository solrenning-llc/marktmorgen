/**
 * Share links for funnels (lib/funnel-bundle.ts): a snapshot of one funnel,
 * readable by another Marktmorgen store with its code, until the sender
 * revokes it or it runs out.
 *
 *   nl:fshares:<statsId>      hash: share id -> what the sender's list shows
 *                             (name, funnel, made, ends, the code's last four
 *                             characters and the hash of the code)
 *   nl:fshare:<sha256(code)>  hash: rec (whose share it is, when it ends),
 *                             sum (the outline a preview shows) and bundle
 *                             (the file itself); expires with the link
 *   nl:fshare:n:<id>:<what>   counters: previews and imports of one link a day
 *
 * The code is shown once, when the link is made, and never stored: only its
 * SHA-256 is, which recognizes it and is useless to whoever reads the
 * database. 128 random bits need no slow hash: there is nothing to guess.
 * Revoking deletes the snapshot first and the list entry second, and a code
 * is honored only while both are there, so a half-finished revoke never
 * leaves a link that works.
 */
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type BundleOutline, type FunnelBundle } from "@/lib/funnel-bundle";
import { MAX_SHARE_DAYS, MAX_SHARE_NAME, SHARE_CODE, SHARE_ID } from "@/lib/funnel-share-rules";

const listKey = (statsId: string) => `nl:fshares:${statsId}`;
export const lookupKey = (hash: string) => `nl:fshare:${hash}`;
const countKey = (id: string, what: string) => `nl:fshare:n:${id}:${what}`;
const hashOf = (code: string) => createHash("sha256").update(code).digest("hex");

export type ShareEntry = {
  id: string;
  name: string;
  funnelId: string;
  /** Seconds. */
  createdAt: number;
  expiresAt: number;
  /** The code's last four characters, to tell links apart. */
  hint: string;
  hash: string;
};

type ShareRecord = { statsId: string; id: string; expiresAt: number; from: string };

function parseEntry(raw: unknown): ShareEntry | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<ShareEntry>;
    if (typeof v.id !== "string" || !SHARE_ID.test(v.id) || typeof v.hash !== "string" || !/^[0-9a-f]{64}$/.test(v.hash)) return null;
    if (typeof v.expiresAt !== "number" || typeof v.createdAt !== "number") return null;
    return {
      id: v.id,
      name: typeof v.name === "string" ? v.name.slice(0, MAX_SHARE_NAME) : "",
      funnelId: typeof v.funnelId === "string" ? v.funnelId : "",
      createdAt: v.createdAt,
      expiresAt: v.expiresAt,
      hint: typeof v.hint === "string" ? v.hint.slice(0, 4) : "",
      hash: v.hash,
    };
  } catch {
    return null;
  }
}

/**
 * A store's share links, newest first. Ones that have run out are cleared from the list as it is read.
 * Throws when the list cannot be read, or when whether a snapshot is there comes back in any shape but
 * an exact 0 or 1 (CX-123 rule 24): clearing a row revokes its link, so only a confirmed 0 clears one.
 */
export async function listShares(statsId: string | null, nowSeconds = Math.floor(Date.now() / 1000)): Promise<ShareEntry[]> {
  if (!statsId || !isRedisConfigured()) throw new Error("Share links unavailable");
  const replies = await redisPipeline([["HGETALL", listKey(statsId)]]);
  const flat = repliesFor(replies, 1) ? stringList(replies[0]) : null;
  if (!flat || flat.length % 2 !== 0) throw new Error("Share links unavailable");
  const entries: { field: string; entry: ShareEntry | null }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) entries.push({ field: flat[i], entry: parseEntry(flat[i + 1]) });
  // The snapshot's own expiry is the one that counts: an entry whose snapshot is gone is cleared too.
  const readable = entries.filter((row) => row.entry && row.entry.expiresAt > nowSeconds);
  const exists = readable.length ? await redisPipeline(readable.map((row) => ["EXISTS", lookupKey(row.entry!.hash)])) : [];
  if (!repliesFor(exists, readable.length)) throw new Error("Share links unavailable");
  const there = exists.map(countOf);
  if (there.some((n) => n !== 0 && n !== 1)) throw new UnknownReplyError("whether a shared snapshot is there");
  const live: ShareEntry[] = readable.filter((_, i) => there[i] === 1).map((row) => row.entry!);
  const stale = entries.filter((row) => !live.includes(row.entry!)).map((row) => row.field);
  if (stale.length) await redisPipeline([["HDEL", listKey(statsId), ...stale]]).catch(() => {});
  return live.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** Adds a link only while the store has fewer than its limit, and never over an existing one. */
export const CREATE_SHARE = `-- marktmorgen:funnel-share:v1
local kind = redis.call("TYPE", KEYS[1]).ok
if kind ~= "none" and kind ~= "hash" then return -3 end
if redis.call("EXISTS", KEYS[2]) == 1 or redis.call("HEXISTS", KEYS[1], ARGV[1]) == 1 then return -2 end
if redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[6]) then return 0 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("HSET", KEYS[2], "rec", ARGV[3], "sum", ARGV[4], "bundle", ARGV[5])
redis.call("EXPIRE", KEYS[2], tonumber(ARGV[7]))
return 1`;

/**
 * Makes a share link for this snapshot. Returns the code, shown this once,
 * or "full" when the store already holds its limit of links.
 */
export async function createShare(
  statsId: string,
  input: { name: string; funnelId: string; days: number; from: string; bundle: FunnelBundle; outline: BundleOutline; limit: number },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; code: string; entry: ShareEntry } | { ok: false; error: "full" }> {
  const days = Math.min(Math.max(1, Math.floor(input.days)), MAX_SHARE_DAYS);
  const code = `mmf_${randomBytes(16).toString("hex")}`;
  const hash = hashOf(code);
  const entry: ShareEntry = {
    id: randomBytes(6).toString("hex"),
    name: input.name.slice(0, MAX_SHARE_NAME),
    funnelId: input.funnelId,
    createdAt: nowSeconds,
    expiresAt: nowSeconds + days * 86_400,
    hint: code.slice(-4),
    hash,
  };
  const record: ShareRecord = { statsId, id: entry.id, expiresAt: entry.expiresAt, from: input.from.slice(0, 80) };
  const replies = await redisPipeline([
    ["EVAL", CREATE_SHARE, 2, listKey(statsId), lookupKey(hash), entry.id, JSON.stringify(entry), JSON.stringify(record), JSON.stringify(input.outline), JSON.stringify(input.bundle), input.limit, days * 86_400],
  ]);
  const reply = repliesFor(replies, 1) ? countOf(replies[0]) : null;
  if (reply === 1) return { ok: true, code, entry };
  if (reply === 0) return { ok: false, error: "full" };
  throw new Error("Share link could not be confirmed");
}

/** Revokes a link at once: its snapshot first, then its line in the list. Throws when a reply is in another shape: "not there" only on a confirmed absence. */
export async function revokeShare(statsId: string, id: string): Promise<boolean> {
  const replies = await redisPipeline([["HGET", listKey(statsId), id]]);
  if (!repliesFor(replies, 1) || (replies[0] !== null && typeof replies[0] !== "string")) throw new UnknownReplyError("a share link");
  const entry = parseEntry(replies[0]);
  if (!entry) return false;
  const done = await redisPipeline([["DEL", lookupKey(entry.hash)], ["HDEL", listKey(statsId), id]]);
  const counts = repliesFor(done, 2) ? done.map(countOf) : null;
  if (!counts || counts.some((n) => n !== 0 && n !== 1)) throw new Error("Revoking could not be confirmed");
  return counts[1] === 1;
}

/**
 * What a code opens, when it is a working link: who shared it and, as asked,
 * its outline or its whole file. Null when the code is not one, the link was
 * revoked or has run out.
 */
export async function openShare<T extends "sum" | "bundle">(
  rawCode: string,
  part: T,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ id: string; statsId: string; from: string; value: unknown } | null> {
  if (!SHARE_CODE.test(rawCode)) return null;
  const key = lookupKey(hashOf(rawCode));
  const [found] = await redisPipeline([["HMGET", key, "rec", part]]);
  if (!Array.isArray(found) || typeof found[0] !== "string" || typeof found[1] !== "string") return null;
  let record: ShareRecord;
  let value: unknown;
  try {
    record = JSON.parse(found[0]) as ShareRecord;
    value = JSON.parse(found[1]);
  } catch {
    return null;
  }
  if (typeof record.statsId !== "string" || typeof record.id !== "string" || typeof record.expiresAt !== "number" || record.expiresAt <= nowSeconds) return null;
  // Still on the sender's list: a revoke that stopped halfway still revokes.
  const [listed] = await redisPipeline([["HEXISTS", listKey(record.statsId), record.id]]);
  const on = countOf(listed);
  if (on !== 0 && on !== 1) throw new UnknownReplyError("whether a share link is listed");
  if (on !== 1) return null;
  return { id: record.id, statsId: record.statsId, from: typeof record.from === "string" ? record.from : "", value };
}

/**
 * Counts one use against a limit in a window, and says whether it fits.
 * Unlike the request limits of lib/request-guard.ts it refuses when the count
 * cannot be read: an unread count is not zero.
 */
export async function countUse(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const replies = await redisPipeline([["SET", key, "0", "EX", windowSeconds, "NX"], ["INCR", key]]);
  const count = repliesFor(replies, 2) ? countOf(replies[1]) : null;
  if (count === null || count < 1) throw new Error("Use count unavailable");
  return count <= limit;
}

export const shareUseKey = (id: string, what: "preview" | "import") => countKey(id, what);
export const storeUseKey = (statsId: string, what: "preview" | "import" | "apply") => `nl:fuse:${what}:${statsId}`;
/**
 * The same counts by calendar month (UTC), the period each plan's worst
 * month is counted in (lib/funnel-share-rules.ts): pass MONTH_USE_SECONDS as
 * the window, so the key is gone after its month.
 */
export const shareMonthKey = (id: string, what: "preview" | "import", month: string) => `${countKey(id, what)}:${month}`;
export const storeMonthKey = (statsId: string, what: "share" | "preview" | "import" | "apply" | "export", month: string) => `nl:fuse:m:${what}:${statsId}:${month}`;
export const MONTH_USE_SECONDS = 32 * 86_400;
