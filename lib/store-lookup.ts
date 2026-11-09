/**
 * A store's public address looked up for a visitor (traffic audit of 9 November 2026, MÉDIO 2).
 *
 * Every page and route under app/[handle] starts by asking the database which store an address belongs to
 * (storeForHandle, lib/store.ts). For a real store the page is then counted in the store's own window
 * (lib/traffic.ts). For an address that leads nowhere there is no store and no window: nothing counted it, so a
 * loop over made-up addresses was a database read each time, and a bill for the company with no ceiling.
 *
 * Now, for an address this server has not lately found a store behind, before anything is read:
 *   - "nothing here" is remembered in this server's memory for STORE_MISS_MEMORY_MS, so the same made-up address
 *     asked again reads nothing;
 *   - one connection may have this server look up at most UNSEEN_STORE_LOOKUPS_PER_MINUTE such addresses a minute
 *     (lib/local-limit.ts, which costs no command);
 *   - once the company's misses of the UTC day passed STORE_MISSES_PER_DAY, or this connection's passed
 *     STORE_MISSES_PER_CONNECTION_PER_DAY, this server reads nothing more for such addresses that day (for that
 *     connection only, in the second case), and the visitor meets the plain not-found page.
 * Each address that turned out to lead nowhere is then counted once, for the day and for its connection
 * (STORE_MISS_COUNT_COMMANDS, one pipeline): a real store is never counted, so it never uses the ceiling up and its
 * pages send exactly what they sent before. A count that cannot be read is no room: this server stops reading for
 * unseen addresses for a minute.
 *
 * An address found to have a store is remembered for STORE_KNOWN_MEMORY_MS and is neither paced nor counted here:
 * the store's own window counts its pages. What this costs the company at its ceiling is priced in
 * tests/unknown-store-ceiling.test.ts and recorded in docs/funded-exposure-review.md.
 *
 * What it is honest about: each server counts its pace and its marks on its own, and each request is still a function
 * call; a flood from many machines is the host firewall's to stop, as for every page drawn per request. A store
 * whose address was looked up and missed in the half minute before it was claimed is not found by that server until
 * the memory runs out. Past the day's ceiling, a real store's address that a server has not seen in the last hour is
 * not found by that server until the day turns: the connection's share keeps one machine from causing it alone.
 *
 *   nl:store-lookup:miss:<YYYY-MM-DD>   hash   "all" -> the day's misses; <connection's mark> -> that connection's
 */
import { createHash, createHmac } from "node:crypto";
import { headers } from "next/headers";
import { withinLocalLimit } from "@/lib/local-limit";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { deriveKey } from "@/lib/secret-box";
import { shareAddress } from "@/lib/traffic-rules";

/** Addresses leading nowhere that the whole site reads for in a UTC day; past it, unseen addresses read nothing. */
export const STORE_MISSES_PER_DAY = 10_000;
/** Of those, what one connection may cause in a day: one machine alone cannot use the day up. */
export const STORE_MISSES_PER_CONNECTION_PER_DAY = 100;
/** Unseen addresses one connection may have one server look up in a minute, held in memory at no cost. */
export const UNSEEN_STORE_LOOKUPS_PER_MINUTE = 30;
/** How long a server remembers that an address leads nowhere. */
export const STORE_MISS_MEMORY_MS = 30_000;
/** How long a server remembers that an address has a store, so its visitors are not paced here. */
export const STORE_KNOWN_MEMORY_MS = 3_600_000;
/** Commands a counted miss sends, in one pipeline: the connection's count, the day's count and the key's life. */
export const STORE_MISS_COUNT_COMMANDS = 3;
/** How long a day's counts are kept: past the day, so a late request still finds them. */
export const STORE_MISS_KEY_SECONDS = 2 * 86_400;
/** Entries each memory keeps at the most; past it the oldest go. */
export const STORE_LOOKUP_MEMORY_KEYS = 20_000;
/** How long a server reads nothing for unseen addresses after a count it could not read. */
const UNREAD_PAUSE_MS = 60_000;
const MINUTE_MS = 60_000;

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
/** The key a day's misses are counted in. */
export const storeMissKey = (now: number) => `nl:store-lookup:miss:${dayOf(now)}`;

const missed = new Map<string, number>();
const known = new Map<string, number>();
const overShare = new Map<string, number>();
let pausedUntil = 0;

function remember(memory: Map<string, number>, key: string, until: number, now: number): void {
  memory.delete(key);
  if (memory.size >= STORE_LOOKUP_MEMORY_KEYS) {
    for (const [k, v] of memory) if (v <= now) memory.delete(k);
    while (memory.size >= STORE_LOOKUP_MEMORY_KEYS) memory.delete(memory.keys().next().value as string);
  }
  memory.set(key, until);
}

const live = (memory: Map<string, number>, key: string, now: number) => (memory.get(key) ?? 0) > now;

/** The connection asking, as the store's share counts it (lib/traffic-rules.ts); "none" outside a request. */
async function askingConnection(): Promise<string> {
  try {
    const from = await headers();
    const ip = from.get("x-forwarded-for")?.split(",")[0]?.trim() || from.get("x-real-ip") || "";
    return shareAddress(ip) || "none";
  } catch {
    return "none";
  }
}

/** The few letters a connection is kept as for a day, made with a key only this deployment has (lib/secret-box.ts). */
function connectionMark(day: string, connection: string): string {
  const of = `${day}|store-lookup|${connection}`;
  const key = deriveKey("store-lookup-connection");
  return (key ? createHmac("sha256", key).update(of) : createHash("sha256").update(of)).digest("hex").slice(0, 16);
}

/** The integers of a reply that is exactly `length` plain entries, read from its own data fields; null otherwise. */
function integers(reply: unknown, length: number): number[] | null {
  if (!Array.isArray(reply)) return null;
  const size = Object.getOwnPropertyDescriptor(reply, "length");
  if (!size || !Object.hasOwn(size, "value") || size.value !== length) return null;
  const out: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const entry = Object.getOwnPropertyDescriptor(reply, String(i));
    if (!entry || !Object.hasOwn(entry, "value") || typeof entry.value !== "number" || !Number.isSafeInteger(entry.value)) return null;
    out.push(entry.value);
  }
  return out;
}

const endOfDay = (now: number) => (Math.floor(now / 86_400_000) + 1) * 86_400_000;

/** One miss counted, for the day and for its connection; past either ceiling, this server reads no more for it. */
async function countMiss(connection: string, now: number): Promise<void> {
  const day = dayOf(now);
  const key = storeMissKey(now);
  try {
    const counts = integers(await redisPipeline([
      ["HINCRBY", key, connectionMark(day, connection), 1],
      ["HINCRBY", key, "all", 1],
      ["EXPIRE", key, STORE_MISS_KEY_SECONDS],
    ]), STORE_MISS_COUNT_COMMANDS);
    if (!counts || counts[0]! < 1 || counts[1]! < 1 || counts[2] !== 1) throw new Error("store-lookup: the count's reply is not the one asked for");
    if (counts[1]! >= STORE_MISSES_PER_DAY) pausedUntil = Math.max(pausedUntil, endOfDay(now));
    if (counts[0]! >= STORE_MISSES_PER_CONNECTION_PER_DAY) remember(overShare, `${day}|${connection}`, endOfDay(now), now);
  } catch {
    // A count that cannot be made or read is no room to read more.
    pausedUntil = Math.max(pausedUntil, now + UNREAD_PAUSE_MS);
  }
}

/**
 * The store behind `handle` for a visitor, found with `look` (storeForHandle), or null; null without reading anything
 * when the address lately led nowhere, or when it is unseen and this connection or the day has used its room.
 * `address` is the asking connection, read from the request when not given.
 */
export async function lookUpStore<T>(handle: string, look: (handle: string) => Promise<T | null>, { now = Date.now(), address }: { now?: number; address?: string } = {}): Promise<T | null> {
  if (!isRedisConfigured()) return look(handle);
  if (live(missed, handle, now)) return null;
  const seen = live(known, handle, now);
  let connection = "none";
  if (!seen) {
    if (pausedUntil > now) return null;
    connection = address ?? (await askingConnection());
    if (live(overShare, `${dayOf(now)}|${connection}`, now)) return null;
    if (!withinLocalLimit("store-lookup", connection, UNSEEN_STORE_LOOKUPS_PER_MINUTE, MINUTE_MS, now)) return null;
  }
  const found = await look(handle);
  if (found) {
    remember(known, handle, now + STORE_KNOWN_MEMORY_MS, now);
    return found;
  }
  known.delete(handle);
  remember(missed, handle, now + STORE_MISS_MEMORY_MS, now);
  if (seen) connection = address ?? (await askingConnection());
  await countMiss(connection, now);
  return null;
}

/** Forgets every mark this server holds: for tests, which run many days and connections in one process. */
export function forgetStoreLookups(): void {
  missed.clear();
  known.clear();
  overShare.clear();
  pausedUntil = 0;
}
