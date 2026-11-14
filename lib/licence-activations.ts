/**
 * The devices each license key runs on, kept in the store's database: 610
 * [WP9], unit 2, on the rules of unit 1 (lib/licence-activation-rules.ts).
 * Nothing calls it yet: the public key check (app/api/store/licence) and the
 * buyer's "Free this device" use it in unit 3, with the product's setting.
 *
 *   nl:keys:<stats id>:<product>:act:<key's hash>      string: the record, JSON
 *                                                     (KeyActivations), expiring
 *   nl:keys:<stats id>:<product>:actlock:<key's hash>  string: the lock of a
 *                                                     change, ACTIVATION_LOCK_SECONDS
 *
 * What is kept, and what never is:
 *
 *   - a device as a keyed one-way digest (deviceDigest) of what the creator's
 *     software sent, made with a key only the server holds and different on
 *     every key, so it neither gives back the identifier nor links one device
 *     across keys or stores; the identifier itself is never written;
 *   - the license key only by its hash in the record's name (the key itself
 *     is in lib/licence-keys.ts, kept with its sale).
 *
 * Bounded three ways. The record holds at most MAX_ACTIVATIONS devices and
 * RELEASES_PER_WINDOW releases (the rules), and is refused past
 * MAX_ACTIVATION_RECORD_BYTES. It takes its room in the store's data room
 * (lib/store-data.ts, the store's own ceiling) before every write, counted
 * until the month it expires in, so a full room writes nothing. It expires
 * ACTIVATION_KEEP_SECONDS after its last write; a device that keeps checking
 * writes it again once less than ACTIVATION_REFRESH_SECONDS is left, so a key
 * in use keeps its devices and one nobody used for a full term starts again.
 *
 * Unknown is never yes (CX-123 rule 24): every answer is read in its exact
 * shape; a record, a time to live, a lock, the room or a write answered any
 * other way refuses ("unavailable"), and nothing is written on it. A change
 * is made under a lock per key, held again just before the write, so two
 * activations at once never pass the limit and a release is never lost.
 *
 * Cost: an activation sends at most ACTIVATION_COMMANDS commands and is
 * counted as ACTIVATION_REQUEST_UNITS of the store's public requests
 * (tests/plan-cost-registry.ts, public-requests), taken by the route before
 * it reads anything (unit 3).
 */
import { createHash, createHmac } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { holdLock, releaseLock, takeLock, type Held } from "@/lib/redis-lock";
import { DataRoomError, needData } from "@/lib/store-data";
import { dataBytes, utf8Length } from "@/lib/store-data-rules";
import { deriveKey } from "@/lib/secret-box";
import type { Listing, Store } from "@/lib/store";
import {
  MAX_ACTIVATIONS,
  MIN_ACTIVATIONS,
  cleanDeviceId,
  decideActivation,
  decideRelease,
  parseKeyActivations,
  releasesLeft,
  type Activation,
  type ActivationDecision,
  type KeyActivations,
  type KeyStanding,
  type ReleaseDecision,
} from "@/lib/licence-activation-rules";

/** How long a key's record is kept after its last write: a device unused this long frees its place. */
export const ACTIVATION_KEEP_SECONDS = 400 * 86_400;
/** A device already on the key writes the record again once less than this is left of it. */
export const ACTIVATION_REFRESH_SECONDS = ACTIVATION_KEEP_SECONDS / 2;
/** The most a key's record may weigh as written; the fullest the rules allow is about 700 bytes. */
export const MAX_ACTIVATION_RECORD_BYTES = 1_024;
/** How long a change holds its key's lock, and how long another waits for it before refusing. */
export const ACTIVATION_LOCK_SECONDS = 10;
export const ACTIVATION_LOCK_WAIT_MS = 300;
/** The most tries at the lock in ACTIVATION_LOCK_WAIT_MS (lib/redis-lock.ts, takeLock: 20, 40, 80 and 160 ms apart). */
export const ACTIVATION_LOCK_TRIES = 5;
/**
 * The most commands one activation sends: the record read (GET, TTL), the
 * lock's tries, the record read again under it, the room (one script), the
 * lock held again, the write, its read back, and the lock let go. A release
 * sends the same less the first read.
 */
export const ACTIVATION_COMMANDS = 2 + ACTIVATION_LOCK_TRIES + 2 + 1 + 1 + 1 + 1 + 1;
/** The store's public requests one activation or release is counted as (tests/licence-activations.test.ts holds the price). */
export const ACTIVATION_REQUEST_UNITS = 2;

const UNAVAILABLE = { outcome: "unavailable" } as const;

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
const recordKey = (store: Pick<Store, "statsId">, product: Pick<Listing, "id">, key: string) => `nl:keys:${store.statsId}:${product.id}:act:${keyHash(key)}`;
const lockKey = (store: Pick<Store, "statsId">, product: Pick<Listing, "id">, key: string) => `nl:keys:${store.statsId}:${product.id}:actlock:${keyHash(key)}`;

/**
 * The digest a device is kept as on one key: 32 hex characters, from a key
 * only the server holds. Null when this deployment has none, or the store no
 * statistics id: then nothing is activated.
 */
export function deviceDigest(store: Pick<Store, "statsId">, product: Pick<Listing, "id">, key: string, device: string): string | null {
  const secret = deriveKey("licence-device");
  if (!secret || !store.statsId) return null;
  return createHmac("sha256", secret).update(`${store.statsId}\n${product.id}\n${key}\n${device}`).digest("hex").slice(0, 32);
}

type Kept = { record: KeyActivations; ttl: number };

/** The record and its time to live, exactly, or null: no record is an empty key only when Redis says the key is not there. */
async function readKept(name: string): Promise<Kept | null> {
  let replies: unknown[] | null;
  try {
    replies = repliesFor(await redisPipeline([["GET", name], ["TTL", name]]), 2);
  } catch {
    return null;
  }
  if (!replies) return null;
  const [raw, ttl] = replies;
  if (typeof ttl !== "number" || !Number.isInteger(ttl)) return null;
  if (raw === null) return ttl === -2 ? { record: { devices: [], releases: [] }, ttl: 0 } : null;
  if (typeof raw !== "string" || (ttl < 0 && ttl !== -1)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = parseKeyActivations(parsed);
  return record ? { record, ttl } : null;
}

const needsRefresh = (kept: Kept) => kept.ttl === -1 || kept.ttl < ACTIVATION_REFRESH_SECONDS;

/**
 * Writes the record for a full term, under a lock still held: its room first,
 * then the lock held again, then SET, read back when the answer was not "OK".
 * True only when it is known to have landed.
 */
async function writeKept(store: Store, held: Held, name: string, record: KeyActivations, now: number): Promise<boolean> {
  const value = JSON.stringify(record);
  if (utf8Length(value) > MAX_ACTIVATION_RECORD_BYTES) return false;
  try {
    await needData(store, [{ until: now + ACTIVATION_KEEP_SECONDS * 1000, bytes: dataBytes([name, value], 1) }], now);
  } catch (error) {
    if (!(error instanceof DataRoomError)) console.error("a license key's devices could not take their room", error);
    return false;
  }
  if (!(await holdLock(held))) return false;
  try {
    const reply = repliesFor(await redisPipeline([["SET", name, value, "EX", ACTIVATION_KEEP_SECONDS]]), 1);
    if (reply?.[0] === "OK") return true;
  } catch {
    // Read back below: the write may have landed.
  }
  try {
    const back = repliesFor(await redisPipeline([["GET", name]]), 1);
    return back?.[0] === value;
  } catch {
    return false;
  }
}

/** Runs `work` under the key's lock; null when the lock could not be taken (busy, or answered another way). */
async function underLock<T>(store: Store, product: Pick<Listing, "id">, key: string, work: (held: Held) => Promise<T>): Promise<T | null> {
  let held: Held;
  try {
    held = await takeLock(lockKey(store, product, key), ACTIVATION_LOCK_SECONDS, ACTIVATION_LOCK_WAIT_MS);
  } catch {
    return null;
  }
  try {
    return await work(held);
  } finally {
    await releaseLock(held);
  }
}

const usable = (limit: number | null): limit is number => typeof limit === "number" && Number.isInteger(limit) && limit >= MIN_ACTIVATIONS && limit <= MAX_ACTIVATIONS;

/**
 * Whether the device the creator's software names may run on this key, and
 * its place taken when it is new and one is free. `standing` is what the
 * public check found of the key (lib/licence-keys.ts, checkKey); `limit` the
 * product's setting as parseActivationLimit reads it. The key and the limit
 * are judged before anything is read.
 */
export async function activateDevice(
  store: Store,
  product: Pick<Listing, "id">,
  key: string,
  input: { standing: KeyStanding; limit: number | null; device: unknown },
  now = Date.now(),
): Promise<ActivationDecision> {
  const seconds = Math.floor(now / 1000);
  const { standing, limit } = input;
  if (standing !== "valid" || !usable(limit)) return decideActivation({ key: standing, limit, record: null, device: null, now: seconds });
  const clean = cleanDeviceId(input.device);
  if (!clean) return { outcome: "bad_device" };
  if (!store.statsId || !isRedisConfigured()) return UNAVAILABLE;
  const device = deviceDigest(store, product, key, clean);
  if (!device) return UNAVAILABLE;
  const name = recordKey(store, product, key);
  const kept = await readKept(name);
  const first = decideActivation({ key: standing, limit, record: kept?.record ?? null, device, now: seconds });
  if (first.outcome !== "activated" && !(first.outcome === "already" && kept && needsRefresh(kept))) return first;
  const decided = await underLock(store, product, key, async (held) => {
    const again = await readKept(name);
    const decision = decideActivation({ key: standing, limit, record: again?.record ?? null, device, now: seconds });
    if (decision.outcome === "already") {
      // Kept alive for a device in use; the device runs whether or not this write lands.
      if (again && needsRefresh(again)) await writeKept(store, held, name, again.record, now);
      return decision;
    }
    if (decision.outcome !== "activated") return decision;
    return (await writeKept(store, held, name, decision.record, now)) ? decision : UNAVAILABLE;
  });
  // A device already on the key runs even when the lock to keep its record alive was busy.
  return decided ?? (first.outcome === "already" ? first : UNAVAILABLE);
}

/**
 * The buyer frees one device (`device` is its digest, as devicesOf lists it)
 * from a key. The caller checks the key is theirs (unit 3).
 */
export async function releaseDevice(store: Store, product: Pick<Listing, "id">, key: string, device: string, now = Date.now()): Promise<ReleaseDecision> {
  if (!store.statsId || !isRedisConfigured()) return UNAVAILABLE;
  const name = recordKey(store, product, key);
  const seconds = Math.floor(now / 1000);
  const decided = await underLock(store, product, key, async (held) => {
    const kept = await readKept(name);
    const decision = decideRelease({ record: kept?.record ?? null, device, now: seconds });
    if (decision.outcome !== "released") return decision;
    return (await writeKept(store, held, name, decision.record, now)) ? decision : UNAVAILABLE;
  });
  return decided ?? UNAVAILABLE;
}

/** A key's devices, oldest first, and how many more the buyer may free now; null when the record could not be read. */
export async function devicesOf(store: Store, product: Pick<Listing, "id">, key: string, now = Date.now()): Promise<{ devices: Activation[]; releasesLeft: number } | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const kept = await readKept(recordKey(store, product, key));
  if (!kept) return null;
  return { devices: kept.record.devices, releasesLeft: releasesLeft(kept.record, Math.floor(now / 1000)) };
}

export type KeyDevicesCopy = { product: string; key: string; devices: { device: string; since: string }[]; freed: string[] };

/**
 * The devices of a person's keys, for the copy of their data (lib/person-copy.ts):
 * one row per key that has any, the devices as their digests. An answer that
 * cannot be read throws UnknownReplyError: the copy is made again, never
 * handed over without them. Only reads.
 */
export async function activationsOf(store: Store, keys: { product: string; key: string }[]): Promise<KeyDevicesCopy[]> {
  if (!store.statsId || !keys.length || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline(keys.map((k) => ["GET", recordKey(store, { id: k.product }, k.key)])), keys.length);
  if (!replies) throw new UnknownReplyError("a license key's devices");
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  return keys.flatMap((k, i) => {
    const raw = replies[i];
    if (raw === null) return [];
    if (typeof raw !== "string") throw new UnknownReplyError("a license key's devices");
    let record: KeyActivations | null = null;
    try {
      record = parseKeyActivations(JSON.parse(raw));
    } catch {
      record = null;
    }
    if (!record) throw new UnknownReplyError("a license key's devices");
    if (!record.devices.length && !record.releases.length) return [];
    return [{ product: k.product, key: k.key, devices: record.devices.map((d) => ({ device: d.device, since: iso(d.at) })), freed: record.releases.map(iso) }];
  });
}
