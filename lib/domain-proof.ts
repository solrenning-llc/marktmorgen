/**
 * Proving a domain is the creator's, by the TXT record lib/domains.ts asks
 * for (proofRecord). Kept apart from lib/domains.ts, which the proxy reads,
 * because it asks the DNS.
 */
import { resolveTxt } from "node:dns/promises";
import { redisPipeline } from "@/lib/redis";
import { claimMark } from "@/lib/claim-mark";
import { UNPROVED, UNPROVED_SECONDS, domainKey, proofRecord } from "@/lib/domains";
import type { Store } from "@/lib/store";

/** Sets the key to its new value only while it still holds the one expected. */
const SWAP = [
  'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end',
  'redis.call("SET", KEYS[1], ARGV[2])',
  "return 1",
].join("\n");

/** The same, keeping the key's time to live: a claim not proved still lapses. */
const SWAP_KEEPING_TTL = [
  'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end',
  'redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL")',
  "return 1",
].join("\n");

/** Gives up on a DNS answer after this long, as not found. */
const DNS_TIMEOUT_MS = 4_000;

async function txtRecords(host: string): Promise<string[]> {
  try {
    const answer = await Promise.race([
      resolveTxt(host),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), DNS_TIMEOUT_MS)),
    ]);
    return answer.map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

export type ProofResult = "proved" | "waiting" | "taken";

/**
 * Looks for the store's TXT record and, when it is there, lets the domain
 * serve the store. A claim that lapsed is claimed again for the store, if
 * nobody else took it meanwhile.
 */
export async function proveDomain(store: Pick<Store, "sid" | "handle" | "previousHandles">, name: string): Promise<ProofResult> {
  const ours = [store.handle, ...store.previousHandles];
  const [raw] = await redisPipeline([["GET", domainKey(name)]]);
  let held = typeof raw === "string" ? raw : "";
  const holder = held.replace(/^\?/, "");
  if (held && !ours.includes(holder)) return "taken";
  // Held under an older address of this same store: moved to the current one.
  if (held && holder !== store.handle) {
    const now = held.startsWith(UNPROVED) ? `${UNPROVED}${store.handle}` : store.handle;
    const [moved] = await redisPipeline([["EVAL", SWAP_KEEPING_TTL, 1, domainKey(name), held, now]]);
    if (Number(moved) !== 1) return "waiting";
    held = now;
  }
  if (held === store.handle) return "proved";
  if (!held) {
    // Read exactly (CX-123 rule 24): this store's claim read back is ours; another's is taken; one that cannot be read
    // asks the DNS nothing now, and the creator's next check claims it again.
    const claimed = await claimMark(domainKey(name), UNPROVED_SECONDS, `${UNPROVED}${store.handle}`);
    if (claimed === "taken") return "taken";
    if (claimed === "unknown") return "waiting";
  }
  const proof = proofRecord(store, name);
  const found = await txtRecords(proof.host);
  if (!found.some((value) => value.trim() === proof.value)) return "waiting";
  // Only while the claim is still this store's: it may have lapsed and been
  // taken while the DNS was asked.
  const [set] = await redisPipeline([["EVAL", SWAP, 1, domainKey(name), `${UNPROVED}${store.handle}`, store.handle]]);
  return Number(set) === 1 ? "proved" : "waiting";
}
