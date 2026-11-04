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
 */
import { normaliseEmail } from "@/lib/auth";
import { type AccessMap, parseAccessMap } from "@/lib/pipeline-access-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

const accessKey = (statsId: string) => `nl:crm:pacc:${statsId}`;
const ACCESS_SLOT = "crm:pacc";

/** A field as stored: none is no restriction; one that cannot be read is null, which opens nothing (accessOf). */
function mapOf(raw: unknown): AccessMap | null {
  if (raw === null || raw === undefined || raw === "") return {};
  if (typeof raw !== "string" || raw.length > 4_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? parseAccessMap(value) : null;
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
export async function copyPipelineAccess(statsId: string | null, from: string, to: string): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const before = normaliseEmail(from);
  const after = normaliseEmail(to);
  if (before === after) return;
  const [raw] = await redisPipeline([["HGET", accessKey(statsId), before]]);
  if (raw === null || raw === undefined || raw === "") return;
  const [written] = await redisPipeline([["HSET", accessKey(statsId), after, String(raw)]]);
  if (written !== 0 && written !== 1) throw new Error("copying a teammate's pipeline access could not be confirmed");
}

/** A teammate who left: their restrictions go with them. */
export async function forgetPipelineAccess(statsId: string | null, email: string): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await redisPipeline([["HDEL", accessKey(statsId), normaliseEmail(email)]]);
}
