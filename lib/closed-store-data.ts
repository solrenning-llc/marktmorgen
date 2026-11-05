/**
 * A closed store's records in the database, deleted (added 18 October 2026).
 *
 * A store whose plan ended closes on its closing day (lib/plan-closing.ts):
 * its files that day, and every record it keeps here within
 * ERASE_WITHIN_DAYS, so a store that pays nothing stops costing anything.
 * Before this, a closed store's records stayed for ever, a little each month
 * with no payment behind it, and closed stores only ever add up. Nothing of
 * it is copied anywhere first: its sales are on its owner's own Stripe
 * account, and its owner was offered all of it as one file
 * (lib/store-export.ts).
 *
 * What goes, and what is kept, is said family by family in CLOSING
 * (lib/data-families.ts), and tests/closing-families.test.ts fails for a
 * family of tests/store-data-registry.ts that does not say. In order:
 *
 *   1. prepare: what is found only through the store's own record, while it
 *      can still be read (its team, its keys for the API, its webhooks, its
 *      email platform, its phones, its calendar hosts' claims); then the
 *      store record itself, its addresses held back from anyone else for a
 *      month. Its PDFs' previews go on its closing day, with its files.
 *      From then on no page, checkout or job finds the store, so nothing new
 *      is written for it.
 *   2. the walk: the whole database, a page at a time. A key of a family
 *      CLOSING says is erased, named by one of the store's own ids, is
 *      deleted, and what the family's follower finds through it first (the
 *      stop links its contacts were sent, the certificates its courses gave,
 *      the tokens its listeners' feeds open by...). A list of the
 *      company's that names stores loses this store's members. Nothing else
 *      is touched: a key that names no closing store is passed over, and a
 *      person's records across stores lose only this store's part. A
 *      buyer's library, the lists a person joined and an affiliate's hub
 *      (lib/joined-stores.ts) are not walked person by person: what names the
 *      store in them points at nothing once it is gone, is never shown, and
 *      runs out with the quarter it was written in (CLOSING, "lapses").
 *   3. finish: the closing record says when, and its owner is emailed.
 *
 * Stores are deleted together: those that came due since the last walk
 * share the next one, so the database is read once a day at the most,
 * whatever number closes. Each step can be run again; the walk is resumable
 * from where it stopped, page by page, and a key already gone is passed over.
 *
 * Every answer from Redis is read in its exact shape (CX-123, rule 24). One
 * that fails, or comes back in any other shape, is never taken for "the store
 * is gone", "it has nothing" or "this page is empty": the step stops before it
 * deletes on it, and is tried again. A store whose first step fails stays in
 * line and is tried again after WALK_GAP_MS; after PREPARE_TRIES failures it
 * is parked: tried again by itself once every PARKED_GAP_MS, and said on
 * every run, never dropped. Its record, and every record the walk deletes,
 * are kept until a try succeeds; what its first step had deleted before the
 * failure (claims, calendars, team, keys for the API, webhooks...) stays
 * deleted, and a try after it finds the rest. A page of the walk that fails
 * stops the run where it was, and is read again by the next; after
 * PAGE_TRIES failures the keys it cannot read are passed over, said, and the
 * stores they belong to are not finished: they stay in the batch for the next
 * walk. A store is finished, and its closing record says "erased", only once
 * Redis answers exactly that its record is gone.
 *
 *   nl:closed:due     sorted set  a store's key -> when its records came due, or are tried again (ms)
 *   nl:closed:batch   hash        a store's key -> what the walk needs of it (JSON), while its walk runs
 *   nl:closed:walk    hash        cursor, started, phase, finished, pagetries; tries:<a store's key> -> its
 *                                 first step's failures; partial:<a store's key> -> 1 when a key of it was passed over
 *
 * Reading the database is the company's, bounded by its schedule: one walk a
 * day at the most, WALK_COUNT keys a command (docs/funded-exposure-review.md).
 * What is done for each store, its deletes in DEL_BATCH keys a command and
 * what its followers read, is priced once for each store, against its own
 * payments (tests/plan-cost-registry.ts, closure), and the renewals it stops
 * with the orders that sold them (ORDER_COST).
 */
import { onAccount } from "@/lib/stripe-account";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { CLOSING, type Closing, closingFamilyOf } from "@/lib/data-families";
import { DEL_BATCH, FOLLOW_BATCH, RENEWALS_AT_ONCE } from "@/lib/plan-closing-rules";
import { idsIn } from "@/lib/data-recount";
import { readAllListingsExact } from "@/lib/catalog";
import { readCoursesExact } from "@/lib/course";
import { readFlowsExact } from "@/lib/flows";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { type Store, accountStores, closeStoreRecord, saleHandles, storeFolder, storeForClosing, storeRef } from "@/lib/store";
import { domainKey } from "@/lib/domains";
import { dropTeam, memberStores, readTeam } from "@/lib/team";
import { hostCalendarKeys } from "@/lib/host-calendar";
import { revokeAllKeys } from "@/lib/api-keys";
import { forgetStoreWebhooks } from "@/lib/webhooks";
import { forgetStoreSync } from "@/lib/email-sync";
import { forgetShipmentMail } from "@/lib/shipment-mail-outbox";
import { forgetOrderConfirmationMail } from "@/lib/order-confirmation-outbox";
import { forgetStorePhones } from "@/lib/phone-alerts";
import { claimsKey, hostId } from "@/lib/host-claims";
import { MAX_PREVIEW_PAGES, previewKey } from "@/lib/pdf-preview";
import { problemKey } from "@/lib/pdf-stamp";
import { tokenKey as unsubTokenKey, parseContact } from "@/lib/contacts";
import { keyIndex as linkKeyIndex, linkKeyOf } from "@/lib/mail-clicks";
import { unsubKey as communityUnsubKey } from "@/lib/community-mail";
import { tokenKey as chatTokenKey } from "@/lib/inbox";
import { linkKey as inviteLinkKey } from "@/lib/move-members";
import { linkKey as pitchStopKey } from "@/lib/outreach";
import { tokenKey as feedTokenKey } from "@/lib/podcast-access";
import { certKey } from "@/lib/certificate";
import { linkKey as shortLinkKey } from "@/lib/short-links";
import { lookupKey as shareLookupKey } from "@/lib/funnel-share-store";
import { broadcastKeys } from "@/lib/broadcasts";
import { paypalOrderKeys } from "@/lib/paypal-sales";
import { calendarKeys } from "@/lib/calendar-sync";
import { packageKeys } from "@/lib/call-packages";
import { requestRecordKey } from "@/lib/payment-request-store";
import { agreementKeys } from "@/lib/agreement-store";
import { letterRecordKey } from "@/lib/letters";
import { passKeyOfHash } from "@/lib/learn";
import { forgetPath } from "@/lib/path";

export const DUE_KEY = "nl:closed:due";
export const BATCH_KEY = "nl:closed:batch";
export const WALK_KEY = "nl:closed:walk";
/** Keys one SCAN of the walk asks for. */
export const WALK_COUNT = 1000;
/** The most pages of the database one run of the walk reads. */
export const WALK_PAGES_PER_RUN = 3_000;
/** A walk starts at most this often; stores that come due in between wait for the next. */
export const WALK_GAP_MS = 20 * 60 * 60 * 1000;
/** The most stores one walk deletes. */
export const BATCH_MAX = 200;
/**
 * The most times a store's first step is tried, WALK_GAP_MS apart at the
 * least: a few days of a failing database. Each try reads what the first step
 * reads, at most PREPARE_COMMANDS (tests/plan-cost-registry.ts); a try after
 * the first is paid by the company, for its database's failure.
 */
export const PREPARE_TRIES = 5;
/** How often a parked store is tried again, by itself: the company's, one first step a week for each. */
export const PARKED_GAP_MS = 7 * 24 * 60 * 60 * 1000;
/** The runs a page of the walk fails before the keys it cannot read are passed over (and said), so one key never holds every store. */
export const PAGE_TRIES = 3;
/** The pages of one host's claims read at the most (COUNT 500): its claims not read to the end stop the first step. */
export const CLAIM_PAGES = 50;

/** An answer from Redis in any shape but its exact one, or not read to its end: never empty, zero or done (CX-123, rule 24). */
export class ClosedReadError extends Error {
  constructor(what: string) {
    super(`closed-store-data: ${what}`);
    this.name = "ClosedReadError";
  }
}
const refuse = (what: string): never => {
  throw new ClosedReadError(`${what} answered in an unknown shape`);
};
const CURSOR = /^(0|[1-9][0-9]*)$/;
const allStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const countOf = (value: unknown, what: string): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : refuse(what));

/** One page of SCAN, HSCAN, SSCAN or ZSCAN, exactly: a cursor and its items, in pairs for a hash or a sorted set. */
function pageOf(reply: unknown, what: string, pairs = false): { cursor: string; items: string[] } {
  if (!Array.isArray(reply) || reply.length !== 2) return refuse(what);
  const [cursor, items] = reply as unknown[];
  if (typeof cursor !== "string" || !CURSOR.test(cursor) || !allStrings(items) || (pairs && items.length % 2 !== 0)) return refuse(what);
  return { cursor, items };
}

/** What the walk needs of a store, kept while its walk runs (the store record itself is gone by then). */
export type Batched = {
  ref: string;
  email: string;
  sid: string;
  statsId: string | null;
  name: string;
  handle: string;
  handles: string[];
  /** Every id the store's own keys are named by. */
  marks: string[];
  endedAt: number;
  at: number;
};

/** Every file-like record in what a store keeps: a path and the day it was added. */
function filesIn(value: unknown, out: { pathname: string; addedAt: string }[] = [], depth = 0): { pathname: string; addedAt: string }[] {
  if (!value || typeof value !== "object" || depth > 12) return out;
  if (Array.isArray(value)) {
    for (const item of value) filesIn(item, out, depth + 1);
    return out;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.pathname === "string" && typeof row.addedAt === "string") out.push({ pathname: row.pathname, addedAt: row.addedAt });
  for (const item of Object.values(row)) if (item && typeof item === "object") filesIn(item, out, depth + 1);
  return out;
}

/**
 * The ids a store's own keys are named by: its own (store, stats, list,
 * calls, catalog, community, files' folder), and every id in what it is
 * made of (its products, sequences and courses: their ids, their videos,
 * their links). Its Stripe account's id only when no other store of its
 * owner sells through the same account. Never its plan's ids on our own
 * Stripe account, which name the company's records about its plan.
 */
export async function marksOf(store: Store): Promise<{ marks: string[]; files: { pathname: string; addedAt: string }[] }> {
  // A read that fails stops here (SG2, finding 3): marks found without it would leave its keys behind for ever.
  // Each read exactly: an answer of another shape is never taken for nothing (SG2 review, B).
  const listings = await readAllListingsExact(store);
  const flows = store.listId ? await readFlowsExact(store.listId) : [];
  const courseIds = listings.flatMap((l) => (l.course ? [l.course.id] : []));
  const courses = courseIds.length ? [...(await readCoursesExact(courseIds)).values()] : [];
  const own = [store.sid, store.statsId, store.listId, store.callsId, store.catalog?.id, store.community?.id, await storeFolder(storeRef(store)), store.photoId];
  const found = new Set<string>([...own.filter((id): id is string => typeof id === "string" && id.length >= 6), ...idsIn(JSON.stringify(store), JSON.stringify(listings), JSON.stringify(flows), JSON.stringify(courses))]);
  for (const id of [...courseIds, ...listings.flatMap((l) => (l.podcast ? [l.podcast.id] : [])), ...flows.map((f) => f.id)]) if (id) found.add(id);
  for (const ours of [store.stripeCustomerId, store.subscriptionId]) if (ours) found.delete(ours);
  if (store.stripeAccountId && (await sharedAccount(store))) found.delete(store.stripeAccountId);
  // The owner's address and the store's addresses are not ids: the walk matches them only where a family says so.
  found.delete(store.email);
  return { marks: [...found].sort(), files: filesIn([listings, courses]) };
}

/** Whether another store of the same owner sells through the same Stripe account: then its account's records are not this store's to delete. */
async function sharedAccount(store: Store): Promise<boolean> {
  const others = await accountStores(store.email);
  return others.some((other) => other.sid !== store.sid && other.stripeAccountId === store.stripeAccountId);
}

/** Puts a store in line for the next walk. */
export async function markDue(ref: string, now = Date.now()): Promise<void> {
  await redisPipeline([["ZADD", DUE_KEY, "NX", now, ref]]);
}

/** Takes a store out of line: its plan was started again before its walk began. Its first step's failures go with it. */
export async function unmarkDue(ref: string): Promise<void> {
  await redisPipeline([["ZREM", DUE_KEY, ref], ["HDEL", WALK_KEY, triesField(ref)]]);
}

const triesField = (ref: string) => `tries:${ref}`;

/**
 * On a closing store's day, before its files go (lib/plan-closing.ts): what
 * its files left here under their own names, not the store's, which only its
 * products' files can find: its PDFs' previews and problem notes. A buyer's
 * stamped copy is a file in the store's folder, and goes with it. Safe to
 * run again. Answers how many keys it deleted.
 */
export async function deleteSalesTraces(store: Store): Promise<number> {
  const { files } = await marksOf(store);
  const keys: string[] = [];
  for (const file of files.filter((f) => /\.pdf$/i.test(f.pathname))) {
    for (let pages = 1; pages <= MAX_PREVIEW_PAGES; pages += 1) keys.push(previewKey(file, pages));
    keys.push(problemKey(file.pathname));
  }
  await del(keys);
  return keys.length;
}

async function del(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DEL_BATCH) await redisPipeline([["DEL", ...keys.slice(i, i + DEL_BATCH)]]);
}

/**
 * The first step for one store, while its record can still be read: what
 * is found only through it, and then the record. Answers what the walk
 * needs of it, and hands it to `keep` before the record goes, so a store
 * whose record is gone is always one the walk has. Safe to run again: every
 * read comes before the deletes it decides, and one that fails throws before
 * anything is deleted on it (SG2, findings 3 and 18), so the next try reads
 * the same store again.
 */
export async function prepareStore(store: Store, now = Date.now(), keep?: (entry: Batched) => Promise<void>): Promise<Batched> {
  const ref = storeRef(store);
  const { marks } = await marksOf(store);
  const extra: string[] = [];
  // Its calendar hosts' claims, which are kept by the host, across the stores they serve.
  const team = store.sid ? await readTeam(store.sid) : { members: [] };
  const own = new Set(marks);
  for (const host of [store.email, ...team.members.map((m) => m.email)].map(hostId)) {
    let cursor = "0";
    let whole = false;
    for (let round = 0; round < CLAIM_PAGES; round += 1) {
      const [reply] = await redisPipeline([["HSCAN", claimsKey(host), cursor, "COUNT", 500]]);
      const page = pageOf(reply, "a host's claims", true);
      const mine: string[] = [];
      for (let i = 0; i + 1 < page.items.length; i += 2) if (pieces(page.items[i + 1]).some((part) => own.has(part))) mine.push(page.items[i]);
      if (mine.length) await redisPipeline([["HDEL", claimsKey(host), ...mine]]);
      cursor = page.cursor;
      if (cursor === "0") {
        whole = true;
        break;
      }
    }
    if (!whole) throw new ClosedReadError(`a host's claims were not read to their end in ${CLAIM_PAGES} pages`);
  }
  // A host's own calendar is the host's, across the stores they serve: it goes with the last of them.
  for (const email of [store.email, ...team.members.map((m) => m.email)]) {
    const elsewhere = (await memberStores(email)).some((m) => m.store.sid !== store.sid)
      || (await accountStores(email)).some((other) => other.sid !== store.sid);
    if (!elsewhere) extra.push(...hostCalendarKeys(hostId(email)));
  }
  if (store.domain?.name) extra.push(domainKey(store.domain.name));
  // Before its team goes: a try after this one no longer finds its team's calendars.
  await del(extra);
  await dropTeam(store);
  if (store.sid) await revokeAllKeys(store.sid);
  await forgetStoreWebhooks(store.statsId);
  await forgetStoreSync(store.statsId);
  await forgetShipmentMail(store.statsId);
  await forgetOrderConfirmationMail(store.statsId);
  await forgetStorePhones(store.statsId);
  // The owner's path: their answers and the days they showed up (lib/path.ts).
  await forgetPath(store);
  const entry: Batched = {
    ref,
    email: store.email,
    sid: store.sid,
    statsId: store.statsId,
    name: store.name,
    handle: store.handle,
    handles: [...saleHandles(store)],
    marks,
    endedAt: Date.parse(store.planEndedAt) || now,
    at: now,
  };
  if (keep) await keep(entry);
  // Out of the closing day's line before its record goes (queue item 307 [EC1]): a new store its owner opens
  // under the same key is never taken for this one. A plan paid under this store's addresses after this is
  // still found by their mark (lib/closing-plan-guard.ts, markShut).
  await redisPipeline([["ZREM", FINAL_INDEX, ref]]);
  await closeStoreRecord(store);
  return entry;
}

/** Who owns a key: the closing store one of whose ids names it. */
type Owners = { byMark: Map<string, string>; byHandle: Map<string, string>; byRef: Map<string, string> };

function ownersOf(batch: Batched[]): Owners {
  const owners: Owners = { byMark: new Map(), byHandle: new Map(), byRef: new Map() };
  for (const entry of batch) {
    for (const mark of entry.marks) owners.byMark.set(mark, entry.ref);
    for (const handle of entry.handles) owners.byHandle.set(handle, entry.ref);
    owners.byRef.set(entry.ref, entry.ref);
  }
  return owners;
}

const pieces = (text: string) => text.split(/[:|,]/);

/** The closing store a key belongs to, if any: by an id in its name, or, for a family named by address, by an address. */
export function ownerOfKey(key: string, rule: Closing, owners: Owners): string | null {
  const parts = pieces(key);
  if (rule.how === "erase" && rule.by === "handle") {
    for (const part of parts) if (owners.byHandle.has(part)) return owners.byHandle.get(part)!;
    return null;
  }
  for (const part of parts) {
    if (owners.byMark.has(part)) return owners.byMark.get(part)!;
    if (owners.byRef.has(part)) return owners.byRef.get(part)!;
  }
  return null;
}

/** Whether a member of a company list names a closing store. */
function namesStore(member: string, owners: Owners): boolean {
  if (owners.byRef.has(member)) return true;
  return pieces(member).some((part) => owners.byMark.has(part) || owners.byRef.has(part));
}

/**
 * What keys of the store lead to that are named by a token, not by the
 * store, read from the keys themselves: each family's own record of it. The
 * keys found must be of a family whose rule names this one (`via`), or they
 * are not deleted. A follower is handed every key of its family the page
 * found for one store at once, so a family with a key for each buyer (a
 * conversation, a listener's feed, an address's records) is read a thousand
 * keys at a command (MGET, SUNION), not a key at a time: what it costs is
 * priced with the store (tests/plan-cost-registry.ts, closure).
 */
type Follower = { match: (key: string) => boolean; find: (keys: string[], entry: Batched) => Promise<string[]> };

const READ_BATCH = FOLLOW_BATCH;

/** Every page of one key, each read exactly; a key not read to its end in SCAN_ROUNDS pages is refused, never half read. */
const SCAN_ROUNDS = 10_000;
async function scanAll(command: "HSCAN" | "SSCAN" | "ZSCAN", key: string, each: (flat: string[]) => Promise<void> | void): Promise<void> {
  let cursor = "0";
  for (let round = 0; round < SCAN_ROUNDS; round += 1) {
    const [reply] = await redisPipeline([[command, key, cursor, "COUNT", 1000]]);
    const page = pageOf(reply, command, command !== "SSCAN");
    await each(page.items);
    cursor = page.cursor;
    if (cursor === "0") return;
  }
  throw new ClosedReadError(`${command} was not read to its end in ${SCAN_ROUNDS} pages`);
}

const json = (raw: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
/** A record a follower reads: none for a key that is gone (""); one that cannot be read is unknown, never "it has no token". */
const recordOf = (raw: string): Record<string, unknown> | null => (raw === "" ? null : json(raw) ?? refuse("a record a follower reads"));
const fieldOf = (raw: string, name: string): string => {
  const value = recordOf(raw)?.[name];
  return typeof value === "string" ? value : "";
};
/** The kinds of key TYPE names; any other answer is refused, never taken for a key that is gone. */
const TYPES = new Set(["none", "string", "list", "set", "zset", "hash", "stream"]);
async function typeOf(key: string): Promise<string> {
  const [raw] = await redisPipeline([["TYPE", key]]);
  return typeof raw === "string" && TYPES.has(raw) ? raw : refuse("TYPE");
}
const LIST_PAGE = 10_000;
async function membersOf(key: string): Promise<string[]> {
  const type = await typeOf(key);
  const out: string[] = [];
  if (type === "none") return out;
  if (type === "set") await scanAll("SSCAN", key, (flat) => void out.push(...flat));
  else if (type === "zset") await scanAll("ZSCAN", key, (flat) => void out.push(...flat.filter((_, i) => i % 2 === 0)));
  else if (type === "hash") await scanAll("HSCAN", key, (flat) => void out.push(...flat.filter((_, i) => i % 2 === 0)));
  else if (type === "list") {
    // A page at a time to its end: a list longer than one page is never cut at it.
    for (let round = 0; ; round += 1) {
      if (round >= SCAN_ROUNDS) throw new ClosedReadError(`LRANGE was not read to its end in ${SCAN_ROUNDS} pages`);
      const [items] = await redisPipeline([["LRANGE", key, round * LIST_PAGE, (round + 1) * LIST_PAGE - 1]]);
      if (!allStrings(items) || items.length > LIST_PAGE) return refuse("LRANGE");
      out.push(...items);
      if (items.length < LIST_PAGE) break;
    }
  }
  // A string or a stream: Redis said exactly what it is, and it has no members.
  return out;
}
/** String keys' values, READ_BATCH at a command, in the keys' order; "" for a key that is gone or of another kind (MGET's nil), which no follower reads as one. */
async function stringsOf(keys: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < keys.length; i += READ_BATCH) {
    const some = keys.slice(i, i + READ_BATCH);
    const [values] = await redisPipeline([["MGET", ...some]]);
    // One value for each key, in its place: any other answer would line values up with the wrong keys.
    if (!Array.isArray(values) || values.length !== some.length || !values.every((v) => typeof v === "string" || v === null)) refuse("MGET");
    for (const value of values as (string | null)[]) out.push(value ?? "");
  }
  return out;
}
/** Every member of these sets, READ_BATCH at a command; only when Redis says a key is of another kind are they read one by one, by their kind. */
async function unionOf(keys: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += READ_BATCH) {
    const some = keys.slice(i, i + READ_BATCH);
    let members: unknown;
    try {
      [members] = await redisPipeline([["SUNION", ...some]]);
    } catch (error) {
      // A timeout or any other failure is no answer: refused, never read again as if a key were of another kind.
      if (!/WRONGTYPE/.test(String((error as Error | null)?.message ?? error))) throw error;
      for (const key of some) for (const member of await membersOf(key)) out.add(member);
      continue;
    }
    if (!allStrings(members)) refuse("SUNION");
    for (const member of members as string[]) out.add(member);
  }
  return [...out];
}
async function hashValues(key: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  // Gone, or of another kind Redis named exactly: no fields. An unknown answer was refused by typeOf.
  if ((await typeOf(key)) !== "hash") return out;
  await scanAll("HSCAN", key, (flat) => {
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  });
  return out;
}
/** A field of each value of these hashes, each hash on its own: families with one such key a store or a course. */
async function fieldsOf(keys: string[], name: string): Promise<string[]> {
  const out: string[] = [];
  for (const key of keys) for (const [, raw] of await hashValues(key)) out.push(fieldOf(raw, name));
  return out.filter(Boolean);
}

export const FOLLOWERS: Readonly<Record<string, Follower>> = {
  // The list: each contact's stop link and the key its links carry.
  "nl:store:leads:": {
    match: (key) => /^nl:store:leads:[0-9a-f]{32}$/.test(key),
    find: async (keys) => {
      const out: string[] = [];
      for (const key of keys) {
        for (const [, raw] of await hashValues(key)) {
          const contact = parseContact(raw);
          if (!contact) refuse("a contact of the store's list");
          const token = contact?.t;
          if (token) out.push(unsubTokenKey(token), linkKeyIndex(linkKeyOf(token)));
        }
      }
      return out;
    },
  },
  // A community's members: the link in their announcements that stops them.
  "nl:cm:": {
    match: (key) => /^nl:cm:[^:]+:m$/.test(key),
    find: async (keys) => (await fieldsOf(keys, "t")).map(communityUnsubKey),
  },
  // A conversation in the inbox: what its visitor's chat opens.
  "nl:inbox:": {
    match: (key) => /^nl:inbox:[^:]+:c:[^:]+$/.test(key),
    find: async (keys) => (await stringsOf(keys)).map((raw) => fieldOf(raw, "token")).filter(Boolean).map(chatTokenKey),
  },
  // Members invited over from another platform: each invite's link.
  "nl:mv:": {
    match: (key) => /^nl:mv:[^:]+$/.test(key),
    find: async (keys) => (await fieldsOf(keys, "t")).map(inviteLinkKey),
  },
  // Pitches: the stop link in each one's footer.
  "nl:outreach:": {
    match: (key) => /^nl:outreach:[^:]+:pitches$/.test(key),
    find: async (keys) => (await fieldsOf(keys, "stop")).map(pitchStopKey),
  },
  // A listener's private feed: the token it opens by.
  "nl:pod:by:": {
    match: () => true,
    find: async (keys) => (await stringsOf(keys)).filter(Boolean).map(feedTokenKey),
  },
  // The records made for one address: every link the store emailed them.
  "nl:erase:ix:": {
    match: () => true,
    find: async (keys) => (await unionOf(keys)).filter((k) => k.startsWith("nl:")),
  },
  // A course's certificates, kept by their own id.
  "nl:course:": {
    match: (key) => /:certs:all$/.test(key),
    find: async (keys) => (await unionOf(keys)).filter((id) => /^[A-Za-z0-9_-]{6,64}$/.test(id)).map(certKey),
  },
  "nl:slink:store:": {
    match: () => true,
    find: async (keys) => (await unionOf(keys)).filter((code) => /^[A-Za-z0-9_-]{1,64}$/.test(code)).map(shortLinkKey),
  },
  "nl:fshares:": {
    match: () => true,
    find: async (keys) => (await fieldsOf(keys, "hash")).filter((h) => /^[0-9a-f]{16,64}$/.test(h)).map(shareLookupKey),
  },
  "nl:mail:bcs:": {
    match: () => true,
    find: async (keys) => (await unionOf(keys)).filter((id) => /^[A-Za-z0-9_-]{6,64}$/.test(id)).flatMap(broadcastKeys),
  },
  // A store's PayPal sales: a sorted set, one a store.
  "nl:ppsell:sales:": {
    match: () => true,
    find: async (keys) => {
      const out: string[] = [];
      for (const key of keys) for (const order of await membersOf(key)) out.push(...paypalOrderKeys(order));
      return out;
    },
  },
  "nl:cal:cfg:": {
    match: () => true,
    find: async (keys) => (await stringsOf(keys)).flatMap((raw) => (raw ? calendarKeys(recordOf(raw)) : [])),
  },
  "nl:learn:passes:": {
    match: () => true,
    find: async (keys) => (await unionOf(keys)).filter((h) => /^[0-9a-f]{64}$/.test(h)).map(passKeyOfHash),
  },
  // A store's proposals and agreements: each one's record and every version's text, kept by its id.
  "nl:agree:s:": {
    match: () => true,
    find: async (keys) => {
      const out: string[] = [];
      for (const key of keys) for (const id of await membersOf(key)) if (/^[0-9a-f]{32}$/.test(id)) out.push(...agreementKeys(id));
      return out;
    },
  },
  // A store's published emails: each one's copy, kept by its id.
  "nl:letters:s:": {
    match: () => true,
    find: async (keys) => {
      const out: string[] = [];
      for (const key of keys) for (const id of await membersOf(key)) if (/^[0-9a-f]{20}$/.test(id)) out.push(letterRecordKey(id));
      return out;
    },
  },
  // A store's payment requests: each request's own record, kept by its id.
  "nl:payreq:s:": {
    match: () => true,
    find: async (keys) => {
      const out: string[] = [];
      for (const key of keys) for (const id of await membersOf(key)) if (/^[0-9a-f]{32}$/.test(id)) out.push(requestRecordKey(id));
      return out;
    },
  },
  "nl:pkg:s:": {
    match: () => true,
    find: async (keys) => {
      const checkouts = await unionOf(keys);
      const tokens = await stringsOf(checkouts.map((checkout) => packageKeys(checkout, "")[0]));
      return checkouts.flatMap((checkout, i) => packageKeys(checkout, fieldOf(tokens[i] ?? "", "token")));
    },
  },
};

/** Whether a key found by a follower of `family` is one it may delete: of a family whose rule names `family`. */
export function followable(found: string, family: string): boolean {
  const rule = CLOSING[closingFamilyOf(found)];
  return Boolean(rule && rule.how === "token" && rule.via === family);
}

/** Takes a closing store's members out of one of the company's lists. */
async function pruneIndex(key: string, owners: Owners): Promise<number> {
  const type = await typeOf(key);
  const gone: string[] = [];
  if (type === "set") await scanAll("SSCAN", key, (flat) => void gone.push(...flat.filter((m) => namesStore(m, owners))));
  else if (type === "zset") await scanAll("ZSCAN", key, (flat) => void gone.push(...flat.filter((m, i) => i % 2 === 0 && namesStore(m, owners))));
  else if (type === "hash") await scanAll("HSCAN", key, (flat) => void gone.push(...flat.filter((m, i) => i % 2 === 0 && namesStore(m, owners))));
  // A key Redis says is gone, or of a kind with no members, has none to take out; an unknown kind was refused by typeOf.
  else return 0;
  for (let i = 0; i < gone.length; i += 200) {
    const some = gone.slice(i, i + 200);
    await redisPipeline([[type === "set" ? "SREM" : type === "zset" ? "ZREM" : "HDEL", key, ...some]]);
  }
  return gone.length;
}

/**
 * One run, as the job reports it: `failed` stores whose first step failed in
 * it (each tried again, or parked); `parked` stores whose first step failed
 * PREPARE_TRIES times or more, tried again once every PARKED_GAP_MS; `left`
 * stores the walk did not finish (a key of theirs passed over, or their record
 * not yet gone), walked again with the next walk. Each is said on every run.
 */
export type WalkReport = { started: boolean; stores: number; failed: number; parked: number; left: number; pages: number; deleted: number; pruned: number; finished: number; done: boolean };

/** Who a key the walk could not read held up: the stores it belongs to, and why. */
type Skip = (refs: string[], error: unknown) => void;

/**
 * One page of the walk: deletes what belongs to the closing stores, and
 * takes them out of the company's lists. Answers how many keys it deleted
 * and took members from.
 */
export async function walkPage(keys: string[], batch: Map<string, Batched>, owners: Owners, skip?: Skip): Promise<{ deleted: number; pruned: number }> {
  const doomed = new Set<string>();
  // The keys each follower is handed, by store and family: read together, once the page is sorted.
  const followed = new Map<string, { family: string; owner: string; keys: string[] }>();
  let pruned = 0;
  for (const key of keys) {
    const family = closingFamilyOf(key);
    const rule = family ? CLOSING[family] : null;
    if (!rule) continue;
    if (rule.how === "index") {
      try {
        pruned += await pruneIndex(key, owners);
      } catch (error) {
        // Only once the page has failed PAGE_TRIES runs: every store of the walk may be named in it.
        if (!skip) throw error;
        skip([...owners.byRef.keys()], error);
      }
      continue;
    }
    if (rule.how !== "erase") continue;
    const owner = ownerOfKey(key, rule, owners);
    if (!owner) continue;
    if (FOLLOWERS[family]?.match(key)) {
      const group = followed.get(`${owner}|${family}`) ?? { family, owner, keys: [] };
      group.keys.push(key);
      followed.set(`${owner}|${family}`, group);
    }
    doomed.add(key);
  }
  for (const { family, owner, keys: found } of followed.values()) {
    try {
      for (const key of await FOLLOWERS[family].find(found, batch.get(owner)!)) if (followable(key, family)) doomed.add(key);
    } catch (error) {
      if (!skip) throw error;
      // Its keys are kept for the next walk, which follows them again: deleted now, what they lead to would be lost.
      for (const key of found) doomed.delete(key);
      skip([owner], error);
    }
  }
  await del([...doomed]);
  return { deleted: doomed.size, pruned };
}

/** What the walk needs of one store, as it was written: any other value is refused, never passed over (its store would never be walked). */
function batchedOf(ref: string, raw: string): Batched {
  const value = json(raw);
  const text = (name: string) => typeof value?.[name] === "string";
  const ok = value && value.ref === ref && text("email") && text("sid") && text("name") && text("handle")
    && (value.statsId === null || text("statsId")) && allStrings(value.handles) && allStrings(value.marks)
    && typeof value.endedAt === "number" && Number.isFinite(value.endedAt) && typeof value.at === "number" && Number.isFinite(value.at);
  return ok ? (value as unknown as Batched) : refuse("a store in the walk's batch");
}

async function readBatch(): Promise<Map<string, Batched>> {
  const [flat] = await redisPipeline([["HGETALL", BATCH_KEY]]);
  if (!allStrings(flat) || flat.length % 2 !== 0) refuse("the walk's batch");
  const list = flat as string[];
  const out = new Map<string, Batched>();
  for (let i = 0; i + 1 < list.length; i += 2) out.set(list[i], batchedOf(list[i], list[i + 1]));
  return out;
}

type WalkState = { cursor: string; started: number; phase: "idle" | "walk" | "finish"; pageTries: number; left: number; parked: number; partial: string[] };

/** Where the walk is, exactly, from the whole of its hash: a phase it knows, numbers that are numbers, each absent only when not there. */
function walkStateOf(reply: unknown): WalkState {
  if (!allStrings(reply) || reply.length % 2 !== 0) return refuse("where the walk is");
  const fields = new Map<string, string>();
  for (let i = 0; i < reply.length; i += 2) fields.set(reply[i], reply[i + 1]);
  const number = (name: string) => {
    const raw = fields.get(name);
    if (raw === undefined || raw === "") return 0;
    return /^[0-9]{1,16}$/.test(raw) ? Number(raw) : refuse(`the walk's ${name}`);
  };
  const cursor = fields.get("cursor") || "0";
  if (!CURSOR.test(cursor)) return refuse("the walk's cursor");
  const phase = fields.get("phase") || "idle";
  if (phase !== "idle" && phase !== "walk" && phase !== "finish") return refuse("the walk's phase");
  let parked = 0;
  const partial: string[] = [];
  for (const [name, raw] of fields) {
    if (name.startsWith("tries:")) {
      if (!/^[0-9]{1,9}$/.test(raw)) return refuse("a store's tries");
      if (Number(raw) >= PREPARE_TRIES) parked += 1;
    } else if (name.startsWith("partial:")) partial.push(name.slice("partial:".length));
  }
  return { cursor, phase, started: number("started"), pageTries: number("pagetries"), left: number("left"), parked, partial };
}

/**
 * A store whose first step failed: tried again after WALK_GAP_MS, or, from its
 * PREPARE_TRIES-th failure on, parked: tried again by itself once every
 * PARKED_GAP_MS. Answers whether it is parked. Never puts back a store that is
 * no longer in line (XX).
 */
async function tryLater(ref: string, now: number): Promise<number> {
  const [raw] = await redisPipeline([["HINCRBY", WALK_KEY, triesField(ref), 1]]);
  const tries = countOf(raw, "a store's tries");
  await redisPipeline([["ZADD", DUE_KEY, "XX", now + (tries >= PREPARE_TRIES ? PARKED_GAP_MS : WALK_GAP_MS), ref]]);
  return tries;
}

/**
 * A closing store's record, gone before it is finished (SG2 review, A): when
 * its first step wrote it into the batch and then failed on the way to
 * deleting its record, the record is deleted here, and read back gone. Throws
 * when it is not, so the store is never finished with its record kept.
 */
async function recordGone(entry: Batched): Promise<void> {
  const found = await storeForClosing(entry.ref);
  if (found === "absent") return;
  if (found.sid !== entry.sid) throw new ClosedReadError("a store under a closing store's key is not the one its walk deleted");
  await redisPipeline([["ZREM", FINAL_INDEX, entry.ref]]);
  await closeStoreRecord(found);
  if ((await storeForClosing(entry.ref)) !== "absent") throw new ClosedReadError("a closing store's record is still there after it was deleted");
}

/**
 * A store an owner deleted from their account (lib/store.ts, deleteStore, the
 * only way one of an account's other stores goes outside this walk) while it
 * waited for its walk: its record is gone, so all its walk can know of it is
 * its id. The keys named by it are deleted all the same, and it is finished.
 */
function deletedByItsOwner(ref: string, now: number): Batched | null {
  const sid = /^#([0-9a-f]{32})$/.exec(ref)?.[1];
  return sid ? { ref, email: "", sid, statsId: null, name: "", handle: "", handles: [], marks: [sid], endedAt: now, at: now } : null;
}

/** What the closing job does when a store's records are gone: told by the caller (lib/plan-closing.ts), which writes it down and emails the owner. */
export type Finisher = (entry: Batched, now: number) => Promise<void>;

/**
 * One run: starts a walk when stores are due and none ran in the last
 * WALK_GAP_MS, carries one on to where it stops, and finishes its stores.
 * Bounded by `deadline` and WALK_PAGES_PER_RUN.
 */
export async function eraseClosed(deadline: number, finish: Finisher, now = Date.now()): Promise<WalkReport> {
  const report: WalkReport = { started: false, stores: 0, failed: 0, parked: 0, left: 0, pages: 0, deleted: 0, pruned: 0, finished: 0, done: false };
  if (!isRedisConfigured()) return report;
  // The whole of the walk's hash, one command: where it is, and the stores parked or left, said on every run.
  const [rawState] = await redisPipeline([["HGETALL", WALK_KEY]]);
  const state = walkStateOf(rawState);
  report.parked = state.parked;
  report.left = state.left;
  let phase: string = state.phase;
  let cursor = state.cursor;
  let pageTries = state.pageTries;

  if (phase === "idle") {
    if (now - state.started < WALK_GAP_MS) return { ...report, done: true };
    const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, "-inf", now, "LIMIT", 0, BATCH_MAX]]);
    if (!allStrings(due)) refuse("the stores in line");
    const refs = due as string[];
    // Stores the last walk did not finish are walked again, with or without new ones.
    if (!refs.length && !state.left) return { ...report, done: true };
    for (const ref of refs) {
      if (Date.now() > deadline) break;
      try {
        // SG2, finding 2: only Redis saying exactly that its record is gone, once its walk has it, takes a store out of line.
        const found = await storeForClosing(ref);
        if (found === "absent") {
          const [kept] = await redisPipeline([["HEXISTS", BATCH_KEY, ref]]);
          if (countOf(kept, "a store in the walk's batch") !== 1) {
            const deleted = deletedByItsOwner(ref, now);
            if (!deleted) throw new ClosedReadError("a store's record is gone, and its walk was never prepared");
            console.error("closed-data: a closed store was deleted by its owner before its walk; the keys named by its id are deleted with this walk");
            await redisPipeline([["HSET", BATCH_KEY, ref, JSON.stringify(deleted)]]);
          }
        } else {
          await prepareStore(found, now, async (entry) => void (await redisPipeline([["HSET", BATCH_KEY, ref, JSON.stringify(entry)]])));
          report.stores += 1;
        }
        await redisPipeline([["ZREM", DUE_KEY, ref], ["HDEL", WALK_KEY, triesField(ref)]]);
      } catch (error) {
        report.failed += 1;
        const tries = await tryLater(ref, now);
        // Parked from this try on (one parked before was counted with the walk's state).
        if (tries === PREPARE_TRIES) report.parked += 1;
        console.error(tries >= PREPARE_TRIES
          ? `closed-data: a closed store's first step failed ${PREPARE_TRIES} times or more; it is tried again once a week, and its record is kept until a try succeeds`
          : "closed-data: a closed store's first step failed; it is not taken for deleted, and it is tried again after the next gap", error);
      }
    }
    const [count] = await redisPipeline([["HLEN", BATCH_KEY]]);
    if (!countOf(count, "the walk's batch")) return { ...report, done: true };
    // A new walk: the stores the last one passed a key of over are walked again from the start.
    await redisPipeline([["HSET", WALK_KEY, "phase", "walk", "cursor", "0", "started", now, "pagetries", 0, "left", 0], ...(state.partial.length ? [["HDEL", WALK_KEY, ...state.partial.map((ref) => `partial:${ref}`)]] : [])]);
    state.partial = [];
    phase = "walk";
    cursor = "0";
    pageTries = 0;
    report.started = true;
  }

  const batch = await readBatch();
  const owners = ownersOf([...batch.values()]);
  const partial = new Set(state.partial);
  while (phase === "walk" && Date.now() < deadline && report.pages < WALK_PAGES_PER_RUN) {
    const [reply] = await redisPipeline([["SCAN", cursor, "MATCH", "nl:*", "COUNT", WALK_COUNT]]);
    // SG2, finding 18: a page in another shape stops the run where it was; it is read again next run, never passed over.
    const { cursor: next, items: keys } = pageOf(reply, "a page of the walk");
    // A page that failed PAGE_TRIES runs passes over the keys it cannot read, and says so: one key never holds every store for ever.
    const fresh: string[] = [];
    const skip: Skip | undefined = pageTries >= PAGE_TRIES ? (refs, error) => {
      for (const ref of refs) if (!partial.has(ref)) { partial.add(ref); fresh.push(ref); }
      console.error(`closed-data: a key the walk could not read in ${PAGE_TRIES} runs is passed over; its stores are not finished, and are walked again with the next walk`, error);
    } : undefined;
    let done: { deleted: number; pruned: number };
    try {
      done = await walkPage(keys, batch, owners, skip);
    } catch (error) {
      await redisPipeline([["HINCRBY", WALK_KEY, "pagetries", 1]]);
      throw error;
    }
    if (fresh.length) await redisPipeline([["HSET", WALK_KEY, ...fresh.flatMap((ref) => [`partial:${ref}`, 1])]]);
    report.deleted += done.deleted;
    report.pruned += done.pruned;
    report.pages += 1;
    cursor = next;
    pageTries = 0;
    await redisPipeline([["HSET", WALK_KEY, "cursor", cursor, "pagetries", 0, ...(cursor === "0" ? ["phase", "finish"] : [])]]);
    if (cursor === "0") phase = "finish";
  }

  if (phase === "finish") {
    let left = 0;
    for (const [ref, entry] of batch) {
      if (Date.now() > deadline) return report;
      // A store with a key passed over is not finished: it is walked again with the next walk (never "erased" for a part).
      if (partial.has(ref)) {
        left += 1;
        continue;
      }
      try {
        // Never finished while its record is there (SG2 review, A): deleted here if its first step stopped short of it.
        await recordGone(entry);
        await finish(entry, now);
        // Done: out of the batch, and out of line too, if taking it out after its first step failed (and it was tried again).
        await redisPipeline([["HDEL", BATCH_KEY, ref], ["ZREM", DUE_KEY, ref], ["HDEL", WALK_KEY, triesField(ref)]]);
        report.finished += 1;
      } catch (error) {
        left += 1;
        console.error("closed-data: a closed store could not be finished; it stays in the batch, and is walked again with the next walk", error);
      }
    }
    await redisPipeline([["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "finished", now, "left", left]]);
    report.left = left;
    report.done = true;
  }
  return report;
}

/**
 * Ends every membership and payment plan the store sold, on the creator's
 * own Stripe account, at once (queue item 307 [EC1], part 3): once the store
 * is closed nothing it sold can be reached, so nothing it sold may be
 * charged again, and none goes on to the end of a period it can no longer
 * give. Until 30 October 2026 each was set to end at the end of the period
 * already paid, which let a member be charged in the closing days for a
 * period they would never get. Since the plan ended none of them was charged
 * (lib/closing-holds.ts), and the time a member paid for past the closing day
 * is given back from the creator's account that day (lib/closing-refunds.ts).
 *
 * Stripe's Cancel a subscription (DELETE /v1/subscriptions/:id, read 30
 * October 2026): "Cancels a customer's subscription immediately. The customer
 * won't be charged again"; prorate and invoice_now default to false, so no
 * credit or final invoice is made; its open invoices stop being collected.
 * RENEWALS_AT_ONCE at a time (each was priced with the order that sold it,
 * tests/plan-cost-registry.ts). Bounded by `until`; answers whether every one
 * was reached.
 */
export async function stopRenewals(store: Store, until: number): Promise<{ done: boolean; stopped: number; subs: string[] }> {
  const account = store.stripeAccountId;
  const out = { done: true, stopped: 0, subs: [] as string[] };
  const seen = new Set<string>();
  if (!account) return out;
  // Only what can still charge is searched for (SG2 review, C): an ended one is never read again, so the pages
  // that are read shrink as each is stopped, and years of ended memberships never fill RENEWAL_PAGES.
  for (const [handle, status] of [...saleHandles(store)].flatMap((h) => LIVE.map((st) => [h, st] as const))) {
    let page = "";
    let whole = false;
    for (let round = 0; round < RENEWAL_PAGES; round += 1) {
      if (Date.now() > until) return { ...out, done: false };
      const query = encodeURIComponent(`metadata['store']:'${handle}' AND status:'${status}'`);
      const found = (await onAccount("GET", account, `/subscriptions/search?limit=100&query=${query}${page ? `&page=${encodeURIComponent(page)}` : ""}`)) as Record<string, unknown>;
      // Only Stripe's exact answer is read (CX-123, rule 24): a list, each with its id and status, and a next page whenever there is more.
      if (!found || !Array.isArray(found.data) || typeof found.has_more !== "boolean") throw new ClosedReadError("Stripe's search of a store's renewals answered in an unknown shape");
      if (found.has_more && (typeof found.next_page !== "string" || !found.next_page)) throw new ClosedReadError("Stripe's search said there is more, and gave no page to read it by");
      const toStop: string[] = [];
      for (const sub of found.data as unknown[]) {
        const row = sub && typeof sub === "object" ? (sub as Record<string, unknown>) : {};
        if (typeof row.id !== "string" || !row.id || typeof row.status !== "string") throw new ClosedReadError("a renewal Stripe found answered in an unknown shape");
        // Ended, or found already under another status (the searches may overlap while one changes): not stopped twice.
        if (ENDED.includes(row.status) || seen.has(row.id)) continue;
        seen.add(row.id);
        out.subs.push(row.id);
        toStop.push(row.id);
      }
      for (let i = 0; i < toStop.length; i += RENEWALS_AT_ONCE) {
        if (Date.now() > until) return { ...out, done: false };
        const ended = await Promise.all(toStop.slice(i, i + RENEWALS_AT_ONCE).map(async (id) => {
          const answer = await onAccount("DELETE", account, `/subscriptions/${encodeURIComponent(id)}`, undefined, undefined, `closed-now:${id}`);
          return answer?.id === id && typeof answer.status === "string" && ENDED.includes(answer.status);
        }));
        // Counted only when Stripe says it ended; any other answer is not done, and the closing day is tried again.
        out.stopped += ended.filter(Boolean).length;
        if (ended.includes(false)) out.done = false;
      }
      page = found.has_more ? (found.next_page as string) : "";
      if (!found.has_more) {
        whole = true;
        break;
      }
    }
    // Not read to the end within RENEWAL_PAGES: never said all stopped.
    if (!whole) out.done = false;
  }
  return out;
}

/** A renewal Stripe says can never charge again. */
const ENDED = ["canceled", "incomplete_expired"];
/**
 * Every other status a subscription can have, each searched for on its own:
 * Stripe's search joins clauses with AND or with OR, never both, and a
 * subscription's status is one of its search fields (as lib/closing-buyers.ts
 * searches charges by status). A paused one can resume, an incomplete one can
 * still be paid: both are stopped.
 */
const LIVE = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];
/** The pages of one address's renewals read at the most, a hundred a page. */
const RENEWAL_PAGES = 50;

