/**
 * Following a changeable link of a sent email (124 [F2-EDIT-SENT-LINKS],
 * unit 2; the rules are in lib/sent-link-rules.ts). Nothing writes such a
 * link into an email, and no screen keeps a change, yet (the next unit).
 *
 *   nl:mail:bc:<email>:links   hash   link's number -> its changes, newest first (JSON)
 *
 * A click, in this order, so that a link that is not the store's own costs
 * nothing:
 *   1. the signature of the store, the email, the number and the address as
 *      written is checked, with no read at all;
 *   2. the store is read by its fixed id and SENT_LINK_REQUEST_UNITS of its
 *      public requests are taken (lib/traffic.ts): past its figure the reader is sent to the
 *      store's resting page, never to an address not checked;
 *   3. the link's kept changes are read: the newest that reads, else the
 *      address as written.
 * A change that could not be read is "unknown", never the address as
 * written: the creator may have changed it because it was wrong (rule 24).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { BROADCAST_ID, RECORD_DAYS, readBroadcast } from "@/lib/broadcasts";
import { takeData } from "@/lib/store-data";
import { deriveKey } from "@/lib/secret-box";
import { type LinkChange, MAX_SENT_LINKS, SENT_LINK_REQUEST_UNITS, changeSentLink, readSentLinkPath, readSentLinkTarget, sentLinkGoesTo } from "@/lib/sent-link-rules";
import { type Store, storeForId } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";

const LABEL = "sent-link";

export const LINKS_KEY = (emailId: string) => `nl:mail:bc:${emailId}:links`;

/** The signature of a link's text under the server's own key: 32 hex, or null with no key. */
export function signSentLink(text: string): string | null {
  const key = deriveKey(LABEL);
  return key ? createHmac("sha256", key).update(text).digest("hex").slice(0, 32) : null;
}

/** Whether `signature` is this text's, compared in constant time; never with no key. */
export function verifySentLink(text: string, signature: string): boolean {
  const want = signSentLink(text);
  if (!want) return false;
  const a = Buffer.from(want, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A link's kept changes, newest first: [] for none, null when the reply or a change does not read. */
function readChanges(reply: unknown): LinkChange[] | null {
  if (reply === null) return [];
  if (typeof reply !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(reply);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const changes: LinkChange[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof (item as LinkChange).to !== "string" || !Number.isFinite((item as LinkChange).at)) return null;
    changes.push({ to: (item as LinkChange).to, at: (item as LinkChange).at });
  }
  return changes;
}

export type SentLinkDeps = {
  loadStore: (sid: string) => Promise<Store | null>;
  take: (store: Store) => Promise<boolean>;
};

const DEPS: SentLinkDeps = { loadStore: storeForId, take: (store) => takePublicRequest(store, "public", Date.now(), SENT_LINK_REQUEST_UNITS) };

export type SentLinkAnswer = { kind: "go"; to: string } | { kind: "resting"; handle: string } | { kind: "invalid" } | { kind: "unknown" };

/** Where a click on a changeable link goes. */
export async function followSentLink(
  input: { sid: string; id: string; n: string; query: { u?: unknown; s?: unknown }; now: number },
  deps: SentLinkDeps = DEPS,
): Promise<SentLinkAnswer> {
  const link = readSentLinkPath(input.sid, input.id, input.n, input.query, verifySentLink);
  // Signed or not, an address that is not plain http(s), or one of these links itself, is never followed (review of #3713).
  if (!link.ok || !readSentLinkTarget(link.original).ok) return { kind: "invalid" };
  try {
    const store = await deps.loadStore(input.sid);
    if (!store) return { kind: "unknown" };
    if (!(await deps.take(store))) return { kind: "resting", handle: store.handle };
  } catch {
    return { kind: "unknown" };
  }
  if (!isRedisConfigured()) return { kind: "unknown" };
  let changes: LinkChange[] | null;
  try {
    const replies = repliesFor(await redisPipeline([["HGET", LINKS_KEY(input.id), String(link.n)]]), 1);
    changes = replies ? readChanges(replies[0]) : null;
  } catch {
    changes = null;
  }
  if (!changes) return { kind: "unknown" };
  const to = sentLinkGoesTo(link.original, changes[0] ?? null);
  return to ? { kind: "go", to } : { kind: "unknown" };
}

/** Bytes a link's field adds beside its history: the field's name and what Redis keeps with it. */
const FIELD_BYTES = 64;

/**
 * A link's history written only while it, and when the email's links go, are still what was read: a second change made
 * at the same time is refused rather than lost from the history (review of #3713). When the links go is set once, by the
 * first change, and never pushed back, so no link is kept past the room its own change took (the review's MEDIUM:
 * an EXPIRE on every write kept every other link's field past its room).
 * KEYS[1] the links; ARGV: the link's number, its history as read ("" for none), when the links go as read
 * (PEXPIRETIME: -2 for none yet), the new history, and when the links go if this is the first change (ms).
 */
const KEEP_CHANGE = `-- marktmorgen:sent-link-keep:v1
if tostring(redis.call("PEXPIRETIME", KEYS[1])) ~= ARGV[3] then return 0 end
local held = redis.call("HGET", KEYS[1], ARGV[1])
if (held or "") ~= ARGV[2] then return 0 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[4])
if ARGV[3] == "-2" then redis.call("PEXPIREAT", KEYS[1], ARGV[5]) end
return 1`;

export type KeepRoom = { take: (store: Store, change: { until: number; bytes: number }) => Promise<boolean> };
const ROOM: KeepRoom = { take: async (store, change) => (await takeData(store, [change])).ok };

/**
 * Keeps a change to link `n` of one of the store's own sent emails, `original`
 * being the address it was written to. Its room is taken from the store's
 * data room until the email's links go (RECORD_DAYS from the first change,
 * never pushed back) before it is written; a history that does not read, or
 * that changed since it was read, is never written over.
 */
export async function keepLinkChange(
  store: Store,
  emailId: string,
  n: number,
  original: string,
  raw: unknown,
  now: number,
  room: KeepRoom = ROOM,
): Promise<{ ok: true; history: LinkChange[] } | { ok: false; problem: "address" | "same" | "none" | "full" | "unknown" }> {
  if (!BROADCAST_ID.test(emailId) || !Number.isInteger(n) || n < 0 || n >= MAX_SENT_LINKS || !store.listId) return { ok: false, problem: "none" };
  if (!isRedisConfigured()) return { ok: false, problem: "unknown" };
  let email;
  try {
    email = await readBroadcast(emailId);
  } catch {
    return { ok: false, problem: "unknown" };
  }
  if (!email || email.listId !== store.listId) return { ok: false, problem: "none" };
  let held: string | null;
  let history: LinkChange[] | null;
  let ends: number;
  try {
    const replies = repliesFor(await redisPipeline([["PEXPIRETIME", LINKS_KEY(emailId)], ["HGET", LINKS_KEY(emailId), String(n)]]), 2);
    ends = replies && typeof replies[0] === "number" && Number.isSafeInteger(replies[0]) ? replies[0] : Number.NaN;
    held = replies && (replies[1] === null || typeof replies[1] === "string") ? replies[1] : null;
    history = replies ? readChanges(replies[1]) : null;
  } catch {
    history = null;
    held = null;
    ends = Number.NaN;
  }
  // Links kept with no end (-1) or an end that does not read would be kept for good: unknown, nothing written.
  if (!history || !(ends === -2 || ends > 0)) return { ok: false, problem: "unknown" };
  const changed = changeSentLink(history, original, raw, now);
  if (!changed.ok) return changed;
  const value = JSON.stringify(changed.history);
  const until = ends > 0 ? ends : now + RECORD_DAYS * 86_400_000;
  try {
    if (!(await room.take(store, { until, bytes: Buffer.byteLength(value) + FIELD_BYTES }))) return { ok: false, problem: "full" };
    const replies = repliesFor(await redisPipeline([["EVAL", KEEP_CHANGE, 1, LINKS_KEY(emailId), String(n), held ?? "", String(ends), value, String(until)]]), 1);
    // 0: changed since it was read. The room taken stays counted until it ends: over, never under.
    if (!replies || countOf(replies[0]) !== 1) return { ok: false, problem: "unknown" };
  } catch {
    return { ok: false, problem: "unknown" };
  }
  return { ok: true, history: changed.history };
}
