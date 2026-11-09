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
 *   nl:closed:due     sorted set  a store's key -> when its records came due (ms)
 *   nl:closed:batch   hash        a store's key -> what the walk needs of it (JSON), while its walk runs
 *   nl:closed:walk    hash        cursor, started, finished
 *
 * Reading the database is the company's, bounded by its schedule: one walk a
 * day at the most, WALK_COUNT keys a command (docs/funded-exposure-review.md).
 * What is done for each store, its deletes in DEL_BATCH keys a command and
 * what its followers read, is priced once for each store, against its own
 * payments (tests/plan-cost-registry.ts, closure), and the renewals it stops
 * with the orders that sold them (ORDER_COST).
 */
import { createHash, randomUUID } from "node:crypto";
import { onAccount } from "@/lib/stripe-account";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, scanPage, stringList } from "@/lib/redis-reply";
import { type Held as LockHeld, LockBusyError, holdLock, releaseLock } from "@/lib/redis-lock";
import { CLOSING, type Closing, closingFamilyOf } from "@/lib/data-families";
import { DEL_BATCH, FOLLOW_BATCH, RENEWALS_AT_ONCE, closesStore } from "@/lib/plan-closing-rules";
import { ENDED_INDEX, standingOf } from "@/lib/plan-standing";
import { SHARING_INDEX } from "@/lib/platform-share";
import { idsIn } from "@/lib/data-recount";
import { readAllListings } from "@/lib/catalog";
import { readCourses } from "@/lib/course";
import { readFlows } from "@/lib/flows";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { RELEASE_QUARANTINE_DAYS, STORE_ID_PATTERN, STRIPE_ACCOUNT_PATTERN, type Store, accountStores, closeStoreRecord, handleLeadsToStore, saleHandles, storeFolder, storeForEmailSeen, storeHandleKey, storeRef } from "@/lib/store";
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
  // A read that fails is never "nothing" (rule 24): its ids would be missed and their keys never erased. It throws,
  // and the walk tries the store again later (eraseClosed), or the closing day holds (lib/plan-closing.ts).
  const listings = await readAllListings(store);
  const flows = store.listId ? await readFlows(store.listId) : [];
  const courseIds = listings.flatMap((l) => (l.course ? [l.course.id] : []));
  const courses = courseIds.length ? [...(await readCourses(courseIds)).values()] : [];
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
  const others = await accountStores(store.email).catch(() => null);
  if (!others) return true;
  return others.some((other) => other.sid !== store.sid && other.stripeAccountId === store.stripeAccountId);
}

/** Puts a store in line for the next walk. */
export async function markDue(ref: string, now = Date.now()): Promise<void> {
  await redisPipeline([["ZADD", DUE_KEY, "NX", now, ref]]);
}

/**
 * Takes a store out of line: its plan was started again before its walk began.
 *
 * Its failure is safe, and nothing retries it (lib/plan-closing.ts, closeOne, swallows it): before a store is prepared
 * the walk reads again whether it is still due (dueForErasure), and a store whose plan runs again leaves the line there
 * with nothing of it touched. That re-check is what keeps a live store, not this call: the way back from Stripe takes a
 * store that re-subscribed out of the line of ended plans at once (lib/store.ts, setSubscription), so the closing job
 * may never look at it again and never call this at all.
 */
export async function unmarkDue(ref: string): Promise<void> {
  await redisPipeline([["ZREM", DUE_KEY, ref]]);
}

/**
 * The closing job's record of a store (lib/plan-closing.ts, stateKey), spelled as it spells it: this file cannot import
 * plan-closing.ts, which imports it. tests/closing-journey.ts drives the real closing job into the real walk, and a
 * store it closed is erased only when the two read the same key.
 */
const closingStateKey = (ref: string) => `nl:plan:closing:${createHash("sha256").update(ref).digest("hex").slice(0, 40)}`;

/**
 * Whether a store whose record is still there is due for erasure now, read exactly (rule 30), just before it is
 * prepared, the walk's first destructive step: "due" when the closing job closed it for the plan ending it has now,
 * "live" when it is not (its plan runs again, or its new ending is not closed yet), "hold" when it cannot be said.
 *
 *   - Its closing day began (FINAL_INDEX: seen through, whatever its plan says since, lib/plan-closing.ts closeOne):
 *     due when the closing job's record says what it kept was removed for that day's ending. A plan that reads
 *     running there contradicts the closing day (a plan paid then is refused and returned, lib/closing-plan-guard.ts):
 *     held, never erased and never taken out of line, since the closing job does not put a store whose record says it
 *     is in line back in it.
 *   - No closing day: due when its plan ended (lib/plan-standing.ts, standingOf, as closeOne reads it), its ending
 *     closes the store (closesStore) and the record says it was removed for that same ending. Otherwise live: a plan
 *     that runs again, or a new ending whose closing is not done, whose store the closing job puts back in line when
 *     it is (its record for a new ending has no `due`, so it marks it again).
 *
 * A read that does not answer, or answers what is not a score or a record, throws UnknownReplyError: the run stops,
 * the store stays in line and nothing of it is touched. Until then the walk asked nothing: a store that re-subscribed
 * and stayed in line (unmarkDue failed, or was never called) was prepared, closed and erased though its plan ran.
 */
async function dueForErasure(store: Store, now: number): Promise<{ due: "due" | "live" | "hold"; score: string | null; closing: string | null }> {
  const ref = storeRef(store);
  const replies = repliesFor(await redisPipeline([["ZSCORE", FINAL_INDEX, ref], ["GET", closingStateKey(ref)]]), 2);
  if (!replies) throw new UnknownReplyError("a closing store's closing day and record (ZSCORE, GET)");
  const [score, raw] = replies;
  if (score !== null && !((typeof score === "string" || typeof score === "number") && String(score).trim() !== "" && Number.isFinite(Number(score)))) {
    throw new UnknownReplyError("a closing store's closing day (ZSCORE)");
  }
  if (raw !== null && typeof raw !== "string") throw new UnknownReplyError("a closing store's record of its closing (GET)");
  let record: Record<string, unknown> = {};
  if (raw !== null) {
    const value = json(raw);
    if (!value || Array.isArray(value)) throw new UnknownReplyError("a closing store's record of its closing (GET)");
    record = value;
  }
  const removedFor = (endedAt: number) => record.of === endedAt && typeof record.removed === "number" && Number.isFinite(record.removed);
  const standing = standingOf(store, now / 1000);
  const seen = (due: "due" | "live" | "hold") => ({ due, score: score === null ? null : String(score), closing: raw as string | null });
  if (score !== null) {
    if (standing === "paid" || standing === "trial") return seen("hold");
    return seen(removedFor(Number(score)) ? "due" : "hold");
  }
  const endedAt = Date.parse(store.planEndedAt);
  if (standing !== "ended" || !Number.isFinite(endedAt)) return seen("live");
  return seen(closesStore(endedAt) && removedFor(endedAt) ? "due" : "live");
}

/**
 * A store's record and its lock (lib/store.ts, ownerKey and lockKeyOf), spelled as lib/store.ts spells them: it does
 * not export them. tests/m-reactivation-during-check.proof.ts and tests/erase-race-final-check.test.ts change a store
 * with the real setSubscription and claimHandle around the walk, and fail if the spellings ever differ.
 */
const ownerKeyOf = (ref: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${ref.toLowerCase()}`).digest("hex").slice(0, 40)}`;
const lockKeyOf = (owner: string) => owner.replace("nl:store:owner:", "nl:store:lock:");

/** How long the walk holds a closing store's lock at a time; made to last as long again before each step that deletes. */
export const CLOSING_LOCK_SECONDS = 120;
/** How many times the walk reads a store in line again when its record or its closing changed after its check. */
export const TAKE_ATTEMPTS = 3;

/**
 * The store's lock taken for the walk only while its record, the closing job's record and its closing day are exactly
 * what the walk's check read (KEYS: record, lock, closing record, FINAL_INDEX; ARGV: the record read, whether the
 * closing record was there and what it was, whether the closing day was there and what it was, the store's key, the
 * walk's token, the lock's seconds). 1 taken; 0 something changed, nothing taken; -1 another write holds the lock.
 */
const CLOSING_TAKE = `-- marktmorgen:closing-take:v1
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
local closing = redis.call("GET", KEYS[3])
if ARGV[2] == "1" then
  if closing ~= ARGV[3] then return 0 end
elseif closing then
  return 0
end
local score = redis.call("ZSCORE", KEYS[4], ARGV[6])
if ARGV[4] == "1" then
  if not score or tonumber(score) ~= tonumber(ARGV[5]) then return 0 end
elseif score then
  return 0
end
if not redis.call("SET", KEYS[2], ARGV[7], "NX", "EX", ARGV[8]) then return -1 end
return 1`;

type Taken = { due: "gone" | "live" | "hold" } | { due: "due"; store: Store; held: LockHeld };

/**
 * Whether a store in line is due now (dueForErasure), and when it is, the store's own lock (lib/store.ts) taken for
 * the walk in the same step as the walk sees that nothing its check read has changed (CLOSING_TAKE, rule 30, Codex M
 * on #3156): every write to a store's record is made under that lock and only while it holds it (lib/store.ts,
 * withStore, setIfHeld), so from then on no plan can start the store again while the walk prepares it, and once
 * prepared its record is closed and no plan can reach it (lib/closing-plan-guard.ts). A record or a closing that
 * changed after the check (a plan started again while the check waited on its reads) is read and checked again, at
 * most TAKE_ATTEMPTS times; a lock another write holds keeps the store in line for the next run, untouched. Until
 * then the check and the first delete were separate steps: a store whose plan ran again while the check waited was
 * prepared from what was read before, closed and erased with its contacts.
 *
 * "gone" when no store is kept under the key, as before. A read that does not answer throws UnknownReplyError: the
 * run stops and the store stays in line untouched.
 */
async function takeDue(ref: string, now: number): Promise<Taken> {
  for (let attempt = 0; attempt < TAKE_ATTEMPTS; attempt += 1) {
    let reply: unknown;
    const store = await storeForEmailSeen(ref, (_, answer) => void (reply = answer));
    const read = repliesFor(reply, 1);
    if (!read) throw new UnknownReplyError("a closing store's record (GET)");
    if (!store || typeof read[0] !== "string") return { due: "gone" };
    const seen = await dueForErasure(store, now);
    if (seen.due !== "due") return { due: seen.due };
    const owner = ownerKeyOf(ref);
    const id = storeRef(store);
    const held: LockHeld = { key: lockKeyOf(owner), token: randomUUID(), ttlSeconds: CLOSING_LOCK_SECONDS };
    const replies = repliesFor(await redisPipeline([[
      "EVAL", CLOSING_TAKE, 4, owner, held.key, closingStateKey(id), FINAL_INDEX,
      read[0], seen.closing === null ? "0" : "1", seen.closing ?? "", seen.score === null ? "0" : "1", seen.score ?? "", id, held.token, CLOSING_LOCK_SECONDS,
    ]]), 1);
    const answer = replies?.[0];
    if (answer === 1) return { due: "due", store, held };
    if (answer === -1) return { due: "hold" };
    if (answer !== 0) throw new UnknownReplyError("whether a closing store is as its check read it (EVAL)");
  }
  return { due: "hold" };
}

/**
 * A closing store's deletes, made only while the walk still holds the store's lock, read in the same step (Codex M's
 * focal M1 on #3156). KEYS: the lock, then the keys changed. ARGV: the walk's token, then each change as its word, the
 * place of its key in KEYS and how many words of it follow: DEL (none), SREM, ZREM or HDEL (its members), SETEX (the
 * value and its seconds). Every change is read before any is made. 1 done; 0 the lock is not the walk's any more,
 * nothing done; -1 a change it does not make, nothing done.
 */
const CLOSING_FENCED = `-- marktmorgen:closing-fenced:v1
local i, plan = 2, {}
while i <= #ARGV do
  local op, at, n = ARGV[i], tonumber(ARGV[i + 1]), tonumber(ARGV[i + 2])
  if not at or not n or at < 2 or at > #KEYS or n < 0 or i + 2 + n > #ARGV then return -1 end
  if op == "DEL" then
    if n ~= 0 then return -1 end
  elseif op == "SREM" or op == "ZREM" or op == "HDEL" then
    if n < 1 then return -1 end
  elseif op == "SETEX" then
    if n ~= 2 or not tonumber(ARGV[i + 4]) then return -1 end
  elseif op == "HSET" then
    if n ~= 2 then return -1 end
  else
    return -1
  end
  plan[#plan + 1] = {op, at, i + 3, n}
  i = i + 3 + n
end
if #plan == 0 then return -1 end
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
for _, step in ipairs(plan) do
  local op, key, from, n = step[1], KEYS[step[2]], step[3], step[4]
  if op == "DEL" then
    redis.call("DEL", key)
  elseif op == "SETEX" then
    redis.call("SET", key, ARGV[from], "EX", ARGV[from + 1])
  elseif op == "HSET" then
    redis.call("HSET", key, ARGV[from], ARGV[from + 1])
  else
    for j = from, from + n - 1, 500 do
      redis.call(op, key, unpack(ARGV, j, math.min(j + 499, from + n - 1)))
    end
  end
end
return 1`;

/** The most keys, and the most words beside them, one CLOSING_FENCED step carries. */
const FENCED_KEYS = 1000;
const FENCED_WORDS = 4000;

type Command = (string | number)[];
/** Sends a closing store's changes: a pipeline, or the same changes made only while the walk holds the lock (fencedBy). */
type Apply = (commands: Command[]) => Promise<unknown>;

/**
 * The way a step of the preparation sends its deletes: with `held`, only while the store's lock is still the walk's,
 * read in the same step (CLOSING_FENCED), and a lock that is not the walk's any more stops the preparation with
 * LockBusyError, nothing of that step changed. Until then a step renewed the lock (keep) and then deleted through a
 * pipeline of its own, unchecked: a lock that ran out between the two (a paused function, a slow network) let the plan
 * start again in that moment, and the delete still landed on the store that runs again (its team, its keys, its
 * hooks, its record). Without `held` (a test's preparation of its own), the pipeline, as before.
 *
 * Only what a closing store's steps send is made: DEL of keys, SREM, ZREM and HDEL of members, SET with EX. Anything
 * else is a mistake in this file and throws before anything is sent.
 */
export function fencedBy(held: LockHeld | undefined): Apply {
  if (!held) return redisPipeline;
  return async (commands) => {
    type Change = { op: string; key: string; words: string[] };
    const changes: Change[] = [];
    for (const command of commands) {
      const [word, ...rest] = command.map(String);
      if (word === "DEL" && rest.length) for (const key of rest) changes.push({ op: "DEL", key, words: [] });
      else if ((word === "SREM" || word === "ZREM" || word === "HDEL") && rest.length >= 2) {
        for (let i = 1; i < rest.length; i += 500) changes.push({ op: word, key: rest[0], words: rest.slice(i, i + 500) });
      } else if (word === "SET" && rest.length === 4 && rest[2].toUpperCase() === "EX") changes.push({ op: "SETEX", key: rest[0], words: [rest[1], rest[3]] });
      // One field of a hash: the walk's entry, written in the same step as the record it outlives (prepareStore).
      else if (word === "HSET" && rest.length === 3) changes.push({ op: "HSET", key: rest[0], words: [rest[1], rest[2]] });
      else throw new Error(`not a closing store's change: ${word}`);
    }
    for (let at = 0; at < changes.length; ) {
      const keys: string[] = [];
      const place = new Map<string, number>();
      const argv: string[] = [];
      while (at < changes.length) {
        const { op, key, words } = changes[at];
        const fresh = !place.has(key);
        if (argv.length && ((fresh && keys.length >= FENCED_KEYS) || argv.length + 3 + words.length > FENCED_WORDS)) break;
        if (fresh) {
          keys.push(key);
          place.set(key, keys.length + 1);
        }
        argv.push(op, String(place.get(key)), String(words.length), ...words);
        at += 1;
      }
      const replies = repliesFor(await redisPipeline([["EVAL", CLOSING_FENCED, 1 + keys.length, held.key, ...keys, held.token, ...argv]]), 1);
      const answer = replies?.[0];
      if (answer === 0) throw new LockBusyError("a closing store's lock ran out before its deletes");
      if (answer !== 1) throw new UnknownReplyError("a closing store's deletes, made only while the walk holds its lock (EVAL)");
    }
    return [];
  };
}

/**
 * What closing a store's record changes (lib/store.ts, closeStoreRecord), spelled as lib/store.ts spells it, so the
 * walk can make it only while it holds the store's lock (fencedBy): its addresses held back from anyone else for
 * RELEASE_QUARANTINE_DAYS, its record and its copy from before a move, its id, its place among its account's stores,
 * in the line of ended plans and among the stores that share. tests/erase-lock-fence.test.ts closes one store with
 * the real closeStoreRecord and an identical one with these, and fails if what is left ever differs.
 */
export function closingRecordChanges(store: Store, now = Date.now()): Command[] {
  const ref = storeRef(store);
  const owner = ownerKeyOf(ref);
  const released = `released:${new Date(now).toISOString()}`;
  return [
    ...[store.handle, ...store.previousHandles].map((handle) => ["SET", storeHandleKey(handle), released, "EX", RELEASE_QUARANTINE_DAYS * 24 * 60 * 60]),
    ["DEL", owner, owner.replace("nl:store:owner:", "nl:store:before-catalog:")],
    ...(STORE_ID_PATTERN.test(store.sid) ? [["DEL", `nl:store:id:${store.sid}`], ["SREM", accountStoresKey(store.email), store.sid]] : []),
    ["ZREM", ENDED_INDEX, ref],
    ["SREM", SHARING_INDEX, ref],
  ];
}

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

async function del(keys: string[], apply: Apply = redisPipeline): Promise<void> {
  for (let i = 0; i < keys.length; i += DEL_BATCH) await apply([["DEL", ...keys.slice(i, i + DEL_BATCH)]]);
}

/**
 * The first step for one store, while its record can still be read: what
 * is found only through it, and then the record. Answers what the walk
 * needs of it. Safe to run again.
 *
 * With `held`, the store's lock the walk took when it saw the store still due (takeDue): before each step that
 * deletes, it is made to last another CLOSING_LOCK_SECONDS, only while it is still the walk's (lib/redis-lock.ts,
 * holdLock), and every delete of every step is made only while the lock is still the walk's, read in the same step
 * (fencedBy, Codex M's focal M1 on #3156): a lock that ran out stops the preparation with LockBusyError before
 * anything more is deleted, the store's record still there and the store still in line, though it ran out after the
 * renewal. Not fenced: the outboxes of shipment and order-confirmation mail (lib/shipment-mail-outbox.ts,
 * lib/order-confirmation-outbox.ts), each with fences of its own, which delete nothing while their mail is never
 * activated (CURRENT_SHIPMENT_MAIL_LIFECYCLE).
 */
export async function prepareStore(store: Store, now = Date.now(), held?: LockHeld): Promise<Batched> {
  const keep = async () => {
    if (held && !(await holdLock(held))) throw new LockBusyError("a closing store's lock ran out while it was prepared");
  };
  const apply = fencedBy(held);
  const ref = storeRef(store);
  const { marks } = await marksOf(store);
  const extra: string[] = [];
  // Its calendar hosts' claims, which are kept by the host, across the stores they serve.
  // Read whole or not at all: a team not read is never "no teammates" (rule 24); it throws, and the walk waits.
  const team = store.sid ? await readTeam(store.sid) : { members: [], invites: [] };
  const own = new Set(marks);
  for (const host of [store.email, ...team.members.map((m) => m.email)].map(hostId)) {
    let cursor = "0";
    let kept = false;
    for (let round = 0; round < 50; round += 1) {
      const [reply] = await redisPipeline([["HSCAN", claimsKey(host), cursor, "COUNT", 500]]);
      const [next, flat] = Array.isArray(reply) ? [String(reply[0]), (reply[1] as unknown[]).map(String)] : ["0", []];
      const mine: string[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) if (pieces(flat[i + 1]).some((part) => own.has(part))) mine.push(flat[i]);
      if (mine.length) {
        // Once for a host's claims, fifty pages at the most, before the first of them goes.
        if (!kept) await keep();
        kept = true;
        await apply([["HDEL", claimsKey(host), ...mine]]);
      }
      cursor = next;
      if (cursor === "0") break;
    }
  }
  // A host's own calendar is the host's, across the stores they serve: it goes with the last of them. A read
  // that fails is never "no other store" (rule 24): it throws, and the walk tries this store again later.
  for (const email of [store.email, ...team.members.map((m) => m.email)]) {
    const elsewhere = (await memberStores(email)).some((m) => m.store.sid !== store.sid)
      || (await accountStores(email)).some((other) => other.sid !== store.sid);
    if (!elsewhere) extra.push(...hostCalendarKeys(hostId(email)));
  }
  await keep();
  await dropTeam(store, apply);
  if (store.sid) await revokeAllKeys(store.sid, apply);
  await forgetStoreWebhooks(store.statsId, apply);
  await forgetStoreSync(store.statsId, apply);
  await forgetShipmentMail(store.statsId);
  await forgetOrderConfirmationMail(store.statsId);
  await forgetStorePhones(store.statsId, apply);
  // The owner's path: their answers and the days they showed up (lib/path.ts).
  await forgetPath(store, held);
  if (store.domain?.name) extra.push(domainKey(store.domain.name));
  await keep();
  await del(extra, apply);
  // Out of the closing day's line before its record goes (queue item 307 [EC1]): a new store its owner opens
  // under the same key is never taken for this one. A plan paid under this store's addresses after this is
  // still found by their mark (lib/closing-plan-guard.ts, markShut).
  await apply([["ZREM", FINAL_INDEX, ref]]);
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
  // The walk's entry is written before the record goes: once the record is gone, only this entry names the store's
  // keys (#3181). Under the walk's lock both go in one CLOSING_FENCED step, the entry first, so neither is made
  // without the other while the lock holds, and neither once it ran out (the store may then run again): fencedBy
  // throws LockBusyError on 0 and UnknownReplyError on any answer but 1. Without a lock, only HSET's own count (0 for
  // an entry rewritten, 1 for a new one) is a write; any other answer is not known to have landed and throws before
  // the record goes (Codex T on #3181).
  await keep();
  if (held) {
    await apply([["HSET", BATCH_KEY, ref, JSON.stringify(entry)], ...closingRecordChanges(store)]);
    return entry;
  }
  const written = repliesFor(await redisPipeline([["HSET", BATCH_KEY, ref, JSON.stringify(entry)]]), 1)?.[0];
  if (written !== 0 && written !== 1) throw new Error("the closing store's walk entry was not confirmed written");
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

/**
 * The address a key of a family named by address is named by: what follows the family's name, whole. Until then any
 * part of the key that was a closing store's address matched, so a store whose address is "weekly" took every store's
 * nl:weekly:to: key with it.
 */
const addressOf = (key: string) => key.slice(closingFamilyOf(key).length);

/** The closing store a key belongs to, if any: by an id in its name, or, for a family named by address, by its address. */
export function ownerOfKey(key: string, rule: Closing, owners: Owners): string | null {
  if (rule.how === "erase" && rule.by === "handle") return owners.byHandle.get(addressOf(key)) ?? null;
  for (const part of pieces(key)) {
    if (owners.byMark.has(part)) return owners.byMark.get(part)!;
    if (owners.byRef.has(part)) return owners.byRef.get(part)!;
  }
  return null;
}

/**
 * An id of a closing store that a live store may hold now (rule 30): its key, when it is its owner's address (an
 * account's first store), and the folder derived from it (storeFolder), which a first store its owner opens again
 * under the same address has too (lib/store.ts, claimHandle, once the closed store's record is gone); an address it
 * let go of or held, which another store may claim once its month on the shelf is over; its Stripe account, which
 * another store of its owner may sell through since it was prepared. A key or a list's member named only by such an
 * id is not proven to be the closing store's: it goes only when no live store holds the id, read exactly at the page
 * that would delete it. Until then the walk deleted them whoever held them: a first store opened again while its
 * walk ran lost its pause, its place in the pauses' line and its folder's records, a store that claimed an address a
 * closed store had let go of lost its weekly team, and a store that connected the closed one's account lost its
 * account's records.
 */
type Held = { kind: "key" | "address" | "account"; id: string; email: string };

/** The ids of the batch's stores a live store may hold, and whether one does. */
type Reuse = { held: Map<string, Held>; live: (held: Held, page: Map<string, boolean>) => Promise<boolean> };

/** A key of a family named by ids, or a member of a list, and what it is named by: an id proven the closing store's (no `held`), or one a live store may hold. */
type Claim = { owner: string; held: Held | null };

function claimOf(text: string, owners: Owners, reuse: Reuse, whole: boolean): Claim | null {
  let first: Claim | null = null;
  for (const part of whole ? [text, ...pieces(text)] : pieces(text)) {
    const owner = owners.byMark.get(part) ?? owners.byRef.get(part);
    if (!owner) continue;
    const held = reuse.held.get(part) ?? null;
    if (!held) return { owner, held: null };
    first ??= { owner, held };
  }
  return first;
}

/** The store kept under a key, read exactly: a reply that does not read, or a record there that does not read as a store of this key, throws. */
async function storeUnder(ref: string, what: string): Promise<Store | null> {
  let reply: unknown;
  const store = await storeForEmailSeen(ref, (_, answer) => void (reply = answer));
  const read = repliesFor(reply, 1);
  if (!read || (read[0] !== null && (typeof read[0] !== "string" || !store))) throw new UnknownReplyError(what);
  return store;
}

/** Whether a store holds this address now, read exactly: nil or a released mark is nobody's (handleLeadsToStore); any other string is a store's; anything else throws. */
async function addressHeld(handle: string): Promise<boolean> {
  const replies = repliesFor(await redisPipeline([["GET", storeHandleKey(handle)]]), 1);
  const raw = replies?.[0];
  if (!replies || (raw !== null && typeof raw !== "string")) throw new UnknownReplyError("whether a live store holds a closing store's address (GET)");
  return handleLeadsToStore(raw);
}

/**
 * The set of an account's other stores (lib/store.ts, accountKey), spelled as it spells it: lib/store.ts does not
 * export it, and its accountStores reads a reply that does not read as no store. tests/erase-cross-store.test.ts
 * connects the account from an owner's other store made with the real createStore, and fails if the two ever differ.
 */
const accountStoresKey = (email: string) =>
  `nl:account:stores:${createHash("sha256").update(`nimbus-account-stores:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;

/** Whether a store of this owner sells through this Stripe account now, read exactly: its first store and every other store of its account. */
async function accountHeld(email: string, account: string): Promise<boolean> {
  const first = await storeUnder(email, "whether the owner's first store sells through a closing store's account (GET)");
  if (first?.stripeAccountId === account) return true;
  const replies = repliesFor(await redisPipeline([["SMEMBERS", accountStoresKey(email)]]), 1);
  const ids = replies?.[0];
  if (!replies || !Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new UnknownReplyError("the owner's other stores (SMEMBERS)");
  for (const id of ids as string[]) {
    if (!STORE_ID_PATTERN.test(id)) continue;
    const other = await storeUnder(`#${id}`, "whether the owner's other store sells through a closing store's account (GET)");
    if (other && other.email.toLowerCase() === email.toLowerCase() && other.stripeAccountId === account) return true;
  }
  return false;
}

/**
 * What the batch's stores' ids a live store may hold are, for one run. A live store found holding one is kept for the
 * rest of the run (keeping is never wrong); one found holding none is read again at the next page that needs it, so a
 * store opened while the run goes on is seen. A page reads each id at most once, and only when it has a key or a member
 * named by it alone: the reads are bounded by the keys the walk would delete for the store (tests/plan-cost-registry.ts,
 * closure, deletes).
 */
async function reuseOf(batch: Map<string, Batched>): Promise<Reuse> {
  const held = new Map<string, Held>();
  for (const entry of batch.values()) {
    if (entry.ref === entry.email) {
      const key: Held = { kind: "key", id: entry.ref, email: entry.email };
      held.set(entry.ref, key);
      held.set(await storeFolder(entry.ref), key);
    }
    for (const handle of entry.handles) held.set(handle, { kind: "address", id: handle, email: entry.email });
    for (const mark of entry.marks) if (STRIPE_ACCOUNT_PATTERN.test(mark)) held.set(mark, { kind: "account", id: mark, email: entry.email });
  }
  const liveForRun = new Set<string>();
  return {
    held,
    live: async (one, page) => {
      const tag = `${one.kind}|${one.id}|${one.email}`;
      if (liveForRun.has(tag)) return true;
      if (page.has(tag)) return page.get(tag)!;
      const yes = one.kind === "key" ? (await storeUnder(one.id, "whether a live store holds a closing store's key (GET)")) !== null
        : one.kind === "address" ? await addressHeld(one.id)
        : await accountHeld(one.email, one.id);
      page.set(tag, yes);
      if (yes) liveForRun.add(tag);
      return yes;
    },
  };
}

/**
 * What the walk deletes of what an id a live store may hold names, done only while no live store holds it, read in
 * the same step (rule 30, Codex M on #3156). KEYS: what says who holds the id (`checks` of them), then what changes.
 * ARGV: the id's kind, `checks`, the Stripe account (its kind "account"), the account's other stores as the walk read
 * them (`known` of them), then the change: DEL, which deletes every key after the checks in one command, or SREM, ZREM
 * or HDEL, which take the members that follow out of the one key after the checks in one command.
 *
 *   - "key", a store's key (an account's first store): held while a record is kept under it (KEYS[1]), whatever it holds.
 *   - "address": held while its key (KEYS[1]) leads to a store, as handleLeadsToStore (lib/store.ts) reads it.
 *   - "account": held while the owner's first store (KEYS[1]) or one of their other stores (KEYS[3...]) sells through
 *     it; the set of their other stores (KEYS[2]) must be exactly the one read, or -2 and nothing is done.
 *
 * 1 done; 0 held, nothing done; -1 a change it does not make or a record that does not read; -2 the owner's stores
 * changed since they were read. A key of another type than its check reads makes the script fail, and nothing is done.
 */
const CLOSING_UNHELD = `-- marktmorgen:closing-unheld:v1
local kind, checks, known = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[4])
local op = ARGV[5 + known]
if not ((op == "DEL" and #KEYS > checks) or ((op == "SREM" or op == "ZREM" or op == "HDEL") and #KEYS == checks + 1 and #ARGV > 5 + known)) then return -1 end
if kind == "key" then
  if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
elseif kind == "address" then
  local holder = redis.call("GET", KEYS[1])
  if holder and holder ~= "" and string.sub(holder, 1, 9) ~= "released:" then return 0 end
elseif kind == "account" then
  if redis.call("SCARD", KEYS[2]) ~= known then return -2 end
  for i = 1, known do
    if redis.call("SISMEMBER", KEYS[2], ARGV[4 + i]) ~= 1 then return -2 end
  end
  local held = false
  for i = 1, checks do
    if i ~= 2 then
      local raw = redis.call("GET", KEYS[i])
      if raw then
        local ok, record = pcall(cjson.decode, raw)
        if not ok or type(record) ~= "table" then return -1 end
        if record.stripeAccountId == ARGV[3] then held = true end
      end
    end
  end
  if held then return 0 end
else
  return -1
end
if op == "DEL" then
  redis.call("DEL", unpack(KEYS, checks + 1))
else
  redis.call(op, KEYS[checks + 1], unpack(ARGV, 6 + known))
end
return 1`;

/** What CLOSING_UNHELD changes: keys deleted, or members taken out of one list. */
type Unheld = { op: "DEL"; keys: string[] } | { op: "SREM" | "ZREM" | "HDEL"; key: string; members: string[] };

/**
 * Makes `change` only while no live store holds `one`, read in the same step (CLOSING_UNHELD): answers whether it
 * was made. Until then a key or a member named by such an id went once a read had found nobody holding it, a step
 * before: a first store its owner opened in between lost its pause, its last pause and its folder's owner. The
 * owner's other stores are read first for an account, and a set that changed since stops the run with nothing done,
 * as a record that does not read does: the page is read again at the next run.
 */
async function unlessHeld(one: Held, change: Unheld): Promise<boolean> {
  if (change.op === "DEL" ? !change.keys.length : !change.members.length) return true;
  let checks: string[];
  let known: string[] = [];
  if (one.kind === "key") checks = [ownerKeyOf(one.id)];
  else if (one.kind === "address") checks = [storeHandleKey(one.id)];
  else {
    const replies = repliesFor(await redisPipeline([["SMEMBERS", accountStoresKey(one.email)]]), 1);
    const ids = replies?.[0];
    if (!replies || !Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new UnknownReplyError("the owner's other stores (SMEMBERS)");
    known = ids as string[];
    checks = [ownerKeyOf(one.email), accountStoresKey(one.email), ...known.filter((id) => STORE_ID_PATTERN.test(id)).map((id) => ownerKeyOf(`#${id}`))];
  }
  const targets = change.op === "DEL" ? change.keys : [change.key];
  const replies = repliesFor(await redisPipeline([[
    "EVAL", CLOSING_UNHELD, checks.length + targets.length, ...checks, ...targets,
    one.kind, checks.length, one.kind === "account" ? one.id : "", known.length, ...known, change.op, ...(change.op === "DEL" ? [] : change.members),
  ]]), 1);
  const answer = replies?.[0];
  if (answer === 1) return true;
  if (answer === 0) return false;
  throw new UnknownReplyError("whether a live store holds a closing store's id, with what it names (EVAL)");
}

/** Keys named by `one` deleted DEL_BATCH at a step, each step only while no live store holds it: answers how many went. */
async function deleteUnheld(one: Held, keys: string[]): Promise<number> {
  let gone = 0;
  for (let i = 0; i < keys.length; i += DEL_BATCH) {
    const some = keys.slice(i, i + DEL_BATCH);
    if (!(await unlessHeld(one, { op: "DEL", keys: some }))) break;
    gone += some.length;
  }
  return gone;
}

const heldTag = (one: Held) => `${one.kind}|${one.id}|${one.email}`;

/** A reuse with no ids a live store may hold: every claim is proven, as the walk read them before. */
const NO_REUSE: Reuse = { held: new Map(), live: async () => false };

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

/** The most pages one walk of a key's members reads (a thousand asked for a page); a walk not at its end by then is unknown. */
const MEMBER_PAGES = 10_000;
/** The most members one key's walk reads, whatever its kind: a list not at its end by then is unknown too. */
const MEMBERS_MAX = MEMBER_PAGES * 1_000;
/** Members of a list one LRANGE reads, as the walk always read a list in one command. */
const LIST_PAGE = 10_000;
/** What TYPE answers (Redis's TYPE): any other reply is not a kind of key. */
const KINDS: ReadonlySet<string> = new Set(["none", "string", "list", "set", "zset", "hash", "stream", "vectorset"]);

/**
 * Every member of one key, a page at a time. A page that does not read, or a walk not at its end after
 * MEMBER_PAGES, throws UnknownReplyError (rules 24 and 30, review of #2921): never "no more members", so the walk's
 * page is not deleted, its cursor is not moved on, its stores are not finished, and the next run reads it again.
 * Until then a short walk here left a closing store's members and followed keys behind while the store was
 * reported erased.
 */
async function scanAll(command: "HSCAN" | "SSCAN" | "ZSCAN", key: string, each: (flat: string[]) => Promise<void> | void): Promise<void> {
  let cursor = "0";
  for (let round = 0; round < MEMBER_PAGES; round += 1) {
    const page = scanPage(await redisPipeline([[command, key, cursor, "COUNT", 1000]]));
    // A hash or a sorted set answers pairs (field and value, member and score): an odd page is not one.
    if (!page || (command !== "SSCAN" && page.items.length % 2 !== 0)) throw new UnknownReplyError(`the closing walk's ${command} of a key`);
    cursor = page.next;
    await each(page.items);
    if (cursor === "0") return;
  }
  throw new UnknownReplyError(`the closing walk's ${command} of a key, not at its end after ${MEMBER_PAGES} pages,`);
}

const json = (raw: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const fieldOf = (raw: string, name: string): string => {
  const value = json(raw)?.[name];
  return typeof value === "string" ? value : "";
};
/*
 * The reads below are exact too (rule 30, Claude 2's review of #3134, M1): a reply in another shape, a pipeline with
 * more or fewer replies than commands, or a list not at its end at MEMBERS_MAX throws UnknownReplyError, so the walk's
 * page is not deleted, its cursor is not moved on and its stores are not finished. Until then each read an unknown
 * reply as empty: a key of no kind, no members, no values, a list cut at 10,000, and the walk passed over what they
 * lead to while a later run reported the store erased and emailed its owner.
 */
async function typeOf(key: string): Promise<string> {
  const type = repliesFor(await redisPipeline([["TYPE", key]]), 1)?.[0];
  if (typeof type !== "string" || !KINDS.has(type)) throw new UnknownReplyError("the closing walk's TYPE of a key");
  return type;
}
/** Every member of a list, LIST_PAGE at a command, to its end. */
async function listAll(key: string): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; from < MEMBERS_MAX; from += LIST_PAGE) {
    const items = stringList(repliesFor(await redisPipeline([["LRANGE", key, from, from + LIST_PAGE - 1]]), 1)?.[0]);
    if (!items || items.length > LIST_PAGE) throw new UnknownReplyError("the closing walk's LRANGE of a list");
    out.push(...items);
    if (items.length < LIST_PAGE) return out;
  }
  throw new UnknownReplyError(`the closing walk's LRANGE of a list, not at its end after ${MEMBERS_MAX} members,`);
}
async function membersOf(key: string): Promise<string[]> {
  const type = await typeOf(key);
  const out: string[] = [];
  if (type === "set") await scanAll("SSCAN", key, (flat) => void out.push(...flat));
  else if (type === "zset") await scanAll("ZSCAN", key, (flat) => void out.push(...flat.filter((_, i) => i % 2 === 0)));
  else if (type === "list") out.push(...(await listAll(key)));
  else if (type === "hash") await scanAll("HSCAN", key, (flat) => void out.push(...flat.filter((_, i) => i % 2 === 0)));
  return out;
}
/** String keys' values, READ_BATCH at a command; "" for a key that is gone or of another kind (MGET's null), which no follower reads as one. */
async function stringsOf(keys: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < keys.length; i += READ_BATCH) {
    const some = keys.slice(i, i + READ_BATCH);
    // One value for each key asked, each a string or null: anything else is not MGET's answer.
    const values = repliesFor(repliesFor(await redisPipeline([["MGET", ...some]]), 1)?.[0], some.length);
    if (!values || values.some((value) => value !== null && typeof value !== "string")) throw new UnknownReplyError("the closing walk's MGET of a family's keys");
    for (const value of values) out.push(typeof value === "string" ? value : "");
  }
  return out;
}
/** Every member of these sets, READ_BATCH at a command; when the command is refused (a key of another kind), each key is read on its own, by its kind. */
async function unionOf(keys: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += READ_BATCH) {
    const some = keys.slice(i, i + READ_BATCH);
    let replies: unknown;
    try {
      replies = await redisPipeline([["SUNION", ...some]]);
    } catch {
      for (const key of some) for (const member of await membersOf(key)) out.add(member);
      continue;
    }
    const members = stringList(repliesFor(replies, 1)?.[0]);
    if (!members) throw new UnknownReplyError("the closing walk's SUNION of a family's keys");
    for (const member of members) out.add(member);
  }
  return [...out];
}
async function hashValues(key: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
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
          const token = parseContact(raw)?.t;
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
    find: async (keys) => (await stringsOf(keys)).flatMap((raw) => (raw ? calendarKeys(json(raw)) : [])),
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

/**
 * Takes a closing store's members out of one of the company's lists: a member named by an id a live store may hold
 * goes only when none holds it (claimOf, reuse), read before anything of the list is taken.
 */
async function pruneIndex(key: string, owners: Owners, reuse: Reuse, page: Map<string, boolean>): Promise<number> {
  const type = await typeOf(key);
  const claimed: [string, Claim][] = [];
  const take = (members: string[]) => {
    for (const member of members) {
      const claim = claimOf(member, owners, reuse, true);
      if (claim) claimed.push([member, claim]);
    }
  };
  if (type === "set") await scanAll("SSCAN", key, (flat) => take(flat));
  else if (type === "zset") await scanAll("ZSCAN", key, (flat) => take(flat.filter((_, i) => i % 2 === 0)));
  else if (type === "hash") await scanAll("HSCAN", key, (flat) => take(flat.filter((_, i) => i % 2 === 0)));
  else return 0;
  const op = type === "set" ? "SREM" : type === "zset" ? "ZREM" : "HDEL";
  const gone: string[] = [];
  // A member named by an id a live store may hold is taken out only in the same step as no store is seen holding it (unlessHeld).
  const guarded = new Map<string, { held: Held; members: string[] }>();
  for (const [member, claim] of claimed) {
    if (!claim.held) gone.push(member);
    else if (!(await reuse.live(claim.held, page))) {
      const group = guarded.get(heldTag(claim.held)) ?? { held: claim.held, members: [] };
      group.members.push(member);
      guarded.set(heldTag(claim.held), group);
    }
  }
  for (let i = 0; i < gone.length; i += 200) {
    const some = gone.slice(i, i + 200);
    await redisPipeline([[op, key, ...some]]);
  }
  let taken = gone.length;
  for (const { held, members } of guarded.values()) {
    for (let i = 0; i < members.length; i += 200) {
      const some = members.slice(i, i + 200);
      if (!(await unlessHeld(held, { op, key, members: some }))) break;
      taken += some.length;
    }
  }
  return taken;
}

export type WalkReport = { started: boolean; stores: number; pages: number; deleted: number; pruned: number; finished: number; done: boolean };

/**
 * One page of the walk: deletes what belongs to the closing stores, and
 * takes them out of the company's lists. Answers how many keys it deleted
 * and took members from.
 */
export async function walkPage(keys: string[], batch: Map<string, Batched>, owners: Owners, reuse: Reuse = NO_REUSE): Promise<{ deleted: number; pruned: number }> {
  const doomed = new Set<string>();
  // The keys each follower is handed, by store and family: read together, once the page is sorted.
  const followed = new Map<string, { family: string; owner: string; held: Held | null; keys: string[] }>();
  // Whether a live store holds an id, as this page read it: once a page at the most.
  const page = new Map<string, boolean>();
  let pruned = 0;
  // The page's keys of a closing store, sorted first: whether a live store holds an id one of them is named by alone
  // is read before any of the page's keys is deleted, so a read that is unknown stops the run with them all kept.
  const claimed: { key: string; family: string; claim: Claim }[] = [];
  for (const key of keys) {
    const family = closingFamilyOf(key);
    const rule = family ? CLOSING[family] : null;
    if (!rule) continue;
    if (rule.how === "index") {
      pruned += await pruneIndex(key, owners, reuse, page);
      continue;
    }
    if (rule.how !== "erase") continue;
    let claim: Claim | null;
    if (rule.by === "handle") {
      const owner = ownerOfKey(key, rule, owners);
      claim = owner ? { owner, held: reuse.held.get(addressOf(key)) ?? null } : null;
    } else claim = claimOf(key, owners, reuse, false);
    if (claim) claimed.push({ key, family, claim });
  }
  // Keys named only by an id a live store may hold, and what their followers find through them, by that id: deleted
  // only in the same step as no store is seen holding it (unlessHeld).
  const guarded = new Map<string, { held: Held; keys: Set<string> }>();
  const doom = (key: string, held: Held | null) => {
    if (!held) return void doomed.add(key);
    const group = guarded.get(heldTag(held)) ?? { held, keys: new Set<string>() };
    group.keys.add(key);
    guarded.set(heldTag(held), group);
  };
  for (const { key, family, claim } of claimed) {
    if (claim.held && (await reuse.live(claim.held, page))) continue;
    const owner = claim.owner;
    if (FOLLOWERS[family]?.match(key)) {
      const at = `${owner}|${family}|${claim.held ? heldTag(claim.held) : ""}`;
      const group = followed.get(at) ?? { family, owner, held: claim.held, keys: [] };
      group.keys.push(key);
      followed.set(at, group);
    }
    doom(key, claim.held);
  }
  for (const { family, owner, held, keys: found } of followed.values()) {
    for (const key of await FOLLOWERS[family].find(found, batch.get(owner)!)) if (followable(key, family)) doom(key, held);
  }
  await del([...doomed]);
  let deleted = doomed.size;
  for (const { held, keys: named } of guarded.values()) {
    deleted += await deleteUnheld(held, [...named].filter((key) => !doomed.has(key)));
  }
  return { deleted, pruned };
}

/**
 * The stores of the walk. A batch that does not read is unknown, never an empty one (rule 30, M1 of the review of
 * #3134): with no stores the run's pages deleted nothing and its cursor moved on, and a later run that read the batch
 * finished every store and emailed its owner while those pages' keys remained.
 */
async function readBatch(): Promise<Map<string, Batched>> {
  const list = stringList(repliesFor(await redisPipeline([["HGETALL", BATCH_KEY]]), 1)?.[0]);
  if (!list || list.length % 2 !== 0) throw new UnknownReplyError("the closing walk's batch (HGETALL)");
  const out = new Map<string, Batched>();
  for (let i = 0; i + 1 < list.length; i += 2) {
    const value = json(list[i + 1]) as Batched | null;
    if (value && Array.isArray(value.marks)) out.set(list[i], value);
  }
  return out;
}

/**
 * Moves a closing store that could not be read or prepared back a walk (ZADD XX: never puts back one that left the
 * line meanwhile). True only on Redis's own answer, 0 or 1; anything else is not known to have moved (rule 24), so the
 * old due time may still stand and the run must not say it is done.
 */
async function moveBack(ref: string, now: number): Promise<boolean> {
  const reply = repliesFor(await redisPipeline([["ZADD", DUE_KEY, "XX", now + WALK_GAP_MS, ref]]), 1)?.[0];
  if (reply === 0 || reply === 1) return true;
  console.error("moving a closed store back a walk was not confirmed; it may come up again before then", reply);
  return false;
}

/** What the closing job does when a store's records are gone: told by the caller (lib/plan-closing.ts), which writes it down and emails the owner. */
export type Finisher = (entry: Batched, now: number) => Promise<void>;

/**
 * One run: starts a walk when stores are due and none ran in the last
 * WALK_GAP_MS, carries one on to where it stops, and finishes its stores.
 * Bounded by `deadline` and WALK_PAGES_PER_RUN.
 */
export async function eraseClosed(deadline: number, finish: Finisher, now = Date.now()): Promise<WalkReport> {
  const report: WalkReport = { started: false, stores: 0, pages: 0, deleted: 0, pruned: 0, finished: 0, done: false };
  if (!isRedisConfigured()) return report;
  // A move back a walk that Redis did not confirm (moveBack): this run is never said to be done.
  let unsure = false;
  const [rawState] = await redisPipeline([["HMGET", WALK_KEY, "cursor", "started", "phase"]]);
  const [cursorRaw, startedRaw, phaseRaw] = Array.isArray(rawState) ? rawState.map((v) => (typeof v === "string" ? v : "")) : ["", "", ""];
  let phase = phaseRaw || "idle";
  let cursor = cursorRaw || "0";

  if (phase === "idle" || phase === "") {
    const started = Number(startedRaw) || 0;
    if (now - started < WALK_GAP_MS) return { ...report, done: true };
    const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, "-inf", now, "LIMIT", 0, BATCH_MAX]]);
    const refs = Array.isArray(due) ? (due as unknown[]).map(String) : [];
    // An empty line still reads the prepared stores below: a run that stopped after a store left the line and before
    // its walk started has left its entry there, and only a walk erases what it names.
    for (const ref of refs) {
      if (Date.now() > deadline) break;
      // Still due, read again just before the first destructive step, and the store's lock taken in the same step as
      // the walk sees nothing it read changed (takeDue): a store whose plan runs again leaves the line untouched, one
      // that cannot be said stays in it untouched. While the walk holds the lock no plan can start the store again;
      // once prepared, its record is closed and no plan can reach it any more (lib/closing-plan-guard.ts).
      let taken: Taken;
      try {
        taken = await takeDue(ref, now);
      } catch (error) {
        // Not read (rule 24): never "no store". It stays in line, moved back a walk so it does not hold the head of
        // the line, and is prepared once its record reads; only a store Redis says is gone (nil) leaves the line.
        console.error("a closed store's record could not be read; it waits for the next walk", error);
        if (!(await moveBack(ref, now))) unsure = true;
        continue;
      }
      if (taken.due === "hold") continue;
      if (taken.due === "due") {
        try {
          await prepareStore(taken.store, now, taken.held);
        } catch (error) {
          // The walk's lock ran out under it (LockBusyError): the store may run again, so the walk stops there and
          // changes nothing more of it, its place in line included; the next walk reads it again.
          if (error instanceof LockBusyError) throw error;
          // Something it needs could not be read (rule 24), such as whether a host still serves another store: never
          // taken as "nothing". It waits a walk, as above, and is prepared again (prepareStore is safe to repeat).
          console.error("a closed store could not be prepared; it waits for the next walk", error);
          if (!(await moveBack(ref, now))) unsure = true;
          continue;
        } finally {
          await releaseLock(taken.held);
        }
        // prepareStore wrote the walk's entry before it closed the record.
        report.stores += 1;
      }
      await redisPipeline([["ZREM", DUE_KEY, ref]]);
    }
    // How many stores wait for the walk, read exactly: an unknown count is never "none", which would say the run is
    // done and leave the prepared stores' keys unwalked.
    const count = countOf(repliesFor(await redisPipeline([["HLEN", BATCH_KEY]]), 1)?.[0]);
    if (count === null) throw new UnknownReplyError("the closing walk's count of prepared stores (HLEN)");
    if (count === 0) return { ...report, done: !unsure };
    await redisPipeline([["HSET", WALK_KEY, "phase", "walk", "cursor", "0", "started", now]]);
    phase = "walk";
    cursor = "0";
    report.started = true;
  }

  const batch = await readBatch();
  const owners = ownersOf([...batch.values()]);
  const reuse = await reuseOf(batch);
  while (phase === "walk" && Date.now() < deadline && report.pages < WALK_PAGES_PER_RUN) {
    // A page that does not read is unknown, not a page with no keys nor the end of the database (rule 30): the run
    // stops with the cursor where it was, so the page is read again and no store is finished past it.
    const page = scanPage(await redisPipeline([["SCAN", cursor, "MATCH", "nl:*", "COUNT", WALK_COUNT]]));
    if (!page) throw new UnknownReplyError("the closing walk's SCAN");
    const { next, items: keys } = page;
    const done = await walkPage(keys, batch, owners, reuse);
    report.deleted += done.deleted;
    report.pruned += done.pruned;
    report.pages += 1;
    cursor = next;
    await redisPipeline([["HSET", WALK_KEY, "cursor", cursor, ...(cursor === "0" ? ["phase", "finish"] : [])]]);
    if (cursor === "0") phase = "finish";
  }

  if (phase === "finish") {
    for (const [ref, entry] of batch) {
      if (Date.now() > deadline) return report;
      await finish(entry, now);
      await redisPipeline([["HDEL", BATCH_KEY, ref]]);
      report.finished += 1;
    }
    await redisPipeline([["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "finished", now]]);
    report.done = !unsure;
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
  if (!account) return out;
  for (const handle of saleHandles(store)) {
    let page = "";
    for (let round = 0; round < 50; round += 1) {
      if (Date.now() > until) return { ...out, done: false };
      const query = encodeURIComponent(`metadata['store']:'${handle}'`);
      const found = (await onAccount("GET", account, `/subscriptions/search?limit=100&query=${query}${page ? `&page=${encodeURIComponent(page)}` : ""}`)) as Record<string, unknown>;
      const rows = Array.isArray(found.data) ? (found.data as Record<string, unknown>[]) : [];
      const toStop: string[] = [];
      for (const sub of rows) {
        const id = typeof sub.id === "string" ? sub.id : "";
        const status = typeof sub.status === "string" ? sub.status : "";
        if (!id || ["canceled", "incomplete_expired"].includes(status)) continue;
        out.subs.push(id);
        toStop.push(id);
      }
      for (let i = 0; i < toStop.length; i += RENEWALS_AT_ONCE) {
        if (Date.now() > until) return { ...out, done: false };
        await Promise.all(toStop.slice(i, i + RENEWALS_AT_ONCE).map((id) =>
          onAccount("DELETE", account, `/subscriptions/${encodeURIComponent(id)}`, undefined, undefined, `closed-now:${id}`)));
        out.stopped += Math.min(RENEWALS_AT_ONCE, toStop.length - i);
      }
      page = typeof found.next_page === "string" ? found.next_page : "";
      if (found.has_more !== true || !page) break;
    }
  }
  return out;
}

