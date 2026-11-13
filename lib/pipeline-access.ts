/**
 * Where each teammate's pipeline restrictions are kept (639 [GL7](7), the
 * rules in lib/pipeline-access-rules.ts):
 *
 *   nl:crm:pacc:<statsId>   hash: <teammate's address> -> their AccessMap, as JSON
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
import { normaliseEmail } from "@/lib/auth";
import { type AccessMap, parseAccessMap } from "@/lib/pipeline-access-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

const accessKey = (statsId: string) => `nl:crm:pacc:${statsId}`;
const ACCESS_SLOT = "crm:pacc";

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
    return value && typeof value === "object" && !Array.isArray(value) ? parseAccessMap(value) : null;
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
 * without its restrictions. Only a field never set (exactly null) is not
 * copied; an unknown reply throws, so it is never taken for none. The old field is deleted only once the team
 * record has moved (forgetPipelineAccess).
 */
export async function copyPipelineAccess(store: DataStore, from: string, to: string): Promise<void> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured()) return;
  const before = normaliseEmail(from);
  const after = normaliseEmail(to);
  if (before === after) return;
  const raw = await fieldOf(statsId, before);
  if (raw === null) return;
  // A record moved, not a new one: it is counted as written (noteData never refuses), so a full data room
  // never leaves a teammate off the store when they change their sign-in. The old field gives its room back
  // when it is forgotten. Only a write that cannot be confirmed throws.
  const written = countOf(repliesFor(await redisPipeline([["HSET", accessKey(statsId), after, raw]]), 1)?.[0]);
  if (written !== 0 && written !== 1) throw new Error("copying a teammate's pipeline access could not be confirmed");
  await noteData(store, [{ slot: ACCESS_SLOT, bytes: dataBytes([after, raw], 1) }]);
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
