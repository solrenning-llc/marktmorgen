/**
 * A store's public address looked up for a visitor (traffic audit of 9 November 2026, MÉDIO 2; pre-review of the same
 * day, which found that the first version took real stores off the air).
 *
 * Every page and route under app/[handle] starts by asking the database which store an address belongs to. For a real
 * store the page is then counted in the store's own window (lib/traffic.ts). For an address that leads nowhere there
 * is no store and no window to count it in.
 *
 * Whether an address has a store is decided by its small index read (nl:store:handle:<handle>) and nothing else, on
 * every request, so nothing here can take a real store off the air or make it cost more than storeForHandle:
 *   - the index read is sent alone, as storeForHandle sends it; when it names a holder, the store's record is read
 *     exactly as storeForHandle reads it. A real store's lookup is two commands, cold or warm, never paced, never
 *     counted and never remembered;
 *   - only an index that says, exactly, that nobody holds the address (no value, or a let-go name) is a miss. Misses
 *     are paced per connection in this server's memory (lib/local-limit.ts, no command): past
 *     UNSEEN_STORE_LOOKUPS_PER_MINUTE in a minute, the answer says so (`retryAfter`), so a route can answer 429 with
 *     Retry-After instead of 404. A page can only answer not-found, which is what the address is;
 *   - a reply that cannot be read is no answer: the address is looked up the normal way (storeForHandle), and it is
 *     not counted as a miss;
 *   - nothing is remembered between requests: a store claimed a second after its address was asked about opens at
 *     once, and a record read empty once (the claim writes the index first) is read again on the next request.
 *
 * What it is honest about, and does not bound: the pace never saves the index read, because only that read tells a
 * made-up address from a real store; each made-up address costs one small read on top of the function call every
 * request is, as it did before this file. There is no company-wide ceiling on those reads: a flood, from one machine
 * that ignores 429 or from many, is the host firewall's to stop (MM-SA-11, FW1), as for every page drawn per request.
 * What one read costs is priced in tests/unknown-store-ceiling.test.ts and recorded in docs/funded-exposure-review.md.
 */
import { headers } from "next/headers";
import { withinLocalLimit } from "@/lib/local-limit";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { shareAddress } from "@/lib/traffic-rules";

/** Addresses leading nowhere one connection may have one server look up in a minute before it is told to wait. */
export const UNSEEN_STORE_LOOKUPS_PER_MINUTE = 30;
/** Seconds a connection past its pace is told to wait: the pace's whole minute, at the most. */
export const STORE_LOOKUP_RETRY_SECONDS = 60;
const MINUTE_MS = 60_000;

/**
 * How a store is found, handed over by lib/store.ts so this file reads nothing of the store's own: the normal lookup,
 * the index key, the holder an index value names (null for none, a let-go name included), and the store's record read
 * for a holder.
 */
export type StoreProbe<T> = {
  look: (handle: string) => Promise<T | null>;
  indexKey: string;
  holderOf: (value: unknown) => string | null;
  open: (holder: string) => Promise<T | null>;
};

/** What a visitor's lookup found: the store or null, and, for an address leading nowhere past the pace, the wait. */
export type StoreLookup<T> = { store: T | null; retryAfter: number };

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

/** The one entry of a reply that is exactly one plain entry, read from its own data field; undefined otherwise. */
function single(reply: unknown): { value: unknown } | undefined {
  if (!Array.isArray(reply)) return undefined;
  const size = Object.getOwnPropertyDescriptor(reply, "length");
  if (!size || !Object.hasOwn(size, "value") || size.value !== 1) return undefined;
  const entry = Object.getOwnPropertyDescriptor(reply, "0");
  if (!entry || !Object.hasOwn(entry, "value")) return undefined;
  return { value: entry.value };
}

/**
 * The store behind `handle` for a visitor, found through `probe` (lib/store.ts). The index decides on every request;
 * only an address whose index names nobody counts against the asking connection's pace, and past it the answer carries
 * `retryAfter`. `address` is the asking connection, read from the request when not given.
 */
export async function lookUpStore<T>(handle: string, probe: StoreProbe<T>, { now = Date.now(), address }: { now?: number; address?: string } = {}): Promise<StoreLookup<T>> {
  if (!isRedisConfigured()) return { store: await probe.look(handle), retryAfter: 0 };
  const reply = single(await redisPipeline([["GET", probe.indexKey]]));
  // An index that cannot be read is no answer: the normal way decides, so a real store still opens.
  if (!reply || (reply.value !== null && typeof reply.value !== "string")) return { store: await probe.look(handle), retryAfter: 0 };
  const holder = probe.holderOf(reply.value);
  if (holder) return { store: await probe.open(holder), retryAfter: 0 };
  // Nobody holds the address: a miss, the only thing the pace counts.
  const connection = address ?? (await askingConnection());
  const within = withinLocalLimit("store-lookup", connection, UNSEEN_STORE_LOOKUPS_PER_MINUTE, MINUTE_MS, now);
  return { store: null, retryAfter: within ? 0 : STORE_LOOKUP_RETRY_SECONDS };
}

/** A visitor's lookup past its pace, as a route answers it: 429 with Retry-After, kept by no cache. */
export function storeLookupRefusal(retryAfter: number): Response {
  return new Response("Too many requests. Try again in a minute.", {
    status: 429,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(retryAfter) },
  });
}
