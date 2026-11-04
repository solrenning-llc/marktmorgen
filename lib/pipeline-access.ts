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
 */
import { randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { type AccessMap, type PipelineAccess, parseAccessMap } from "@/lib/pipeline-access-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData, noteData } from "@/lib/store-data";
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

/** A field as stored: none is no restriction; one that cannot be read is null, which opens nothing (accessOf). */
function mapOf(raw: unknown): AccessMap | null {
  if (raw === null || raw === undefined || raw === "") return {};
  if (typeof raw !== "string" || raw.length > 4_000) return null;
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
 * opens nothing (accessOf), and a read that fails throws, so the caller
 * refuses: neither is ever taken for no restriction.
 */
export async function readPipelineAccess(statsId: string | null, email: string): Promise<AccessMap | null> {
  if (!statsId || !isRedisConfigured()) return {};
  const [raw] = await redisPipeline([["HGET", accessKey(statsId), normaliseEmail(email)]]);
  return mapOf(raw);
}

/** Every teammate's restrictions, by address. */
export async function readAllPipelineAccess(statsId: string | null): Promise<Record<string, AccessMap | null>> {
  if (!statsId || !isRedisConfigured()) return {};
  const [raw] = await redisPipeline([["HGETALL", accessKey(statsId)]]);
  const out: Record<string, AccessMap | null> = {};
  const pairs: [string, unknown][] = Array.isArray(raw) ? raw.flatMap((v, i) => (i % 2 === 0 ? [[String(v), raw[i + 1]] as [string, unknown]] : [])) : raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>) : [];
  for (const [email, value] of pairs) out[email] = mapOf(value);
  return out;
}

/** Sets a teammate's restrictions; none deletes their field. Room is taken (or given back) first. */
export async function writePipelineAccess(statsId: string, email: string, map: AccessMap, room: DataStore): Promise<AccessMap> {
  const who = normaliseEmail(email);
  const clean = parseAccessMap(map);
  const [before] = await redisPipeline([["HGET", accessKey(statsId), who]]);
  const value = Object.keys(clean).length ? JSON.stringify(clean) : "";
  const weight = (v: unknown) => (typeof v === "string" && v ? dataBytes([who, v], 1) : 0);
  const grown = weight(value) - weight(before);
  if (grown > 0) await needData(room, [{ slot: ACCESS_SLOT, bytes: grown }]);
  await redisPipeline([value ? ["HSET", accessKey(statsId), who, value] : ["HDEL", accessKey(statsId), who]]);
  if (grown < 0) await giveData(room, [{ slot: ACCESS_SLOT, bytes: -grown }]);
  return clean;
}

/**
 * The first step of a teammate moving their sign-in to another address
 * (lib/team.ts, moveMemberships): their restrictions are copied, as they
 * are, unreadable or not, to the new address BEFORE the team record names
 * it. Throws when the copy cannot be confirmed; the caller then leaves that
 * store's membership on the old address, so the new one never has a store
 * without its restrictions. The old field is deleted only once the team
 * record has moved (forgetPipelineAccess).
 */
export async function copyPipelineAccess(store: DataStore, from: string, to: string): Promise<void> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured()) return;
  const before = normaliseEmail(from);
  const after = normaliseEmail(to);
  if (before === after) return;
  const [raw, old] = await redisPipeline([["HGET", accessKey(statsId), before], ["HGET", accessKey(statsId), after]]);
  const weight = (v: unknown) => (typeof v === "string" && v ? dataBytes([after, v], 1) : 0);
  if (raw === null || raw === undefined || raw === "") {
    // No restriction to carry: a field the new address had from before (someone else's, long gone) must not
    // restrict them, so it goes, and gives its room back.
    if (weight(old) === 0) return;
    const [deleted] = await redisPipeline([["HDEL", accessKey(statsId), after]]);
    if (deleted !== 0 && deleted !== 1) throw new Error("clearing the new address's pipeline access could not be confirmed");
    if (deleted === 1) await giveData(store, [{ slot: ACCESS_SLOT, bytes: weight(old) }]);
    return;
  }
  // A record moved, not a new one: it is counted as written (noteData never refuses), so a full data room
  // never leaves a teammate off the store when they change their sign-in. The old field gives its room back
  // when it is forgotten. Only a write that cannot be confirmed throws. A field the new address already had (read
  // under the team's lock, as every write to it is) is written over, so only the difference is counted.
  const [written] = await redisPipeline([["HSET", accessKey(statsId), after, String(raw)]]);
  if (written !== 0 && written !== 1) throw new Error("copying a teammate's pipeline access could not be confirmed");
  const grown = weight(String(raw)) - weight(old);
  if (grown > 0) await noteData(store, [{ slot: ACCESS_SLOT, bytes: grown }]);
  else if (grown < 0) await giveData(store, [{ slot: ACCESS_SLOT, bytes: -grown }]);
}

/** A teammate who left: their restrictions go with them, and the room they took is given back. */
export async function forgetPipelineAccess(store: DataStore, email: string): Promise<void> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured()) return;
  const who = normaliseEmail(email);
  const [raw, deleted] = await redisPipeline([["HGET", accessKey(statsId), who], ["HDEL", accessKey(statsId), who]]);
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
