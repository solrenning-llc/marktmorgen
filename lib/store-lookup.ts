/**
 * A store's public address looked up for a visitor (traffic audit of 9 November 2026, MÉDIO 2).
 *
 * Every page and route under app/[handle] starts by asking the database which store an address belongs to. For a real
 * store the page is then counted in the store's own window (lib/traffic.ts). For an address that leads nowhere there
 * is no store and no window: nothing counted it, so a loop over made-up addresses was a bill for the company that
 * nothing counted or paced.
 *
 * Whether an address has a store is decided only by the small index read (nl:store:handle:<handle>, the one
 * storeForHandle makes before the store's record), never by a ceiling, so no count, ceiling or unreadable reply can
 * take a real store off the air:
 *   - an address a server lately found to lead nowhere is remembered for STORE_MISS_MEMORY_MS and reads nothing;
 *   - one connection may have one server look up at most UNSEEN_STORE_LOOKUPS_PER_MINUTE addresses it has not lately
 *     found a store behind (lib/local-limit.ts, which costs no command); past it, that connection alone meets the
 *     not-found page until its minute turns;
 *   - otherwise the lookup is counted for the UTC day and the index read, in one round trip (STORE_LOOKUP_COMMANDS):
 *     the count first, then the read. When the index names a holder, the store's record is read as storeForHandle
 *     reads it, with the count given back in the same round trip (a real store is not a miss); when it names none,
 *     the record is never read and the miss stays counted;
 *   - past STORE_MISSES_PER_DAY counted misses in the day, a server stops counting (its lookups send the index read
 *     alone) until the day turns: what the ceiling bounds is what the company pays to count, while a made-up address
 *     costs one small read at every count;
 *   - a reply that cannot be read is no answer: the address is looked up the normal way (storeForHandle), so a real
 *     store still opens; the count already sent stays.
 *
 * An address found to have a store is remembered for STORE_KNOWN_MEMORY_MS and is neither paced nor counted here: the
 * store's own window counts its pages. What this costs the company is priced in tests/unknown-store-ceiling.test.ts
 * and recorded in docs/funded-exposure-review.md.
 *
 * What it is honest about: each server holds its pace and its marks on its own, and each request is still a function
 * call; a flood from many machines (and, past the day's ceiling, the one small read each of their made-up addresses
 * costs) is the host firewall's to stop, as for every page drawn per request. A store claimed in the half minute after
 * its address was looked up and missed on a server is not found by that server until the memory runs out. A
 * connection past its minute's pace does not see a store that server has not lately seen until its minute turns.
 *
 *   nl:store-lookup:miss:<YYYY-MM-DD>   string   the day's counted misses, a number and nothing else
 */
import { headers } from "next/headers";
import { withinLocalLimit } from "@/lib/local-limit";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { shareAddress } from "@/lib/traffic-rules";

type Command = (string | number)[];

/** Misses the whole site counts in a UTC day; past it, a server sends the index read alone until the day turns. */
export const STORE_MISSES_PER_DAY = 10_000;
/** Unseen addresses one connection may have one server look up in a minute, held in memory at no cost. */
export const UNSEEN_STORE_LOOKUPS_PER_MINUTE = 30;
/** How long a server remembers that an address leads nowhere. */
export const STORE_MISS_MEMORY_MS = 30_000;
/** How long a server remembers that an address has a store, so its visitors are not paced here. */
export const STORE_KNOWN_MEMORY_MS = 3_600_000;
/** Commands a counted lookup sends in its one round trip: the day's count, the key's life, the index read. */
export const STORE_LOOKUP_COMMANDS = 3;
/** Commands a found store's record read sends besides storeForHandle's own: the count given back. */
export const STORE_FOUND_EXTRA_COMMANDS = 1;
/** How long a day's count is kept: past the day, so a late request still finds it. */
export const STORE_MISS_KEY_SECONDS = 2 * 86_400;
/** Entries each memory keeps at the most; past it the oldest go. */
export const STORE_LOOKUP_MEMORY_KEYS = 20_000;
const MINUTE_MS = 60_000;

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
/** The key a day's misses are counted in. */
export const storeMissKey = (now: number) => `nl:store-lookup:miss:${dayOf(now)}`;

/**
 * How a store is found, handed over by lib/store.ts so this file reads nothing of the store's own: the normal lookup,
 * the index key, the holder an index value names (null for none, a let-go name included), and the store's record read
 * for a holder with `also` sent in the same round trip.
 */
export type StoreProbe<T> = {
  look: (handle: string) => Promise<T | null>;
  indexKey: string;
  holderOf: (value: unknown) => string | null;
  open: (holder: string, also: Command[]) => Promise<T | null>;
};

const missed = new Map<string, number>();
const known = new Map<string, number>();
let fullUntil = 0;

function remember(memory: Map<string, number>, key: string, until: number, now: number): void {
  memory.delete(key);
  if (memory.size >= STORE_LOOKUP_MEMORY_KEYS) {
    for (const [k, v] of memory) if (v <= now) memory.delete(k);
    while (memory.size >= STORE_LOOKUP_MEMORY_KEYS) memory.delete(memory.keys().next().value as string);
  }
  memory.set(key, until);
}

const live = (memory: Map<string, number>, key: string, now: number) => (memory.get(key) ?? 0) > now;
const endOfDay = (now: number) => (Math.floor(now / 86_400_000) + 1) * 86_400_000;

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

/** The entries of a reply that is exactly `length` plain entries, read from its own data fields; null otherwise. */
function entries(reply: unknown, length: number): unknown[] | null {
  if (!Array.isArray(reply)) return null;
  const size = Object.getOwnPropertyDescriptor(reply, "length");
  if (!size || !Object.hasOwn(size, "value") || size.value !== length) return null;
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const entry = Object.getOwnPropertyDescriptor(reply, String(i));
    if (!entry || !Object.hasOwn(entry, "value")) return null;
    out.push(entry.value);
  }
  return out;
}

const remembered = <T>(handle: string, found: T | null, now: number): T | null => {
  if (found) remember(known, handle, now + STORE_KNOWN_MEMORY_MS, now);
  else {
    known.delete(handle);
    remember(missed, handle, now + STORE_MISS_MEMORY_MS, now);
  }
  return found;
};

/**
 * The store behind `handle` for a visitor, or null: found through `probe` (lib/store.ts, storeForVisitor). Null without
 * reading anything only when the address lately led nowhere on this server, or when it is unseen and this connection
 * has used its minute here; otherwise the index decides. `address` is the asking connection, read from the request
 * when not given.
 */
export async function lookUpStore<T>(handle: string, probe: StoreProbe<T>, { now = Date.now(), address }: { now?: number; address?: string } = {}): Promise<T | null> {
  if (!isRedisConfigured()) return probe.look(handle);
  if (live(missed, handle, now)) return null;
  if (live(known, handle, now)) return remembered(handle, await probe.look(handle), now);
  const connection = address ?? (await askingConnection());
  if (!withinLocalLimit("store-lookup", connection, UNSEEN_STORE_LOOKUPS_PER_MINUTE, MINUTE_MS, now)) return null;

  const key = storeMissKey(now);
  const counting = fullUntil <= now;
  const commands: Command[] = counting
    ? [["INCR", key], ["EXPIRE", key, STORE_MISS_KEY_SECONDS], ["GET", probe.indexKey]]
    : [["GET", probe.indexKey]];
  const reply = entries(await redisPipeline(commands), commands.length);
  const index = reply?.[reply.length - 1];
  // An index that cannot be read is no answer: the normal way decides, so a real store still opens.
  if (!reply || (index !== null && typeof index !== "string")) return remembered(handle, await probe.look(handle), now);
  const day = counting ? reply[0] : null;
  const dayCounted = typeof day === "number" && Number.isSafeInteger(day) && day >= 1;
  if (dayCounted && day >= STORE_MISSES_PER_DAY) fullUntil = Math.max(fullUntil, endOfDay(now));
  const holder = probe.holderOf(index);
  if (!holder) return remembered(handle, null, now);
  // A real store is not a miss: its count is given back in the record's own round trip.
  return remembered(handle, await probe.open(holder, dayCounted ? [["DECR", key]] : []), now);
}

/** Forgets every mark this server holds: for tests, which run many days and connections in one process. */
export function forgetStoreLookups(): void {
  missed.clear();
  known.clear();
  fullUntil = 0;
}
