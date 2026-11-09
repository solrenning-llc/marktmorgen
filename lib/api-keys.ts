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
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { deriveKey, deriveLegacyKey } from "@/lib/secret-box";
import { type Member, parseTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";

import { type AgentScope, type ApiKey, KEY_PREFIX, MAX_KEYS, MAX_KEY_NAME, agentScopeOf } from "@/lib/api-key-rules";
export { type AgentScope, type ApiKey, KEY_PREFIX, MAX_KEYS, MAX_KEY_NAME };
const KEY_PATTERN = /^nl_live_[0-9a-f]{40}$/;
const ID_PATTERN = /^[0-9a-f]{12}$/;
const SID_PATTERN = /^[0-9a-f]{32}$/;

const lookupKey = (hash: string) => `nl:api:k:${hash}`;
const listKey = (sid: string) => `nl:api:keys:${sid}`;
const holdKey = (sid: string) => `nl:api:hold:${sid}`;
/** When each key was last used, apart from its record, so that writing it can never put back what a rewrite of the record took out. */
const usedKey = (sid: string) => `nl:api:used:${sid}`;
/** The store's team record (lib/team.ts teamKey), read by resolveKey. */
const teamRecordKey = (sid: string) => `nl:team:${sid}`;
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
 * told; "told", refused, its maker emailed (or nobody to tell); "left",
 * refused for good, its maker left the team; "role", refused, its maker's
 * role no longer allows it, until the owner turns it back on; "unmatched",
 * refused, its maker's fingerprint matches nobody on the team (a secret
 * changed, or a change half done), until the owner turns it back on;
 * "vouched", turned back on (by its maker with a second step, or by the owner,
 * who for an unmatched key first says whose it is); none, as made. A vouched
 * key still answers to the team as it is: its maker's role, and its maker
 * being on the team (pauseWhy).
 */
export type Hold = "paused" | "told" | "left" | "role" | "unmatched" | "vouched";
const HOLDS: readonly string[] = ["paused", "told", "left", "role", "unmatched", "vouched"];
/**
 * A hold as read: one of HOLDS, or "unknown" for a stored value this code does not know (a later version's,
 * after a rollback). Unknown refuses the key (pauseWhy "unknown"), is never written, and is never matched by a
 * change (swapHolds), so it stays until the key is revoked (Claude 2 on #3096: read as no hold, the key worked).
 */
export type KeyHold = Hold | "unknown";
/** Whether a hold refuses the key. */
export const isPaused = (hold: KeyHold | null): boolean => hold !== null && hold !== "vouched";

/** A key's record with who made it and its hold, never the key or its fingerprint. */
export type KeyRecord = ApiKey & { maker: KeyMaker | null; hold: KeyHold | null };

/**
 * A one-way fingerprint of a teammate's sign-in address on one store: an HMAC
 * under a key derived from the deployment's secret, over the store's id and
 * the address. "" when the deployment has no secret: then nobody is recorded,
 * and the key counts as one whose maker is not known (paused by the team's
 * two-step rule, turned back on only by the owner).
 */
export function makerPrint(sid: string, email: string): string {
  return printUnder(deriveKey(PRINT_LABEL), sid, email);
}

const PRINT_LABEL = "api-key-maker/v1";
const printUnder = (key: Buffer | null, sid: string, email: string): string =>
  key ? createHmac("sha256", key).update(`${sid}|${email.trim().toLowerCase()}`).digest("hex").slice(0, 40) : "";

/**
 * Every fingerprint a teammate's keys may carry: under the deployment's
 * secret now, and under the one it had before NIMBUS_DATA_KEY was set
 * (lib/secret-box.ts deriveLegacyKey), so setting that secret does not make
 * every teammate's keys read as a stranger's. Matching uses these; a key is
 * made with the first.
 */
export function makerPrints(sid: string, email: string): string[] {
  return [...new Set([makerPrint(sid, email), printUnder(deriveLegacyKey(PRINT_LABEL), sid, email)])].filter((p) => p !== "");
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

/** The store's list of keys, field and value by turns, only in that exact shape (audit SG2, finding 23). */
async function readList(sid: string): Promise<string[]> {
  const [raw] = await redisPipeline([["HGETALL", listKey(sid)]]);
  const flat = stringList(raw);
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("a store's API keys");
  return flat;
}

/**
 * A store's keys, newest first, as the studio lists them. Never the key
 * itself. A list that cannot be read throws: it is never shown as no keys.
 */
export async function listKeys(sid: string): Promise<ApiKey[]> {
  // Strict: a list, its holds or its uses read in another shape throw, never shown as no keys (audit SG2, finding 23).
  return (await keyRecords(sid, true)).map(({ id, name, hint, madeAt, usedAt, write, agent }) => ({ id, name, hint, madeAt, usedAt, write, agent })).sort((a, b) => b.madeAt - a.madeAt);
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
  // An unknown count is not room for one more (audit SG2, rule 30).
  const held = countOf(count);
  if (held === null) return { ok: false, reason: "unavailable" };
  if (held >= MAX_KEYS) return { ok: false, reason: "full" };

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
  // went over, or if the count cannot be read, so the limit is the limit.
  const afterCount = countOf(after);
  if (afterCount === null || afterCount > MAX_KEYS) {
    await redisPipeline([["DEL", lookupKey(hash)], ["HDEL", listKey(sid), id]]);
    return { ok: false, reason: afterCount === null ? "unavailable" : "full" };
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
  await redisPipeline([["DEL", lookupKey(stored.hash)], ["HDEL", listKey(sid), id], ["HDEL", holdKey(sid), id], ["HDEL", usedKey(sid), id]]);
  return true;
}

/**
 * Every key of a store with who made it and its hold, oldest first, for lib/api-key-pause.ts and the studio's
 * list (listKeys). Each of the three replies must be a list of fields and values, and each hold one this file
 * knows, or this throws (audit SG2, finding 23; CX-123 rule 24): never read as no keys or no hold, which would
 * let a teammate leaving, a role change or the two-step rule pass over a key that still opens the store.
 * `_strict` is kept only so callers that asked for this reading still read the same; every read is strict.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for callers that pass it (#2899 adds one)
export async function keyRecords(sid: string, _strict?: true): Promise<KeyRecord[]> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["HGETALL", listKey(sid)], ["HGETALL", holdKey(sid)], ["HGETALL", usedKey(sid)]]), 3);
  if (!replies || replies.some((reply) => {
    const flat = stringList(reply);
    return !flat || flat.length % 2 !== 0;
  })) throw new UnknownReplyError("a store's API keys");
  const [raw, holds, uses] = replies;
  const held = mapOf(holds);
  const used = mapOf(uses);
  const flat = flatOf(raw);
  const out: KeyRecord[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const s = parseStored(flat[i + 1]);
    if (!s) continue;
    const usedAt = Math.max(s.usedAt, Number(used.get(s.id)) || 0);
    out.push({ id: s.id, name: s.name, hint: s.hint, madeAt: s.madeAt, usedAt, write: s.write, agent: s.agent, maker: s.maker ?? null, hold: holdOf(held.get(s.id)) });
  }
  return out.sort((a, b) => a.madeAt - b.madeAt);
}

/**
 * Changes keys' holds only from what the caller read (a compare-and-set, in
 * one step on the database): each id whose hold is now one of `from` (null:
 * none) and that is still one of the store's keys takes `to` (null: none).
 * Returns the ids changed. So a hold written meanwhile by somebody else (a
 * teammate leaving, the owner pausing) is never overwritten by a change
 * decided on what was there before.
 */
export async function swapHolds(sid: string, ids: string[], to: Hold | null, from: readonly (KeyHold | null)[]): Promise<string[]> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return [];
  const wanted = [...new Set(ids.filter((id) => ID_PATTERN.test(id)))];
  // An unknown hold is never a value to change from: it stays, refusing the key, until the key is revoked.
  const known = from.filter((f) => f !== "unknown");
  if (!wanted.length || !known.length) return [];
  const [changed] = await redisPipeline([["EVAL", HOLD_SWAP, 2, holdKey(sid), listKey(sid), to ?? "", wanted.length, ...wanted, ...known.map((f) => f ?? "")]]);
  return Array.isArray(changed) ? changed.map(String).filter((id) => wanted.includes(id)) : [];
}

/** Every hold but the one for good: what any change may start from. */
export const NOT_LEFT: (Hold | null)[] = [null, "paused", "told", "role", "unmatched", "vouched"];

/** The compare-and-set swapHolds runs, modelled by lib/redis-memory.ts. */
export const HOLD_SWAP = `-- marktmorgen:api-hold-swap:v1
local n = tonumber(ARGV[2])
local changed = {}
for i = 1, n do
  local f = ARGV[2 + i]
  if redis.call('HEXISTS', KEYS[2], f) == 1 then
    local v = redis.call('HGET', KEYS[1], f) or ''
    for j = 3 + n, #ARGV do
      if v == ARGV[j] then
        if ARGV[1] == '' then redis.call('HDEL', KEYS[1], f) else redis.call('HSET', KEYS[1], f, ARGV[1]) end
        changed[#changed + 1] = f
        break
      end
    end
  end
end
return changed`;

/**
 * A hold as stored: none (no field), one this file knows, or "unknown" for any other value, which refuses the
 * key (rule 24: never no hold). It does not throw, so the owner still sees the key and can revoke it, and its
 * maker can still be taken off the team (Claude 2 on #3096). A reply in another shape is checked by the caller.
 */
function holdOf(raw: string | null | undefined): KeyHold | null {
  if (raw === null || raw === undefined) return null;
  return HOLDS.includes(raw) ? (raw as Hold) : "unknown";
}

/**
 * The store's team record as lib/api-keys.ts reads it: only null is no team (a store nobody was invited to).
 * Anything else that is not the record's JSON object with both lists of objects and a rule that is true or
 * false throws UnknownReplyError (rule 24), never read as no team, which turned the two-step rule off and let a
 * key it pauses work (Claude 2 on #3096). The same reading as lib/team.ts parseTeam on #2036.
 */
function teamOf(raw: unknown): ReturnType<typeof parseTeam> {
  if (raw === null) return parseTeam(null);
  const unknown = () => new UnknownReplyError("a store's team record");
  if (typeof raw !== "string") throw unknown();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw unknown();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unknown();
  const fields = value as { members?: unknown; invites?: unknown; requireTwoStep?: unknown };
  for (const entries of [fields.members, fields.invites]) {
    if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw unknown();
  }
  if (fields.requireTwoStep !== undefined && typeof fields.requireTwoStep !== "boolean") throw unknown();
  return parseTeam(raw);
}

/** An HMGET's reply: exactly one field for each asked, each its text or nothing (null); anything else throws (rule 24). */
function fieldsOf(reply: unknown, count: number): (string | null)[] {
  const slots = repliesFor(reply, count);
  if (!slots || slots.some((slot) => slot !== null && typeof slot !== "string")) throw new UnknownReplyError("a store's API keys");
  return slots as (string | null)[];
}

/**
 * Whether each of these keys of a store is in use, paused (held, its maker gone from the team, or a hold this
 * file does not know) or gone (revoked: no record). A reply in another shape, a record or a team record that
 * does not read throws UnknownReplyError (CX-123 rule 24): never "gone", which would fail a webhook delivery for
 * good or pass over an endpoint, and never "live", which would send to the endpoint of a key that is paused.
 */
export async function keyStates(sid: string, ids: string[]): Promise<Map<string, "live" | "paused" | "gone">> {
  const out = new Map<string, "live" | "paused" | "gone">();
  const wanted = [...new Set(ids.filter((id) => ID_PATTERN.test(id)))];
  if (!wanted.length) return out;
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) {
    for (const id of wanted) out.set(id, "gone");
    return out;
  }
  const replies = repliesFor(await redisPipeline([["HMGET", listKey(sid), ...wanted], ["HMGET", holdKey(sid), ...wanted], ["GET", teamRecordKey(sid)]]), 3);
  if (!replies) throw new UnknownReplyError("a store's API keys");
  const records = fieldsOf(replies[0], wanted.length);
  const holds = fieldsOf(replies[1], wanted.length);
  const { members, requireTwoStep } = teamOf(replies[2]);
  wanted.forEach((id, at) => {
    const raw = records[at];
    if (raw === null) {
      out.set(id, "gone");
      return;
    }
    const stored = parseStored(raw);
    if (!stored || stored.id !== id) throw new UnknownReplyError("an API key record");
    // The same reading as a request with the key (pauseWhy): its hold, or a maker no longer on the team.
    out.set(id, pauseWhy(sid, stored.maker ?? null, holdOf(holds[at]), members, stored.write, requireTwoStep === true) ? "paused" : "live");
  });
  return out;
}

/**
 * Rewrites who made some keys: `left`, their maker left the team and the
 * fingerprint goes; or a fingerprint replaced by another (a teammate moving
 * their sign-in address). "Last used" is kept apart from the record, so a
 * request using the key at that instant cannot write the old maker back.
 */
export async function rewriteMakers(sid: string, change: (maker: KeyMaker, id: string) => KeyMaker | null): Promise<string[]> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return [];
  const done: string[] = [];
  // Each record is written only over exactly the text read (RECORD_SWAP), so a key revoked meanwhile is never
  // written back, and one changed meanwhile is read again, a few times at most; still changing after that,
  // this throws, so a caller that must not go on half done (a move) undoes what it did.
  for (let tries = 0; ; tries += 1) {
    // The list read in another shape throws (readList, rule 24): never "nothing to rewrite", which would leave
    // a former teammate's fingerprint on their keys.
    const flat = await readList(sid);
    const swaps: string[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const s = parseStored(flat[i + 1]);
      if (!s?.maker || done.includes(s.id)) continue;
      const next = change(s.maker, s.id);
      if (!next) continue;
      swaps.push(s.id, String(flat[i + 1]), JSON.stringify({ ...s, maker: next }));
    }
    if (!swaps.length) break;
    if (tries >= 3) throw new Error("The records of some API keys kept changing while their maker was rewritten.");
    const [changed] = await redisPipeline([["EVAL", RECORD_SWAP, 1, listKey(sid), ...swaps]]);
    const ids = Array.isArray(changed) ? changed.map(String) : [];
    done.push(...ids);
    if (ids.length * 3 === swaps.length) break;
  }
  return done;
}

/**
 * Records whose a key is when nobody was recorded as its maker (keys made
 * before 4 November 2026), written only over exactly the text read
 * (RECORD_SWAP): a key revoked meanwhile, or given a maker meanwhile, is left
 * as it is. Returns whether it was written.
 */
export async function claimMaker(sid: string, id: string, maker: KeyMaker): Promise<boolean> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return false;
  const [raw] = await redisPipeline([["HGET", listKey(sid), id]]);
  if (typeof raw !== "string") return false;
  const stored = parseStored(raw);
  if (!stored || stored.id !== id || stored.maker) return false;
  const [changed] = await redisPipeline([["EVAL", RECORD_SWAP, 1, listKey(sid), id, raw, JSON.stringify({ ...stored, maker })]]);
  return Array.isArray(changed) && changed.map(String).includes(id);
}

/** Writes key records only over exactly the text read: nothing for a record gone (revoked) or changed. Modelled by lib/redis-memory.ts. */
export const RECORD_SWAP = `-- marktmorgen:api-key-record-swap:v1
local changed = {}
for i = 1, #ARGV, 3 do
  if redis.call('HGET', KEYS[1], ARGV[i]) == ARGV[i + 1] then
    redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 2])
    changed[#changed + 1] = ARGV[i]
  end
end
return changed`;

/**
 * Why a key is refused (lib/api-guard.ts says it in these terms): "rule", the
 * team's two-step rule, turned back on by whoever made it; "left", made by
 * somebody who left the team, only revoked, by the owner; "unmatched", its
 * maker could not be matched to anybody on the team, turned back on by the
 * owner; "role", its maker's role does not allow it, turned back on by the
 * owner; "unrecorded", nobody is recorded as its maker, turned back on by the
 * owner; "unknown", its hold (or, for a request, the team) could not be read:
 * refused, turned back on by nobody, revoked by the owner.
 */
export type PauseWhy = "rule" | "left" | "unmatched" | "role" | "unrecorded" | "unknown";

/**
 * Why a key is refused, or null when it is not: its hold, or its maker read
 * against the team as it is (lib/team.ts parseTeam, so only members the
 * studio accepts count). A teammate's key whose fingerprint matches nobody on
 * the team is refused as unmatched, and one whose maker's role does not allow
 * it (any key without "export", one that writes without "import") as role,
 * whatever wrote, or failed to write, its hold, and whether or not it was
 * turned back on before. While the team's two-step rule is on (`rule`, read
 * from the same record), a key that is not the owner's, was not made with a
 * second step and was not turned back on is refused too, with no hold
 * needed: the switch's pauses and emails only record and tell (owner C3-121).
 */
export function pauseWhy(sid: string, maker: KeyMaker | null, hold: KeyHold | null, members: Pick<Member, "email" | "role">[], write: boolean, rule = false): PauseWhy | null {
  if (hold === "left" || maker?.left) return "left";
  if (hold === "unknown") return "unknown";
  if (maker && !maker.owner) {
    const member = members.find((m) => makerPrints(sid, m.email).includes(maker.by));
    if (!member) return "unmatched";
    if (!can(member.role, "export") || (write && !can(member.role, "import"))) return "role";
  }
  if (hold === "unmatched") return "unmatched";
  if (hold === "role") return maker ? "role" : "unrecorded";
  if (isPaused(hold)) return maker ? "rule" : "unrecorded";
  if (rule && hold !== "vouched" && !maker?.owner && !maker?.step) return maker ? "rule" : "unrecorded";
  return null;
}

function mapOf(raw: unknown): Map<string, string> {
  const flat = flatOf(raw);
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < flat.length; i += 2) out.set(String(flat[i]), String(flat[i + 1]));
  return out;
}

const flatOf = (raw: unknown): unknown[] =>
  Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>).flat() : [];

/**
 * Takes every key of a store away, for a store that is deleted (added
 * 17 October 2026): the lookups first, so none opens anything, then the list.
 */
export async function revokeAllKeys(sid: string, apply: (commands: (string | number)[][]) => Promise<unknown> = redisPipeline): Promise<number> {
  if (!SID_PATTERN.test(sid) || !isRedisConfigured()) return 0;
  // The list is the only way to the lookups (audit SG2, rule 30): unread, nothing is deleted and this fails.
  const flat = await readList(sid);
  const hashes: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const stored = parseStored(flat[i + 1]);
    if (stored) hashes.push(stored.hash);
  }
  // `apply` sends the deletes: the closing walk's makes them only while it still holds the store's lock (lib/closed-store-data.ts, fencedBy).
  if (hashes.length) await apply(hashes.map((hash) => ["DEL", lookupKey(hash)]));
  await apply([["DEL", listKey(sid)], ["DEL", holdKey(sid)], ["DEL", usedKey(sid)]]);
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
export async function resolveKey(presented: string, now = Date.now()): Promise<{ sid: string; id: string; write: boolean; agent: AgentScope; paused: boolean; why?: PauseWhy } | null> {
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
  // The team is read in the same trip, one command more (within an API request's own price, UNIT_COST.api in
  // tests/plan-cost-registry.ts): a teammate's key is refused once its maker is not on the team.
  const [listed, hold, used, team] = await redisPipeline([["HGET", listKey(sid), id], ["HGET", holdKey(sid), id], ["HGET", usedKey(sid), id], ["GET", teamRecordKey(sid)]]);
  const stored = parseStored(listed);
  if (!stored || stored.hash !== hash) return null;
  // Paused by the team's two-step rule, its maker's role, or its maker leaving (lib/api-key-pause.ts):
  // known, refused, and not counted as used. A maker who left refuses it even with no hold written.
  // A hold this file does not know, or one read in another shape, refuses the key (holdOf), never no hold.
  const holdNow = hold === null ? null : typeof hold === "string" ? holdOf(hold) : "unknown";
  // A team record that does not read refuses the key (teamOf), never no team, which would turn the two-step rule off.
  let read: ReturnType<typeof parseTeam>;
  try {
    read = teamOf(team);
  } catch {
    return { sid, id, write: stored.write, agent: stored.agent, paused: true, why: "unknown" };
  }
  const why = pauseWhy(sid, stored.maker ?? null, holdNow, read.members, stored.write, read.requireTwoStep === true);
  if (why) return { sid, id, write: stored.write, agent: stored.agent, paused: true, why };

  const seconds = Math.floor(now / 1000);
  // Its own field: the record is never written back here, so a rewrite of who made it is never undone.
  if (seconds - Math.max(stored.usedAt, Number(used) || 0) >= TOUCH_SECONDS) {
    await redisPipeline([["HSET", usedKey(sid), id, String(seconds)]]).catch(() => {});
  }
  return { sid, id, write: stored.write, agent: stored.agent, paused: false };
}

/** Reads the key from an Authorization header: "Bearer nl_live_…". */
export function keyFromHeader(header: string | null): string {
  const match = (header ?? "").match(/^\s*Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : "";
}
