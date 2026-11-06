/**
 * The affiliate a buyer belongs to, for as long as the programme runs.
 *
 * Why this is not another cookie. Hotmart's affiliate settings offer a cookie
 * that lasts "for ever", and no such thing can be delivered by anybody: Chrome
 * caps the Expires and Max-Age of every cookie at 400 days, silently, whatever
 * a site asks for — it does not refuse the cookie, it shortens it and says
 * nothing (shipped in Chrome 104, August 2022). And long before that limit the
 * cookie is gone anyway, because it lives in one browser: clearing the browser
 * ends it, a new phone never had it, the work laptop is a different visitor,
 * and a private window starts empty. A window measured in days is the best a
 * cookie can honestly promise, which is why ours stops at 365.
 *
 * So the thing that actually lasts is not kept in the browser at all. Once a
 * sale has been credited to an affiliate — by a click, or by the code the buyer
 * typed — the creator may choose to have that buyer stay theirs: every later
 * purchase by the same person earns the same affiliate, with no cookie
 * anywhere. That survives a cleared browser, a different device, a private
 * window, 400 days and five years, because what is remembered is the buyer,
 * not the visit.
 *
 * It is off until a creator switches it on, and that is deliberate. It changes
 * who gets paid for a sale that nobody's link brought in, and only the creator
 * can decide whether the affiliate who found a customer should keep earning on
 * them. A programme already running is not quietly re-pointed.
 *
 * What is stored about the buyer is their address put through SHA-256 with the
 * store's own id, and nothing else — no name, no order, no list of what they
 * bought. The hash cannot be read back into an address, so the record answers
 * only the one question it exists for: an address arrives with a sale, and the
 * record says which affiliate, if any, that person already belongs to. It is
 * never shown to the affiliate, who sees counts and commissions as before.
 *
 *   nl:aff:<id>:bond   hash  sha256(store id + buyer address) -> affiliate id
 */
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { AttributionRule } from "@/lib/affiliate-setting";
import { orderWrite } from "@/lib/order-data";
import type { Store } from "@/lib/store";

/**
 * How many buyers one store may hold a bond for.
 *
 * Each is about eighty bytes, so the whole cap is a few megabytes — far below
 * anything that could move a bill, which is the point of having a number here
 * rather than letting a hash grow without end. A store that reaches it keeps
 * every bond it has and stops adding new ones; no sale is ever refused or
 * miscredited because of it, the buyer simply falls back to the click and the
 * code, which is what every store had before this existed.
 */
export const MAX_BONDS = 200_000;

const bondKey = (statsId: string) => `nl:aff:${statsId}:bond`;

/**
 * The one-way name a buyer is remembered under. The store's id is mixed in, so
 * the same person shopping at two stores is two unrelated hashes and no record
 * here can be lined up against another store's.
 */
function buyerHash(statsId: string, email: string): string {
  return createHash("sha256").update(`nimbus-aff-bond:${statsId}:${normaliseEmail(email)}`).digest("hex").slice(0, 32);
}

/** Whether this store has asked for its buyers to stay with their affiliate. */
export function bondsBuyers(store: Store): boolean {
  return store.affiliates.enabled && store.affiliates.lifetime && Boolean(store.statsId) && isRedisConfigured();
}

/**
 * The affiliate this buyer already belongs to, or "".
 *
 * Read only for a sale that no click and no code could credit, which is the
 * one case it is here to answer. Whether that affiliate is still approved is
 * checked by the caller, as it is for a code: somebody the creator removed
 * keeps their history and earns nothing more.
 */
export async function bondFor(store: Store, email: string): Promise<string> {
  if (!bondsBuyers(store) || !email) return "";
  const [found] = await redisPipeline([["HGET", bondKey(store.statsId as string), buyerHash(store.statsId as string, email)]]);
  return typeof found === "string" && /^[0-9a-f]{12}$/.test(found) ? found : "";
}

/**
 * Remembers that this buyer belongs to this affiliate, following the store's
 * own rule about which of two affiliates earns a sale: on first click the
 * affiliate who got there first keeps the buyer, so a later link cannot take
 * them; on last click the most recent one does.
 *
 * Called when a sale is credited, and it never throws into that path: a bond
 * that could not be written costs a future commission, while a sale that could
 * not be written down costs one that has already been earned.
 */
export async function rememberBuyer(store: Store, email: string, affiliateId: string, rule: AttributionRule): Promise<void> {
  if (!bondsBuyers(store) || !email || !/^[0-9a-f]{12}$/.test(affiliateId)) return;
  const key = bondKey(store.statsId as string);
  const field = buyerHash(store.statsId as string, email);
  if (rule === "first") {
    // Only if nobody has this buyer yet.
    await orderWrite(store, [["HSETNX", key, field, affiliateId]]);
    return;
  }
  // On last click a known buyer moves to the affiliate who brought them back;
  // an unknown one is only added while there is room under the cap.
  const [known] = await redisPipeline([["HEXISTS", key, field]]);
  if (Number(known) === 1) {
    await orderWrite(store, [["HSET", key, field, affiliateId]]);
    return;
  }
  const [count] = await redisPipeline([["HLEN", key]]);
  if (Number(count) >= MAX_BONDS) return;
  // Counted in the store's room as what the order that made it really adds (lib/order-data.ts).
  await orderWrite(store, [["HSET", key, field, affiliateId]]);
}

/** How many buyers this store has bonded, for the creator's own screen. */
export async function bondCount(store: Store): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [count] = await redisPipeline([["HLEN", bondKey(store.statsId)]]);
  return Number(count) || 0;
}

/**
 * Forgets one buyer's bond, by their address.
 *
 * Here because somebody asking to be forgotten is entitled to be, and a record
 * that cannot be undone is not one worth keeping. The address is hashed to find
 * the field, so this works without the record ever holding a readable address.
 */
export async function forgetBuyer(store: Store, email: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured() || !email) return false;
  const [removed] = await redisPipeline([["HDEL", bondKey(store.statsId), buyerHash(store.statsId, email)]]);
  return Number(removed) === 1;
}

/**
 * Forgets which affiliate one buyer belongs to (lib/person-erasure.ts). Only
 * the bond: a commission already earned on their purchase is a money record
 * of the affiliate's and stays in the affiliate program's books.
 */
export async function forgetBondPerson(statsId: string | null, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([["HDEL", bondKey(statsId), buyerHash(statsId, email)]]);
  return Number(gone) || 0;
}

/**
 * The affiliate a person is tied to, for the copy of their data (619 [SZ3]):
 * the record the erasure deletes, read whether or not the store's program
 * still ties buyers (bondFor answers "" then; the record is still kept).
 * Only reads.
 */
export async function bondRecordOf(statsId: string | null, email: string): Promise<string> {
  if (!statsId || !isRedisConfigured()) return "";
  const [raw] = await redisPipeline([["HGET", bondKey(statsId), buyerHash(statsId, email)]]);
  return typeof raw === "string" ? raw : "";
}
