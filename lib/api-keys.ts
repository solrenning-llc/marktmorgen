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
 *   nl:api:keys:<sid>        the store's keys, by id: name, made, last used
 */
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

import { type AgentScope, type ApiKey, KEY_PREFIX, MAX_KEYS, MAX_KEY_NAME, agentScopeOf } from "@/lib/api-key-rules";
export { type AgentScope, type ApiKey, KEY_PREFIX, MAX_KEYS, MAX_KEY_NAME };
const KEY_PATTERN = /^nl_live_[0-9a-f]{40}$/;
const ID_PATTERN = /^[0-9a-f]{12}$/;
const SID_PATTERN = /^[0-9a-f]{32}$/;

const lookupKey = (hash: string) => `nl:api:k:${hash}`;
const listKey = (sid: string) => `nl:api:keys:${sid}`;
const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

type Stored = ApiKey & { hash: string };

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
export async function makeKey(sid: string, rawName: unknown, now = Date.now(), write = false, agentRaw: AgentScope = "none"): Promise<MakeResult> {
  const agent = agentScopeOf(agentRaw);
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  const name = clean(rawName);
  if (!name) return { ok: false, reason: "name" };
  const [count] = await redisPipeline([["HLEN", listKey(sid)]]);
  if (Number(count) >= MAX_KEYS) return { ok: false, reason: "full" };

  const key = `${KEY_PREFIX}${randomBytes(20).toString("hex")}`;
  const id = randomBytes(6).toString("hex");
  const hash = hashOf(key);
  const stored: Stored = { id, hash, name, hint: key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 6), madeAt: Math.floor(now / 1000), usedAt: 0, write, agent };
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
  await redisPipeline([["DEL", lookupKey(stored.hash)], ["HDEL", listKey(sid), id]]);
  return true;
}

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
  await redisPipeline([["DEL", listKey(sid)]]);
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
export async function resolveKey(presented: string, now = Date.now()): Promise<{ sid: string; id: string; write: boolean; agent: AgentScope } | null> {
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
  const [listed] = await redisPipeline([["HGET", listKey(sid), id]]);
  const stored = parseStored(listed);
  if (!stored || stored.hash !== hash) return null;

  const seconds = Math.floor(now / 1000);
  if (seconds - stored.usedAt >= TOUCH_SECONDS) {
    await redisPipeline([["HSET", listKey(sid), id, JSON.stringify({ ...stored, usedAt: seconds })]]).catch(() => {});
  }
  return { sid, id, write: stored.write, agent: stored.agent };
}

/** Reads the key from an Authorization header: "Bearer nl_live_…". */
export function keyFromHeader(header: string | null): string {
  const match = (header ?? "").match(/^\s*Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : "";
}
