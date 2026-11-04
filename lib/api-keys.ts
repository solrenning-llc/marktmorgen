/**
 * Keys a creator gives their own tools, so those tools can read their store.
 *
 * Measured before it was built (30 September 2026): Stan and Skool publish no
 * API at all. Circle opens its API from its $199-a-month plan and its webhooks
 * from $419. Kajabi keeps webhooks for its $249 plan. A creator here already
 * has webhooks on every plan (lib/webhooks.ts) — events pushed out as they
 * happen. This is the other direction: their tools asking, whenever they want,
 * for what is kept here and nowhere else — the list, the members, the
 * students, the affiliates, the bookings.
 *
 * A key is a password for a machine, and is kept like one:
 *
 *   - It is shown once, when it is made, and never again. What is stored is
 *     its SHA-256, which is enough to recognise it and useless to anyone who
 *     reads the database. A key with 160 random bits needs no slow hash: there
 *     is nothing to guess.
 *   - It belongs to the store by its permanent id, not its address or its
 *     owner's email, so renaming the store or changing the sign-in address
 *     neither breaks a key nor hands it to somebody else.
 *   - It reads, and does nothing else, unless the creator chose, when making
 *     it, that it may also write (lib/api-write.ts): add people to the list,
 *     change their labels, give and take back products. That choice is the
 *     key's for good; every key made before it existed reads only.
 *   - Apart from that, a key may be one an AI agent uses to prepare changes
 *     for the creator to confirm (631 [AA1] (c), `agent`): drafts, or drafts
 *     and changes that reach people. It never carries anything out by itself;
 *     every key made before 2 November 2026 prepares nothing.
 *   - Revoking it works at once: the very next request with it is refused.
 *   - At most MAX_KEYS a store, each named by the creator, each showing when
 *     it was last used, so an old one nobody remembers can be seen and cut.
 *
 * Kept, all under the store's own id:
 *
 *   nl:api:k:<sha256>        { sid, id } — the lookup a request makes
 *   nl:api:keys:<sid>        the store's keys, by id: name, made, last used,
 *                            and who made it in which kind of session
 *   nl:api:hold:<sid>        by key id: "paused" or "vouched" (lib/api-key-pause.ts)
 *
 * Who made a key (owner C3-100, 4 November 2026) is written once, when it is
 * made: whether by the store's owner, a one-way fingerprint of the teammate's
 * sign-in address otherwise (makerPrint: an HMAC under the deployment's own
 * secret and the store's id, so it cannot be matched across stores nor turned
 * back into the address by trying addresses), and whether that session was
 * opened with a second step. A key made before then has none of it. When the
 * teammate leaves the team, the fingerprint goes from their keys (forgetMaker)
 * and the keys are marked as their maker's who left. Whether a key is paused
 * is kept apart from its record, in the store's hold, because the record is
 * written again each time the key is used ("last used"): a pause written into
 * it could be undone by a request that read the record a moment before.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { deriveKey } from "@/lib/secret-box";

import { type AgentScope, type ApiKey, KEY_PREFIX, MAX_KEYS, MAX_KEY_NAME, agentScopeOf } from "@/lib/api-key-rules";
export { type AgentScope, type ApiKey, KEY_PREFIX, MAX_KEYS, MAX_KEY_NAME };
const KEY_PATTERN = /^nl_live_[0-9a-f]{40}$/;
const ID_PATTERN = /^[0-9a-f]{12}$/;
const SID_PATTERN = /^[0-9a-f]{32}$/;

const lookupKey = (hash: string) => `nl:api:k:${hash}`;
const listKey = (sid: string) => `nl:api:keys:${sid}`;
const holdKey = (sid: string) => `nl:api:hold:${sid}`;
const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

/**
 * Who made a key, written once when it is made (owner C3-100): `owner`, made
 * by the store's owner; `by`, otherwise, a one-way fingerprint of the
 * teammate's sign-in address (makerPrint); `step`, whether that session was
 * opened with a second step (lib/second-step-gate.ts liveSecondStep); `left`,
 * its maker has left the team, and the fingerprint is gone. Absent on every
 * key made before 4 November 2026.
 */
export type KeyMaker = { owner: boolean; by: string; step: boolean; left?: true };

/**
 * A key's hold (lib/api-key-pause.ts): "paused", refused, its maker not yet
 * told; "told", refused, its maker emailed (or nobody to tell); "vouched",
 * turned back on by its maker with a second step; none, as made.
 */
export type Hold = "paused" | "told" | "vouched";
const HOLDS: readonly string[] = ["paused", "told", "vouched"];
/** Whether a hold refuses the key. */
export const isPaused = (hold: Hold | null): boolean => hold === "paused" || hold === "told";

/** A key's record with who made it and its hold, never the key or its fingerprint. */
export type KeyRecord = ApiKey & { maker: KeyMaker | null; hold: Hold | null };

/**
 * A one-way fingerprint of a teammate's sign-in address on one store: an HMAC
 * under a key derived from the deployment's secret, over the store's id and
 * the address. "" when the deployment has no secret: then nobody is recorded,
 * and the key counts as one whose maker is not known (paused by the team's
 * two-step rule, turned back on only by the owner).
 */
export function makerPrint(sid: string, email: string): string {
  const key = deriveKey("api-key-maker/v1");
  if (!key) return "";
  return createHmac("sha256", key).update(`${sid}|${email.trim().toLowerCase()}`).digest("hex").slice(0, 40);
}

type Stored = ApiKey & { hash: string; maker?: KeyMaker };

const PRINT_PATTERN = /^[0-9a-f]{40}$/;

function makerOf(raw: unknown): KeyMaker | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Partial<KeyMaker>;
  const owner = v.owner === true;
  if (!owner && v.left === true) return { owner: false, by: "", step: v.step === true, left: true };
  const by = typeof v.by === "string" && PRINT_PATTERN.test(v.by) ? v.by : "";
  if (!owner && !by) return undefined;
  return { owner, by, step: v.step === true };
}

function parseStored(raw: unknown): Stored | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    if (typeof v.id !== "string" || !ID_PATTERN.test(v.id)) return null;
    if (typeof v.hash !== "string" || !/^[0-9a-f]{64}$/.test(v.hash)) return null;
    return {
      id: v.id,
      hash: v.hash,
      name: typeof v.name === "string" ? v.name : "",
      hint: typeof v.hint === "string" ? v.hint : "",
      madeAt: typeof v.madeAt === "number" ? v.madeAt : 0,
      usedAt: typeof v.usedAt === "number" ? v.usedAt : 0,
      write: v.write === true,
      agent: agentScopeOf(v.agent),
      ...(makerOf(v.maker) ? { maker: makerOf(v.maker) } : {}),
    };
  } catch {
    return null;
  }
}

const clean = (name: unknown) =>
  (typeof name === "string" ? name : "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_KEY_NAME);

/** A store's keys, newest first, as the studio lists them. Never the key itself. */
export async function listKeys(sid: string): Promise<ApiKey[]> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HGETALL", listKey(sid)]]);
  const flat = Array.isArray(raw) ? raw : [];
  const out: ApiKey[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const stored = parseStored(flat[i + 1]);
    if (stored) out.push({ id: stored.id, name: stored.name, hint: stored.hint, madeAt: stored.madeAt, usedAt: stored.usedAt, write: stored.write, agent: stored.agent });
  }
  return out.sort((a, b) => b.madeAt - a.madeAt);
}

export type MakeResult = { ok: true; key: string; made: ApiKey } | { ok: false; reason: "full" | "name" | "unavailable" };

/**
 * Makes a key and returns it — the only time it is ever seen whole. `agent`
 * (631 [AA1] (c)) says what an AI agent holding it may prepare for the
 * creator to confirm; left out, nothing.
 */
export async function makeKey(sid: string, rawName: unknown, now = Date.now(), write = false, agentRaw: AgentScope = "none", makerRaw?: KeyMaker): Promise<MakeResult> {
  const maker = makerOf(makerRaw);
  const agent = agentScopeOf(agentRaw);
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  const name = clean(rawName);
  if (!name) return { ok: false, reason: "name" };
  const [count] = await redisPipeline([["HLEN", listKey(sid)]]);
  if (Number(count) >= MAX_KEYS) return { ok: false, reason: "full" };

  const key = `${KEY_PREFIX}${randomBytes(20).toString("hex")}`;
  const id = randomBytes(6).toString("hex");
  const hash = hashOf(key);
  const stored: Stored = { id, hash, name, hint: key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 6), madeAt: Math.floor(now / 1000), usedAt: 0, write, agent, ...(maker ? { maker } : {}) };
  const [, , after] = await redisPipeline([
    ["SET", lookupKey(hash), JSON.stringify({ sid, id })],
    ["HSET", listKey(sid), id, JSON.stringify(stored)],
    ["HLEN", listKey(sid)],
  ]);
  // Two tabs pressing "Make a key" at once can both pass the count above.
  // Counted again after writing, and the one just made is taken back if it
  // went over, so the limit is the limit.
  if (Number(after) > MAX_KEYS) {
    await redisPipeline([["DEL", lookupKey(hash)], ["HDEL", listKey(sid), id]]);
    return { ok: false, reason: "full" };
  }
  return { ok: true, key, made: { id, name, hint: stored.hint, madeAt: stored.madeAt, usedAt: 0, write, agent } };
}

/** Takes a key away. The next request with it is refused. */
export async function revokeKey(sid: string, id: string): Promise<boolean> {
  if (!SID_PATTERN.test(sid) || !ID_PATTERN.test(id) || !isRedisConfigured()) return false;
  const [raw] = await redisPipeline([["HGET", listKey(sid), id]]);
  const stored = parseStored(raw);
  if (!stored) return false;
  // The lookup first: from this moment the key opens nothing, whatever
  // happens to the second write.
  await redisPipeline([["DEL", lookupKey(stored.hash)], ["HDEL", listKey(sid), id], ["HDEL", holdKey(sid), id]]);
  return true;
}

/** Every key of a store with who made it and its hold, oldest first, for lib/api-key-pause.ts. */
export async function keyRecords(sid: string): Promise<KeyRecord[]> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return [];
  const [raw, holds] = await redisPipeline([["HGETALL", listKey(sid)], ["HGETALL", holdKey(sid)]]);
  const held = new Map<string, string>();
  const flatHolds = flatOf(holds);
  for (let i = 0; i + 1 < flatHolds.length; i += 2) held.set(String(flatHolds[i]), String(flatHolds[i + 1]));
  const flat = flatOf(raw);
  const out: KeyRecord[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const s = parseStored(flat[i + 1]);
    if (!s) continue;
    const hold = held.get(s.id) ?? "";
    out.push({ id: s.id, name: s.name, hint: s.hint, madeAt: s.madeAt, usedAt: s.usedAt, write: s.write, agent: s.agent, maker: s.maker ?? null, hold: HOLDS.includes(hold) ? (hold as Hold) : null });
  }
  return out.sort((a, b) => a.madeAt - b.madeAt);
}

/**
 * Sets keys' hold: paused, told, or vouched for (turned back on by their
 * maker in a session with a second step, so no later switch pauses them
 * again). Only
 * ids that are still the store's keys are written, so a key revoked before
 * leaves nothing behind (one revoked in the very same instant may leave a
 * mark of a few bytes, which opens nothing and goes with the store).
 */
export async function holdKeys(sid: string, ids: string[], state: Hold): Promise<string[]> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return [];
  const wanted = ids.filter((id) => ID_PATTERN.test(id));
  if (!wanted.length) return [];
  const present = await redisPipeline(wanted.map((id) => ["HEXISTS", listKey(sid), id]));
  const kept = wanted.filter((_, i) => Number(present[i]) === 1);
  if (kept.length) await redisPipeline([["HSET", holdKey(sid), ...kept.flatMap((id) => [id, state])]]);
  return kept;
}

/** Puts keys' holds back as they were (null: none), when a change that paused them could not be saved. */
export async function restoreHolds(sid: string, before: { id: string; hold: Hold | null }[]): Promise<void> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return;
  const valid = before.filter((b) => ID_PATTERN.test(b.id));
  const back = valid.filter((b) => b.hold !== null);
  const none = valid.filter((b) => b.hold === null);
  await redisPipeline([
    ...(back.length ? [["HSET", holdKey(sid), ...back.flatMap((b) => [b.id, b.hold as string])]] : []),
    ...(none.length ? [["HDEL", holdKey(sid), ...none.map((b) => b.id)]] : []),
  ]);
}

/**
 * Rewrites who made some keys: `left`, their maker left the team and the
 * fingerprint goes; or a fingerprint replaced by another (a teammate moving
 * their sign-in address). A key used in the very same instant may write its
 * record back as it read it ("last used"); the key stays paused all the same,
 * as its hold is kept apart.
 */
export async function rewriteMakers(sid: string, change: (maker: KeyMaker) => KeyMaker | null): Promise<string[]> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HGETALL", listKey(sid)]]);
  const flat = flatOf(raw);
  const writes: (string | number)[][] = [];
  const ids: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const s = parseStored(flat[i + 1]);
    if (!s?.maker) continue;
    const next = change(s.maker);
    if (!next) continue;
    ids.push(s.id);
    writes.push(["HSET", listKey(sid), s.id, JSON.stringify({ ...s, maker: next })]);
  }
  if (writes.length) await redisPipeline(writes);
  return ids;
}

const flatOf = (raw: unknown): unknown[] =>
  Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>).flat() : [];

/**
 * Takes every key of a store away, for a store that is deleted (added
 * 17 October 2026): the lookups first, so none opens anything, then the list.
 */
export async function revokeAllKeys(sid: string): Promise<number> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return 0;
  const [raw] = await redisPipeline([["HGETALL", listKey(sid)]]);
  const flat = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>).flat() : [];
  const hashes: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const stored = parseStored(flat[i + 1]);
    if (stored) hashes.push(stored.hash);
  }
  if (hashes.length) await redisPipeline(hashes.map((hash) => ["DEL", lookupKey(hash)]));
  await redisPipeline([["DEL", listKey(sid)], ["DEL", holdKey(sid)]]);
  return hashes.length;
}

/** How often "last used" is written: at most once a minute per key, so reading costs no write. */
const TOUCH_SECONDS = 60;

/**
 * The store a presented key belongs to, or null.
 *
 * Checked against both records, so a key whose lookup survived a revocation
 * that was cut short still opens nothing.
 */
export async function resolveKey(presented: string, now = Date.now()): Promise<{ sid: string; id: string; write: boolean; agent: AgentScope; paused: boolean } | null> {
  if (!KEY_PATTERN.test(presented) || !isRedisConfigured()) return null;
  const hash = hashOf(presented);
  const [raw] = await redisPipeline([["GET", lookupKey(hash)]]);
  if (typeof raw !== "string") return null;
  let found: { sid?: unknown; id?: unknown };
  try {
    found = JSON.parse(raw) as { sid?: unknown; id?: unknown };
  } catch {
    return null;
  }
  const sid = typeof found.sid === "string" && SID_PATTERN.test(found.sid) ? found.sid : "";
  const id = typeof found.id === "string" && ID_PATTERN.test(found.id) ? found.id : "";
  if (!sid || !id) return null;
  const [listed, hold] = await redisPipeline([["HGET", listKey(sid), id], ["HGET", holdKey(sid), id]]);
  const stored = parseStored(listed);
  if (!stored || stored.hash !== hash) return null;
  // Paused by the team's two-step rule or its maker leaving (lib/api-key-pause.ts): known, and refused, and not counted as used.
  if (hold === "paused" || hold === "told") return { sid, id, write: stored.write, agent: stored.agent, paused: true };

  const seconds = Math.floor(now / 1000);
  if (seconds - stored.usedAt >= TOUCH_SECONDS) {
    await redisPipeline([["HSET", listKey(sid), id, JSON.stringify({ ...stored, usedAt: seconds })]]).catch(() => {});
  }
  return { sid, id, write: stored.write, agent: stored.agent, paused: false };
}

/** Reads the key from an Authorization header: "Bearer nl_live_…". */
export function keyFromHeader(header: string | null): string {
  const match = (header ?? "").match(/^\s*Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : "";
}
