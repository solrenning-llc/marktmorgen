/**
 * Proving a domain is the creator's, by the TXT record lib/domains.ts asks
 * for (proofRecord). Kept apart from lib/domains.ts, which the proxy reads,
 * because it asks the DNS.
 */
import { resolveTxt } from "node:dns/promises";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { claimMark } from "@/lib/claim-mark";
import { UNPROVED, UNPROVED_SECONDS, domainHolder, domainKey, proofRecord } from "@/lib/domains";
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

/** Gives up on a DNS answer after this long: not known, never "not found". */
const DNS_TIMEOUT_MS = 4_000;

/** The DNS answers that say there is no such record: no such name, or no record of that type. */
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);

/**
 * The domain's TXT records, or null when the DNS could not say (a timeout, a server failure, a refused query): only
 * "no such name" or "no record of that type" is an empty list (#5285 row #4248, Codex V), so a passing failure is
 * never read as the record not being there.
 */
async function txtRecords(host: string): Promise<string[] | null> {
  // The race's timer is cleared once DNS answers, so no 4 s timer outlives the check (C4-3000).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      resolveTxt(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DNS_TIMEOUT_MS);
      }),
    ]);
    return answer.map((parts) => parts.join(""));
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    return typeof code === "string" && NO_RECORD.has(code) ? [] : null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Whether the domain carries this store's own TXT record (proofRecord); null when the DNS could not say. */
async function hasProof(store: Pick<Store, "sid">, name: string): Promise<boolean | null> {
  const proof = proofRecord(store, name);
  const found = await txtRecords(proof.host);
  return found === null ? null : found.some((value) => value.trim() === proof.value);
}

/**
 * Swaps the domain's key from `from` to `to` only while it still holds `from` (one script), and says whether it now
 * holds `to`. Read exactly (MÉDIO of Codex V on #4248): an exact 1 is a swap done and an exact 0 a race lost; any
 * other reply is settled by reading the key again exactly (domainHolder throws when that cannot be told), never by
 * coercing a boolean or a text to a number.
 */
async function swapped(name: string, script: string, from: string, to: string): Promise<boolean> {
  const replies = repliesFor(await redisPipeline([["EVAL", script, 1, domainKey(name), from, to]]), 1);
  if (replies && replies[0] === 1) return true;
  if (replies && replies[0] === 0) return false;
  return (await domainHolder(name)) === to;
}

export type ProofResult = "proved" | "waiting" | "taken";

/**
 * Looks for the store's TXT record and, when it is there, lets the domain
 * serve the store. A claim that lapsed is claimed again for the store, if
 * nobody else took it meanwhile. Another store's claim not proved yet gives
 * way to the store whose record is there (#4108); a proved one never does.
 */
export async function proveDomain(store: Pick<Store, "sid" | "handle" | "previousHandles">, name: string): Promise<ProofResult> {
  const ours = [store.handle, ...store.previousHandles];
  // Read exactly (CX-123 rule 24): a holder that cannot be read throws, never "taken" about the store's own domain.
  let held = (await domainHolder(name)) ?? "";
  const holder = held.replace(/^\?/, "");
  if (held && !ours.includes(holder)) {
    // Another store's claim. A proved one is theirs. One not proved serves nothing and keeps nobody out (#4108):
    // the store whose TXT record is there takes it, only while the key still holds that same claim.
    if (!held.startsWith(UNPROVED)) return "taken";
    const proof = await hasProof(store, name);
    // The DNS could not say: the creator checks again, never told it is taken while their record may be there.
    if (proof === null) return "waiting";
    if (!proof) return "taken";
    return (await swapped(name, SWAP, held, store.handle)) ? "proved" : "waiting";
  }
  // Held under an older address of this same store: moved to the current one.
  if (held && holder !== store.handle) {
    const now = held.startsWith(UNPROVED) ? `${UNPROVED}${store.handle}` : store.handle;
    if (!(await swapped(name, SWAP_KEEPING_TTL, held, now))) return "waiting";
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
  if ((await hasProof(store, name)) !== true) return "waiting";
  // Only while the claim is still this store's: it may have lapsed and been
  // taken while the DNS was asked.
  return (await swapped(name, SWAP, `${UNPROVED}${store.handle}`, store.handle)) ? "proved" : "waiting";
}
