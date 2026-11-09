/**
 * A store on the creator's own domain: shop.theirname.com instead of
 * marktmorgen.com/@theirname. Part of Pro.
 *
 * The domain is added to this site's project at Vercel, which checks the
 * creator's DNS and issues the certificate; this file asks Vercel what it sees
 * and turns that into the one or two records the creator has to add, in
 * words. Nothing here touches the creator's DNS: they add the records at
 * whoever sells them the domain, and we look again when they say they have.
 *
 *   nl:domain:<name>   the store handle a domain serves (read by proxy.ts);
 *                      "?<handle>" while the creator has not yet proved
 *                      the domain is theirs, which serves nothing and lapses
 *                      after three days (lib/domain-proof.ts)
 *
 * The marktmorgen.com address keeps working either way, so a link already
 * printed somewhere never breaks because a domain was added or removed.
 */
import { createHash } from "node:crypto";
import { DOMAINS_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, releaseMark } from "@/lib/claim-mark";
import { RELEASE } from "@/lib/redis-lock";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { canUse } from "@/lib/plan";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";

// Local tests may point this at a mock on 127.0.0.1; nothing else is accepted.
const API = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.VERCEL_API_BASE ?? "")
  ? `${process.env.VERCEL_API_BASE}`
  : "https://api.vercel.com";

// The project's id when the host gives it (VERCEL_PROJECT_ID, a system
// variable), because an id survives a rename and a name does not: the project
// was renamed from nimbus-labs to marktmorgen on 12 Oct 2026, and every call
// by the old name has answered "not found" since.
function vercelProject(): string {
  return process.env.VERCEL_DOMAINS_PROJECT?.trim() || process.env.VERCEL_PROJECT_ID?.trim() || "marktmorgen";
}
const TEAM = process.env.VERCEL_DOMAINS_TEAM?.trim() || "viniciussucupira";

function token(): string | null {
  const value = process.env.VERCEL_API_TOKEN?.trim();
  return value ? value : null;
}

/** Whether this deployment can add domains at all. */
export function isDomainsConfigured(): boolean {
  return token() !== null && isRedisConfigured();
}

/** Whether this store may use its own domain right now. */
export function canUseDomain(store: Pick<Store, "subscriptionActive" | "tier">): boolean {
  return canUse(store, "domain");
}

export const MAX_DOMAIN_LENGTH = 253;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_PATTERN = new RegExp(`^(?:${LABEL}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`);
const PLATFORM = new URL(SITE_URL).hostname;

/** Names that can never be a creator's: ours, the host's, and nothing local. */
function forbidden(name: string): boolean {
  return (
    name === PLATFORM ||
    name.endsWith(`.${PLATFORM}`) ||
    name.endsWith(".vercel.app") ||
    name === "vercel.app" ||
    name.endsWith(".vercel.com") ||
    name === "vercel.com" ||
    name.endsWith(".localhost") ||
    name.endsWith(".local") ||
    name.endsWith(".internal") ||
    name.endsWith(".test") ||
    name.endsWith(".example")
  );
}

/**
 * The domain as typed, reduced to a bare host name: no scheme, no path, no
 * port, lower case. Null when what is left is not one.
 */
export function cleanDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!value || value.length > MAX_DOMAIN_LENGTH) return null;
  if (!DOMAIN_PATTERN.test(value)) return null;
  if (/^\d+(\.\d+){3}$/.test(value)) return null;
  if (forbidden(value)) return null;
  return value;
}

export const domainKey = (name: string) => `nl:domain:${name}`;

/** How long a domain may stay claimed without being proved. */
export const UNPROVED_SECONDS = 3 * 24 * 60 * 60;

/** A claim not proved yet: kept apart from a proved one by its first character. */
export const UNPROVED = "?";

/**
 * The TXT record that proves a domain is this store's: its value is made
 * from the store's own id, so a record one creator adds for their store
 * proves nothing for anyone else's.
 */
export function proofRecord(store: Pick<Store, "sid">, name: string): { host: string; value: string } {
  const digest = createHash("sha256").update(`nimbus-domain-proof:${store.sid}:${name}`).digest("hex").slice(0, 32);
  return { host: `_marktmorgen.${name}`, value: `marktmorgen-verify=${digest}` };
}

/** Which store a domain serves. For the proxy; cached for a minute per instance. */
const cache = new Map<string, { handle: string | null; at: number }>();
export async function handleForDomain(name: string): Promise<string | null> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.handle;
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", domainKey(name)]]);
  // A domain nobody has proved is theirs serves nothing.
  const handle = typeof raw === "string" && raw && !raw.startsWith(UNPROVED) ? raw : null;
  cache.set(name, { handle, at: Date.now() });
  if (cache.size > 5_000) cache.clear();
  return handle;
}

/**
 * Points the domain at the store's new address after a rename, when it
 * still points at its old one; one not proved stays not proved. True when it
 * is known to follow (or had nothing to follow); false when that is not known
 * (Claude 4 on #2859, 6728179008: the read and the swap's reply are read
 * exactly, CX-123 rule 24), so the creator is told, and Check again
 * (proveDomain) moves it from the old address.
 */
export async function pointDomain(name: string, from: string[], handle: string): Promise<boolean> {
  try {
    const raw = await domainHolder(name);
    const holder = raw === null ? "" : raw.replace(/^\?/, "");
    if (raw === null || !holder || !from.includes(holder)) return true;
    const value = raw.startsWith(UNPROVED) ? `${UNPROVED}${handle}` : handle;
    // Written only if nobody changed it since it was read; 0 (changed meanwhile) is not known to follow either.
    const replies = repliesFor(await redisPipeline([["EVAL", SWAP_KEEPING_TTL, 1, domainKey(name), raw, value]]), 1);
    return replies !== null && replies[0] === 1;
  } catch {
    return false;
  } finally {
    cache.delete(name);
  }
}

/** Sets the key only while it still holds the value read, keeping its time to live. */
const SWAP_KEEPING_TTL = [
  'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end',
  'redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL")',
  "return 1",
].join("\n");

/**
 * What the domain's key holds, read exactly (CX-123 rule 24): the value, or null when nobody holds it. A reply in any
 * other shape throws UnknownReplyError, so nothing that depends on who holds a domain (asking Vercel to drop it,
 * deleting its key, telling the creator it is taken) is done on a guess.
 */
export async function domainHolder(name: string): Promise<string | null> {
  const replies = repliesFor(await redisPipeline([["GET", domainKey(name)]]), 1);
  const raw = replies?.[0];
  if (!replies || (raw !== null && typeof raw !== "string")) throw new UnknownReplyError("who holds a domain");
  return raw;
}

/**
 * Whether the domain is proved to be the store's: always for one connected before proofs were asked for. Throws
 * UnknownReplyError when that cannot be read, never "not proved".
 */
export async function domainProved(name: string): Promise<boolean> {
  const raw = await domainHolder(name);
  return typeof raw === "string" && raw !== "" && !raw.startsWith(UNPROVED);
}

/**
 * Deletes the domain's key only while it still holds `value` (one script, lib/redis-lock.ts RELEASE): true when that
 * is known to be done or the key holds something else now (not ours to delete), false when the answer is not known.
 */
async function letGoOf(name: string, value: string): Promise<boolean> {
  try {
    const replies = repliesFor(await redisPipeline([["EVAL", RELEASE, 1, domainKey(name), value]]), 1);
    return replies !== null && (replies[0] === 0 || replies[0] === 1);
  } catch {
    return false;
  }
}

type VercelAnswer = { status: number; body: Record<string, unknown> };

async function vercel(method: string, path: string, body?: unknown): Promise<VercelAnswer> {
  const key = token();
  if (!key) return { status: 503, body: {} };
  const separator = path.includes("?") ? "&" : "?";
  const url = `${API}${path}${separator}slug=${encodeURIComponent(TEAM)}`;
  try {
    // Given up after DOMAINS_TIMEOUT_MS (lib/fetch-timeout.ts), answered as "did not answer".
    return await timed(DOMAINS_TIMEOUT_MS, async (signal) => {
      const response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal,
      });
      const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: response.status, body: parsed };
    });
  } catch (error) {
    console.error("the domain service did not answer", error);
    return { status: 502, body: {} };
  }
}

/** One record the creator adds at their domain provider, in the words providers use. */
export type DnsRecord = { type: "A" | "CNAME" | "TXT"; name: string; value: string; why: string };

export type DomainStatus = {
  name: string;
  /** Vercel sees the records and has the certificate: the domain serves the store. */
  live: boolean;
  records: DnsRecord[];
};

/** The part of a domain in front of its apex, as a DNS panel wants it: "@" for the apex itself. */
function hostPart(name: string, apex: string): string {
  if (name === apex) return "@";
  return name.slice(0, name.length - apex.length - 1);
}

/**
 * What Vercel sees for a domain, and what is still missing; null when it
 * could not be told. Read as strictly as the checkup (CX-123 rule 24): the
 * studio's check takes a live domain off when this says it is not live, so
 * an answer that did not come, or came without Vercel's verdicts, is never
 * read as records that are wrong.
 */
export async function domainStatus(name: string, store: Pick<Store, "sid">): Promise<DomainStatus | null> {
  // "Gone" and not known are the same null here, so the checkup's second request is not made (review of Codex P).
  const read = await readDomain(name, store, false);
  return read === "gone" ? null : read;
}

/**
 * The same, read strictly for the studio's checkup (491 [PP2]): "gone" when
 * Vercel says the domain is not on the project any more (a problem to tell
 * the creator, not a failure to read), and null whenever either answer did
 * not come, so a missing answer is never taken for records that are wrong.
 */
export async function domainCheckup(name: string, store: Pick<Store, "sid">): Promise<DomainStatus | "gone" | null> {
  return readDomain(name, store, true);
}

async function readDomain(name: string, store: Pick<Store, "sid">, tellGone: boolean): Promise<DomainStatus | "gone" | null> {
  const project = await vercel("GET", `/v9/projects/${vercelProject()}/domains/${name}`);
  if (project.status === 404) {
    if (!tellGone) return null;
    // "Not found" is also every answer while the project's own name is wrong (see vercelProject):
    // the domain is gone only when the project itself is there.
    const own = await vercel("GET", `/v9/projects/${vercelProject()}`);
    return own.status === 200 ? "gone" : null;
  }
  if (project.status !== 200) return null;
  // Not known whether it is proved: not known whether it is live (the studio's check would take a live domain off).
  const proved = await domainProved(name).catch(() => null);
  if (proved === null) return null;
  const config = await vercel("GET", `/v6/domains/${name}/config?projectIdOrName=${vercelProject()}`);
  // An answer whose verdicts are not there is not read as records that are wrong.
  if (config.status !== 200 || typeof config.body.misconfigured !== "boolean" || typeof project.body.verified !== "boolean") return null;
  const apex = typeof project.body.apexName === "string" ? project.body.apexName : name;
  const verified = project.body.verified === true;
  const misconfigured = config.status !== 200 || config.body.misconfigured !== false;

  const records: DnsRecord[] = [];
  if (name === apex) {
    const list = Array.isArray(config.body.recommendedIPv4) ? (config.body.recommendedIPv4 as { rank: number; value: string[] }[]) : [];
    const best = [...list].sort((a, b) => a.rank - b.rank)[0];
    const ip = best && Array.isArray(best.value) && typeof best.value[0] === "string" ? best.value[0] : "76.76.21.21";
    records.push({ type: "A", name: "@", value: ip, why: "Points your domain to your store." });
  } else {
    const list = Array.isArray(config.body.recommendedCNAME) ? (config.body.recommendedCNAME as { rank: number; value: string }[]) : [];
    const best = [...list].sort((a, b) => a.rank - b.rank)[0];
    const target = best && typeof best.value === "string" ? best.value.replace(/\.$/, "") : "cname.vercel-dns.com";
    records.push({ type: "CNAME", name: hostPart(name, apex), value: target, why: "Points this address to your store." });
  }
  if (!verified && Array.isArray(project.body.verification)) {
    for (const item of project.body.verification as { type?: string; domain?: string; value?: string }[]) {
      if (item.type === "TXT" && typeof item.domain === "string" && typeof item.value === "string") {
        records.push({
          type: "TXT",
          name: hostPart(item.domain, apex),
          value: item.value,
          why: "Proves the domain is yours. It is in use somewhere else at the moment, so this is needed once.",
        });
      }
    }
  }
  if (!proved) {
    const proof = proofRecord(store, name);
    records.push({
      type: "TXT",
      name: hostPart(proof.host, apex),
      value: proof.value,
      why: "Proves the domain is yours, so no other store can use it. It can stay there.",
    });
  }
  return { name, live: proved && verified && !misconfigured, records };
}

export type ConnectResult =
  | { ok: true; name: string }
  | { ok: false; reason: "shape" | "taken" | "elsewhere" | "has_one" | "unavailable" | "plan" };

/**
 * Adds a domain to a store: claims it here first, so two stores cannot both
 * have it, then asks Vercel to serve it. A claim Vercel refuses is let go.
 */
export async function connectDomain(store: Store, raw: string): Promise<ConnectResult> {
  if (!canUseDomain(store)) return { ok: false, reason: "plan" };
  if (!isDomainsConfigured()) return { ok: false, reason: "unavailable" };
  if (store.domain) return { ok: false, reason: "has_one" };
  const name = cleanDomain(raw);
  if (!name) return { ok: false, reason: "shape" };

  // Claimed as not proved yet: it serves nothing, and lapses, until the
  // creator adds the TXT record that proves it is theirs. Read exactly
  // (CX-123 rule 24, claimMark): "OK" is ours, nil is taken, any other reply
  // is read back; one that cannot be read asks Vercel nothing.
  const claim = `${UNPROVED}${store.handle}`;
  const claimed = await claimMark(domainKey(name), UNPROVED_SECONDS, claim);
  if (claimed === "unknown") throw new UnknownReplyError("a domain's claim");
  // A nil is not always another store (Claude 4 on #2859, 6728179008): this store's own claim may be left from a press
  // whose answer was not known, or whose write to the store failed after the claim, and it would read as "taken" for
  // up to UNPROVED_SECONDS. Who holds it is read exactly (it throws when that cannot be told, before Vercel is asked):
  // this store's own value, under an address it still owns (as proveDomain reads it), goes on; anything else, an
  // address this store let go of included, stays taken. Only the exact `claim` is ever let go below, never a proof.
  if (claimed === "taken") {
    const holder = await domainHolder(name);
    const ours = [store.handle, ...store.previousHandles];
    if (holder === null || !ours.includes(holder.replace(/^\?/, ""))) return { ok: false, reason: "taken" };
  }

  const added = await vercel("POST", `/v10/projects/${vercelProject()}/domains`, { name });
  // Already on this project (a second press, or added by hand) is fine;
  // on somebody else's is not.
  const alreadyHere =
    added.status === 409 && (await vercel("GET", `/v9/projects/${vercelProject()}/domains/${name}`)).status === 200;
  if (added.status !== 200 && !alreadyHere) {
    // Only this store's own claim is let go of, never a key another store holds by now; one that cannot be let go
    // lapses on its own.
    await releaseMark(domainKey(name), claim);
    cache.delete(name);
    if (added.status === 409) return { ok: false, reason: "elsewhere" };
    if (added.status === 400) return { ok: false, reason: "shape" };
    return { ok: false, reason: "unavailable" };
  }
  cache.delete(name);
  return { ok: true, name };
}

/** Asks Vercel to check the proving record again, for a domain in use elsewhere. */
export async function verifyDomain(name: string): Promise<void> {
  await vercel("POST", `/v9/projects/${vercelProject()}/domains/${name}/verify`);
}

/**
 * What taking a domain off came to: "removed"; "unavailable" when nothing was changed (Vercel did not drop it);
 * "unfinished" when Vercel has already dropped it, so it no longer serves the store, but letting its key go here
 * could not be confirmed (review L1 on #2859): never said as "nothing was changed", and the next press finishes it.
 */
export type DisconnectResult = "removed" | "unavailable" | "unfinished";

/** Takes a domain off a store. The marktmorgen.com address carries on as before. */
export async function disconnectDomain(name: string, handles: string[]): Promise<DisconnectResult> {
  // A claim that lapsed and was taken by another store is theirs now: only
  // this store's side of it is let go of. Who holds it is read exactly: one
  // that cannot be read throws before Vercel is asked or anything deleted.
  const raw = await domainHolder(name);
  const holder = raw === null ? "" : raw.replace(/^\?/, "");
  if (holder && !handles.includes(holder)) return "removed";
  const removed = await vercel("DELETE", `/v9/projects/${vercelProject()}/domains/${name}`);
  if (removed.status !== 200 && removed.status !== 404) return "unavailable";
  // The key is deleted only while it holds what was read; a let-go not known to be done is not said as done, and
  // the next press finds Vercel's side already gone (404) and lets the key go again.
  const letGo = raw === null || (await letGoOf(name, raw));
  cache.delete(name);
  return letGo ? "removed" : "unfinished";
}
