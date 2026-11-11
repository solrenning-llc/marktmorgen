/**
 * Where each teammate's pipeline restrictions are kept (639 [GL7](7), the
 * rules in lib/pipeline-access-rules.ts):
 *
 *   nl:crm:pacc:<statsId>   hash: <teammate's address> -> their AccessMap, as JSON
 *   nl:crm:pacc:lock:<statsId>:<address>   held for at most 10 seconds while one change to that teammate is written
 *
 * Only restrictions are written; a teammate with none has no field, and
 * every pipeline is "edit" for them, as before. The record takes, or gives
 * back, room in the store's data room before it is written, and goes with
 * the store. A teammate's field is deleted when they leave the team
 * (forgetPipelineAccess).
 *
 * Each reply is read in its exact shape (lib/redis-reply.ts, CX-123 rule 24):
 * HGET answers exactly null for a teammate never restricted, or the stored
 * text. Any other reply (none, an empty or sparse list, another type) is
 * unknown and throws UnknownReplyError, so the caller refuses and changes
 * nothing; it is never taken for "no restriction" (sweep app1 finding 2).
 */
import { randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { type AccessMap, type PipelineAccess, parseAccessMap } from "@/lib/pipeline-access-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { DataRoomError, type DataStore, forceData, giveData, needData } from "@/lib/store-data";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { dataBytes } from "@/lib/store-data-rules";

const accessKey = (statsId: string) => `nl:crm:pacc:${statsId}`;
const ACCESS_SLOT = "crm:pacc";
const lockKey = (statsId: string, who: string) => `nl:crm:pacc:lock:${statsId}:${who}`;
const LOCK_SECONDS = 10;

/** Someone else is changing the same teammate's access at this moment; nothing was written. */
export class PipelineAccessBusyError extends Error {
  constructor() {
    super("Someone else is changing this person's access right now. Try again in a moment.");
  }
}

/** The teammate's access was changed somewhere else (another tab, another person) since the page that saves was opened; nothing was written. */
export class PipelineAccessChangedError extends Error {
  constructor() {
    super("This person's access was changed somewhere else since you opened this page. Reload the page to see it, then choose again.");
  }
}

/** Two records read the same way: the same restrictions, whatever order they were written in; null only equals null. */
export function sameAccess(a: AccessMap | null, b: AccessMap | null): boolean {
  if (a === null || b === null) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((id) => Object.hasOwn(b, id) && a[id] === b[id]);
}

/**
 * One teammate's field, exactly: null when it was never set, or the stored text. Any other reply throws
 * UnknownReplyError; it is never read as "no restriction".
 */
async function fieldOf(statsId: string, who: string): Promise<string | null> {
  const raw = repliesFor(await redisPipeline([["HGET", accessKey(statsId), who]]), 1)?.[0];
  if (raw === null || typeof raw === "string") return raw;
  throw new UnknownReplyError("a teammate's pipeline access");
}

/**
 * A field as stored: only a field never set (exactly null) is no restriction; one that cannot be read is null,
 * which opens nothing (accessOf).
 */
function mapOf(raw: string | null): AccessMap | null {
  if (raw === null) return {};
  if (raw.length > 4_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const map = parseAccessMap(value);
    // A record holding anything that is not a real restriction ({"sales0":"VIEW"}, {"SALES0":"none"}) cannot be
    // read as written: it opens nothing, never no restriction.
    return Object.keys(map).length === Object.keys(value).length ? map : null;
  } catch {
    return null;
  }
}

/**
 * One teammate's restrictions. A record that cannot be read is null, so it
 * opens nothing (accessOf), and a read that fails or answers in an unknown
 * shape throws, so the caller refuses: neither is ever taken for no restriction.
 */
export async function readPipelineAccess(statsId: string | null, email: string): Promise<AccessMap | null> {
  if (!statsId || !isRedisConfigured()) return {};
  return mapOf(await fieldOf(statsId, normaliseEmail(email)));
}

/** Every teammate's restrictions, by address. HGETALL's reply must be exactly a list of field/value pairs, or it throws. */
export async function readAllPipelineAccess(statsId: string | null): Promise<Record<string, AccessMap | null>> {
  if (!statsId || !isRedisConfigured()) return {};
  const flat = stringList(repliesFor(await redisPipeline([["HGETALL", accessKey(statsId)]]), 1)?.[0]);
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("every teammate's pipeline access");
  const out: Record<string, AccessMap | null> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = mapOf(flat[i + 1]);
  return out;
}

/**
 * Sets a teammate's restrictions; none deletes their field. Room is taken (or given back) first. What was there is
 * read exactly; an unknown reply throws before any room is taken or anything is written.
 */
export async function writePipelineAccess(statsId: string, email: string, map: AccessMap, room: DataStore): Promise<AccessMap> {
  const who = normaliseEmail(email);
  const clean = parseAccessMap(map);
  const before = await fieldOf(statsId, who);
  const value = Object.keys(clean).length ? JSON.stringify(clean) : "";
  const weight = (v: unknown) => (typeof v === "string" && v ? dataBytes([who, v], 1) : 0);
  const grown = weight(value) - weight(before);
  if (grown > 0) await needData(room, [{ slot: ACCESS_SLOT, bytes: grown }]);
  const written = oneAnswer(await redisPipeline([value ? ["HSET", accessKey(statsId), who, value] : ["HDEL", accessKey(statsId), who]]));
  // Saved only on the exact answer of that one command (0 or 1); anything else is not a saved restriction, and the
  // owner is told it was not saved, never shown the new access as applied (Codex D, #2036). The room taken stays.
  if (written === null) throw new PipelineAccessWriteUnconfirmed();
  if (grown < 0) await giveData(room, [{ slot: ACCESS_SLOT, bytes: -grown }]);
  return clean;
}

/** A restriction whose write did not answer as written: nothing may be taken as saved. */
export class PipelineAccessWriteUnconfirmed extends Error {
  constructor() {
    super("We could not confirm this person's access was saved. Reload the page to see what it is now, then choose again if it is not what you chose.");
  }
}

/** The answer of a pipeline of one HSET or HDEL when it is exactly one 0 or 1; null for anything else. */
function oneAnswer(reply: unknown): 0 | 1 | null {
  return Array.isArray(reply) && reply.length === 1 && (reply[0] === 0 || reply[0] === 1) ? reply[0] : null;
}

/**
 * The first step of a teammate moving their sign-in to another address
 * (lib/team.ts, moveMemberships): their restrictions are copied, as they
 * are, unreadable or not, to the new address BEFORE the team record names
 * it. Throws when the copy cannot be confirmed; the caller then leaves that
 * store's membership on the old address, so the new one never has a store
 * without its restrictions. The old field is deleted only once the team
 * record has moved (forgetPipelineAccess). Answers what the new address
 * held before and holds now, so a move that fails after it can put the new
 * address back as it was (undoPipelineAccessCopy).
 */
export async function copyPipelineAccess(store: DataStore, from: string, to: string): Promise<PipelineAccessCopy> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured()) return UNCHANGED;
  const before = normaliseEmail(from);
  const after = normaliseEmail(to);
  if (before === after) return UNCHANGED;
  // Both answers exactly, before anything moves, each by the one exact reader (fieldOf, main's #2989): a text or null
  // each (nothing recorded). A partial or empty reply, or one of another kind, is not "no restriction": it throws
  // UnknownReplyError, and the caller keeps the membership on the old address, its restrictions in place (Codex D,
  // #2036: a missing answer moved a restricted teammate unrestricted).
  const raw = await fieldOf(statsId, before);
  const old = await fieldOf(statsId, after);
  const weight = (v: unknown) => (typeof v === "string" && v ? dataBytes([after, v], 1) : 0);
  if (raw === null) {
    // No restriction to carry (the field was never set): a field the new address had from before (someone else's,
    // long gone) must not restrict them, so it goes, and gives its room back. Any stored text, an empty one
    // included, is carried as it is: a record that cannot be read opens nothing (mapOf), and moving it must not
    // turn it into no restriction (Claude 1, #2036).
    if (weight(old) === 0) return UNCHANGED;
    const deleted = oneAnswer(await redisPipeline([["HDEL", accessKey(statsId), after]]).catch(() => null));
    // Not confirmed: it may have landed, so what the new address held is carried, for the caller to put it back.
    if (deleted === null) throw new PipelineAccessCopyUnconfirmed({ prior: old, now: null }, 0);
    if (deleted === 0) return UNCHANGED;
    await giveData(store, [{ slot: ACCESS_SLOT, bytes: weight(old) }]);
    return { prior: old, now: null };
  }
  // A record moved, not a new one. Its room is taken BEFORE it is written, so a write that lands is never left
  // uncounted; a full data room still never leaves a teammate off the store when they change their sign-in (it
  // is then counted as it is, forceData never refusing), but a room that cannot be counted refuses the copy, and
  // the caller keeps the membership on the old address. A field the new address already had (read under the
  // team's lock, as every write to it is) is written over, so only the difference is counted. A write that
  // cannot be confirmed keeps the room taken (too much counted, never too little) and throws; room is given
  // back only once a smaller record is confirmed written.
  const grown = weight(String(raw)) - weight(old);
  if (grown > 0) {
    try {
      await needData(store, [{ slot: ACCESS_SLOT, bytes: grown }]);
    } catch (error) {
      if (!(error instanceof DataRoomError)) throw error;
      // Full: counted all the same, and a count that cannot be made refuses the copy (forceData throws).
      await forceData(store, [{ slot: ACCESS_SLOT, bytes: grown }]);
    }
  }
  // The exact answer of that one command, before the membership moves: an extra answer, or one of another kind, is
  // not a copy (Codex D and G2, #2036: [1, 1] for a write that never landed moved a restricted teammate unrestricted).
  // A write whose answer never came back (a lost connection, a timeout) is the same: it may have landed.
  const written = oneAnswer(await redisPipeline([["HSET", accessKey(statsId), after, String(raw)]]).catch(() => null));
  // Not confirmed: the write may have landed with its answer lost (Codex G, #2036), so what the new address held
  // before, read under the same lock, and the room taken for it go with the error, for the caller to put it back.
  if (written === null) throw new PipelineAccessCopyUnconfirmed({ prior: old, now: String(raw) }, Math.max(0, grown));
  if (grown < 0) await giveData(store, [{ slot: ACCESS_SLOT, bytes: -grown }]);
  return { prior: old, now: String(raw) };
}

/** What a copy found at the new address (`prior`) and left there (`now`): null for no record. */
export type PipelineAccessCopy = { prior: string | null; now: string | null };
const UNCHANGED: PipelineAccessCopy = { prior: null, now: null };

/**
 * A copy whose write could not be confirmed: it may have landed. It carries
 * what the new address held before (read under the team's lock) and the room
 * the copy took, so the caller puts the new address back as it was
 * (undoUnconfirmedCopy) whether or not the write landed.
 */
export class PipelineAccessCopyUnconfirmed extends Error {
  constructor(readonly copy: PipelineAccessCopy, readonly taken: number) {
    super("copying a teammate's pipeline access could not be confirmed");
    this.name = "PipelineAccessCopyUnconfirmed";
  }
}

/**
 * Puts the new address back as it was before a copy that could not be
 * confirmed: what it held is written back (or its field deleted), which is
 * right whether or not the copy landed, and the room the copy took is given
 * back only once that is confirmed. Run under the same team lock as the copy.
 */
export async function undoUnconfirmedCopy(store: DataStore, to: string, unconfirmed: PipelineAccessCopyUnconfirmed): Promise<void> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured()) return;
  const after = normaliseEmail(to);
  const prior = unconfirmed.copy.prior;
  const put = oneAnswer(await redisPipeline([prior ? ["HSET", accessKey(statsId), after, prior] : ["HDEL", accessKey(statsId), after]]));
  if (put === null) throw new Error("putting back the new address's pipeline access could not be confirmed");
  if (unconfirmed.taken > 0) await giveData(store, [{ slot: ACCESS_SLOT, bytes: unconfirmed.taken }]);
}

/**
 * A move that failed after copyPipelineAccess (lib/team.ts, moveMemberships:
 * the API keys could not follow, so the membership stays on the old
 * address): the new address gets back what it held before the copy, and the
 * data room moves by exactly that difference (Codex N, #2036). Run under the
 * same team lock as the copy, as every write to this record is. The room is
 * taken before a larger record is written back and given back only once a
 * smaller one is confirmed; a write that cannot be confirmed keeps what was
 * taken (too much counted, never too little) and throws.
 */
export async function undoPipelineAccessCopy(store: DataStore, to: string, copy: PipelineAccessCopy): Promise<void> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured() || copy.prior === copy.now) return;
  const after = normaliseEmail(to);
  const weight = (v: string | null) => (v ? dataBytes([after, v], 1) : 0);
  const grown = weight(copy.prior) - weight(copy.now);
  if (grown > 0) {
    try {
      await needData(store, [{ slot: ACCESS_SLOT, bytes: grown }]);
    } catch (error) {
      if (!(error instanceof DataRoomError)) throw error;
      await forceData(store, [{ slot: ACCESS_SLOT, bytes: grown }]);
    }
  }
  const put = oneAnswer(await redisPipeline([copy.prior !== null ? ["HSET", accessKey(statsId), after, copy.prior] : ["HDEL", accessKey(statsId), after]]));
  if (put === null) throw new Error("putting back the new address's pipeline access could not be confirmed");
  if (grown < 0) await giveData(store, [{ slot: ACCESS_SLOT, bytes: -grown }]);
}

/** A teammate who left: their restrictions go with them, and the room they took is given back. */
export async function forgetPipelineAccess(store: DataStore, email: string): Promise<void> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured()) return;
  const who = normaliseEmail(email);
  // Room is given back only on the exact replies; an unknown one keeps it counted, never giving back room still in use.
  const [raw, deleted] = repliesFor(await redisPipeline([["HGET", accessKey(statsId), who], ["HDEL", accessKey(statsId), who]]), 2) ?? [];
  if (deleted === 1 && typeof raw === "string" && raw) await giveData(store, [{ slot: ACCESS_SLOT, bytes: dataBytes([who, raw], 1) }]);
}

/**
 * One teammate's access to one pipeline set to `access`, the rest of their
 * restrictions kept. One change per teammate at a time (a short lock), so
 * two people saving at once never write over each other's choice: the
 * second is refused with PipelineAccessBusyError and nothing is written. A
 * record that cannot be read opens nothing, so the change starts from "no
 * access" to every pipeline the store has, never from no restriction.
 */
export async function setPipelineAccess(statsId: string, email: string, pipelineIds: readonly string[], pipelineId: string, access: PipelineAccess, room: DataStore): Promise<AccessMap> {
  const who = normaliseEmail(email);
  const token = randomBytes(12).toString("hex");
  const [claimed] = await redisPipeline([["SET", lockKey(statsId, who), token, "NX", "EX", LOCK_SECONDS]]);
  if (claimed !== "OK") throw new PipelineAccessBusyError();
  try {
    return (await writeChoices(statsId, who, pipelineIds, { [pipelineId]: access }, room)).saved;
  } finally {
    const [held] = await redisPipeline([["GET", lockKey(statsId, who)]]).catch(() => [null]);
    if (held === token) await redisPipeline([["DEL", lockKey(statsId, who)]]).catch(() => {});
  }
}

/**
 * A teammate's access to several pipelines at once, from the team page's
 * Save (one choice per pipeline), under the same lock as setPipelineAccess.
 * A pipeline not chosen keeps what it had; one the store no longer has is
 * dropped, so restrictions on deleted pipelines never pile up. With `was`
 * (the record as the page that saves read it), a record changed since
 * then is never written over: PipelineAccessChangedError, nothing written.
 * Answers the record before the change and the one kept.
 */
export async function setPipelineChoices(statsId: string, email: string, pipelineIds: readonly string[], choices: Readonly<Record<string, PipelineAccess>>, room: DataStore, was?: AccessMap | null): Promise<{ before: AccessMap | null; saved: AccessMap }> {
  const who = normaliseEmail(email);
  const token = randomBytes(12).toString("hex");
  const [claimed] = await redisPipeline([["SET", lockKey(statsId, who), token, "NX", "EX", LOCK_SECONDS]]);
  if (claimed !== "OK") throw new PipelineAccessBusyError();
  try {
    return await writeChoices(statsId, who, pipelineIds, choices, room, was);
  } finally {
    const [held] = await redisPipeline([["GET", lockKey(statsId, who)]]).catch(() => [null]);
    if (held === token) await redisPipeline([["DEL", lockKey(statsId, who)]]).catch(() => {});
  }
}

/** The new record from what was kept and what was chosen, for the store's pipelines only; held lock assumed. */
async function writeChoices(statsId: string, who: string, pipelineIds: readonly string[], choices: Readonly<Record<string, PipelineAccess>>, room: DataStore, was?: AccessMap | null): Promise<{ before: AccessMap | null; saved: AccessMap }> {
  const before = await readPipelineAccess(statsId, who);
  if (was !== undefined && !sameAccess(before, was)) throw new PipelineAccessChangedError();
  const next: AccessMap = Object.create(null) as AccessMap;
  for (const id of pipelineIds) {
    // A record that cannot be read opens nothing: every pipeline not chosen stays at no access.
    const kept: PipelineAccess = before === null ? "none" : (before[id] ?? "edit");
    const value = (Object.hasOwn(choices, id) ? choices[id] : undefined) ?? kept;
    if (value !== "edit") next[id] = value;
  }
  return { before, saved: await writePipelineAccess(statsId, who, next, room) };
}
