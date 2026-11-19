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
 * A store its owner deletes from the studio (lib/store.ts deleteStore) takes
 * the same walk instead of closing (Claude 6's probe P3 on #3643): its entry
 * is written under its lock before its record goes (queueDeleted), waits for
 * the next walk to begin and joins it once its record is gone
 * (admitDeleted), and is taken out of the batch when the walk is done, with
 * no closing record and no email (it was deleted, not closed).
 *
 *   nl:closed:due     sorted set  a store's key -> when its records came due (ms)
 *   nl:closed:batch   hash        a store's key -> what the walk needs of it (JSON), while its walk runs
 *   nl:closed:walk    hash        cursor, started, finished
 *   nl:closed:claims:<ref hash>   string  where a closing store's preparation stopped in its hosts' claims (JSON),
 *                                         until it reaches their end; deleted with the store (claimsLeft)
 *
 * Reading the database is the company's, bounded by its schedule: one walk a
 * day at the most, WALK_COUNT keys a command (docs/funded-exposure-review.md).
 * What is done for each store, its deletes in DEL_BATCH keys a command and
 * what its followers read, is priced once for each store, against its own
 * payments (tests/plan-cost-registry.ts, closure), and the renewals it stops
 * with the orders that sold them (ORDER_COST).
 */
import { createHash } from "node:crypto";
import { onAccount } from "@/lib/stripe-account";
import { ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, scanPage, stringList } from "@/lib/redis-reply";
import { type FencedChange, type Held as LockHeld, LockBusyError, applyIfHeld, holdLock } from "@/lib/redis-lock";
import { CLOSING, type Closing, closingFamilyOf } from "@/lib/data-families";
import { CLAIM_PAGES, CLAIMS_LEFT_DAYS, DEL_BATCH, FOLLOW_BATCH, RENEWALS_AT_ONCE, closesStore } from "@/lib/plan-closing-rules";
import { standingOf } from "@/lib/plan-standing";
import { idsIn } from "@/lib/data-recount";
import { readAllListings } from "@/lib/catalog";
import { readCourses } from "@/lib/course";
import { readFlows } from "@/lib/flows";
import { FINAL_INDEX, finalScoreOf } from "@/lib/closing-holds";
import { MAX_STORES_PER_ACCOUNT, STORE_ID_PATTERN, STRIPE_ACCOUNT_PATTERN, type Store, accountStores, closeStoreRecord, ERASING_KEY, erasingField, erasingSince, handleLeadsToStore, saleHandles, settleDeletedStore, storeExactly, storeFolder, storeForEmailSeen, storeForRefExact, storeHandleKey, storeRecordAt, storeRef } from "@/lib/store";
import { domainKey } from "@/lib/domains";
import { dropTeam, memberStoresExact, readTeam } from "@/lib/team";
import { hostCalendarKeys } from "@/lib/host-calendar";
import { revokeAllKeys } from "@/lib/api-keys";
import { forgetBoth, queueStoreForget } from "@/lib/store-forget-retry";
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
import { pictureNoteKey } from "@/lib/community-files";
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
  /**
   * Walked, but its last mark could not be written (ms; finishStores): it waits in the batch to be finished again and
   * is never walked by its ids again, since by then another store may hold its address or key.
   */
  unfinished?: number;
  /**
   * Hosts (their emails) whose own calendar was kept at the preparation because whether they serve another store
   * could not be known (servesAnother): each is read again before the store is finished (decideCalendars), and the
   * store stays in the batch, set aside, until each is known (Claude 4 on #3660).
   */
  calendars?: string[];
  /** Its last mark was written (ms; finishStores): it stays in the batch only for `calendars`, and is not told again. */
  finished?: number;
  /**
   * Written before the store's record goes and not yet confirmed as this store's (prepareStore): rewritten without it
   * under the store's lock right before the record is deleted. One still pending names a store whose record has not
   * gone by this closing, or a key another store holds now (Codex on #3643): it is never walked, never finished and
   * never starts a walk, and the idle pass takes it out (withdrawPending).
   */
  pending?: true;
  /**
   * Its record went, and another store was found at its key before its walk started (Claude 7's ALTO 1 on #3643): it is
   * walked by its own ids only (marks), never by its address or its handles, which may be the new store's now, and its
   * finish writes nothing at its address. Set only over the exact entry read (REWRITE_ENTRY).
   */
  marksOnly?: true;
  /** Deleted from the studio (queueDeleted), not closed: no closing record is written and nobody is emailed when its walk is done. */
  deleted?: true;
  /** Waits for the next walk to begin (admitDeleted): it is never walked or finished by a walk already under way, which may have passed its keys. */
  queued?: true;
  /** A deleted store's addresses that still led to it when it was deleted, held back again at its admission (settleDeletedStore). */
  holds?: string[];
  /**
   * A deleted store's community id, so a round its admission puts in line lists its community's pictures too
   * (community/<folder>/), which nothing else names once its record is gone (Claude 5's LEVE 1 on #4348).
   */
  community?: string;
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
  const found = new Set<string>([...(await recordIds(store)), ...idsIn(JSON.stringify(listings), JSON.stringify(flows), JSON.stringify(courses))]);
  for (const id of [...courseIds, ...listings.flatMap((l) => (l.podcast ? [l.podcast.id] : [])), ...flows.map((f) => f.id)]) if (id) found.add(id);
  for (const ours of [store.stripeCustomerId, store.subscriptionId]) if (ours) found.delete(ours);
  if (store.stripeAccountId && (await sharedAccount(store))) found.delete(store.stripeAccountId);
  // The owner's address and the store's addresses are not ids: the walk matches them only where a family says so.
  found.delete(store.email);
  return { marks: [...found].sort(), files: filesIn([listings, courses]) };
}

/** The ids the store record itself names: its own (store, stats, list, calls, catalog, community, files' folder, photo) and every id-like word in it. */
async function recordIds(store: Store): Promise<string[]> {
  const own = [store.sid, store.statsId, store.listId, store.callsId, store.catalog?.id, store.community?.id, await storeFolder(storeRef(store)), store.photoId];
  return [...own.filter((id): id is string => typeof id === "string" && id.length >= 6), ...idsIn(JSON.stringify(store))];
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
 * Takes this call's own walk entry out of the batch, only while it still holds the exact bytes this call wrote
 * (another preparation's entry for the same ref is never taken). 1 taken, 0 not this call's; anything else unknown.
 */
const WITHDRAW_ENTRY = `-- marktmorgen:closing-withdraw-entry:v1
if #KEYS ~= 1 or #ARGV ~= 2 then return -1 end
if redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
return redis.call("HDEL", KEYS[1], ARGV[1])`;

/**
 * Rewrites a closing store's walk entry only while it still holds the exact bytes read (Claude 7's ALTO 1 on #3643):
 * 1 written, 0 not the entry read; anything else unknown.
 */
const REWRITE_ENTRY = `-- marktmorgen:closing-rewrite-entry:v1
if #KEYS ~= 1 or #ARGV ~= 3 then return -1 end
if redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[3])
return 1`;

/**
 * Another store (another sid) is kept at a closing store's key by the time its record is read again, and its walk entry,
 * which names that store's ref and its owner's folder, could not be confirmed taken out of the batch (rule 24). The
 * caller takes the ref out of line all the same (never prepared again under it: that is the other store) and starts no
 * walk in this run.
 */
export class EntryNotWithdrawnError extends UnknownReplyError {}

/**
 * The store's plan runs again (paid or in trial) and its closing day has not begun (not in FINAL_INDEX), read before
 * anything of it is touched and again under its lock right before its record goes (Claude 5's MEDIUM on #3643): nothing
 * of it was prepared past that read, and its record stays. The caller takes it out of line, never moved back a walk,
 * as lib/plan-closing.ts closeOne does for a plan that runs again ("running").
 */
export class PlanRunsAgainError extends Error {}

/** A plan that runs, as closeOne reads it: paid or in trial (standingOf). One ended, or never had, is not running. */
function planRuns(store: Store, now: number): boolean {
  const standing = standingOf(store, now / 1000);
  return standing === "paid" || standing === "trial";
}

/** How many times prepareStore tries to take such an entry out before it throws EntryNotWithdrawnError. */
const WITHDRAW_TRIES = 2;

/** Takes a store out of line: its plan was started again before its walk began. */
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
  // A closing day that has begun is seen through, whatever the plan says since (closeOne, and #3643's prepareStore, which
  // erases it under the store's lock): due once the record says what it kept was removed for that day's ending.
  if (score !== null) return seen(removedFor(Number(score)) ? "due" : "hold");
  const endedAt = Date.parse(store.planEndedAt);
  if (standing !== "ended" || !Number.isFinite(endedAt)) return seen("live");
  return seen(closesStore(endedAt) && removedFor(endedAt) ? "due" : "live");
}

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
    const changes: FencedChange[] = [];
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
    if (!(await applyIfHeld(held, changes))) throw new LockBusyError("a closing store's lock ran out before its deletes");
    return [];
  };
}

/**
 * A store's record key (lib/store.ts, ownerKey), spelled as lib/store.ts spells it: it does not export it. The checks
 * that no live store holds an id (CLOSING_UNHELD) read it; tests/m-reactivation-during-check.proof.ts and
 * tests/erase-race-final-check.test.ts change a store with the real setSubscription and claimHandle around the walk,
 * and fail if the spellings ever differ.
 */
const ownerKeyOf = (ref: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${ref.toLowerCase()}`).digest("hex").slice(0, 40)}`;

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

/**
 * Deletes the keys a batch at a time. Through the walk's lock (fencedBy), each batch is made only while the lock is
 * still the walk's and that step's answer is read exactly there. Without it, each batch's count is read exactly (rule
 * 24; issue #4390): one integer from 0 to the batch's size. Any other answer throws UnknownReplyError before the walk's
 * cursor moves, so the store stays in the batch and the next run repeats the same page, never counting as deleted what
 * a reply that said nothing may have left.
 */
async function del(keys: string[], apply: Apply = redisPipeline): Promise<void> {
  for (let i = 0; i < keys.length; i += DEL_BATCH) {
    const batch = keys.slice(i, i + DEL_BATCH);
    const replies = await apply([["DEL", ...batch]]);
    if (apply !== redisPipeline) continue;
    const exact = repliesFor(replies, 1);
    const gone = exact ? countOf(exact[0]) : null;
    if (gone === null || gone > batch.length) throw new UnknownReplyError("deleting a closing store's keys");
  }
}

/**
 * The first step for one store, while its record can still be read: what
 * is found only through it, and then the record. Answers what the walk
 * needs of it, or null when another store is kept at its key by the time its
 * record is read again: then nothing of it is walked. Safe to run again.
 */
export async function prepareStore(store: Store, now = Date.now()): Promise<Batched | null> {
  const ref = storeRef(store);
  // A plan that runs again keeps the store (Claude 5's MEDIUM on #3643): a preparation that stopped after its entry was
  // confirmed, an entry not confirmed out, and the walk's start (startableBatch) put a store back in line after
  // closeOne had taken it out for a running plan, and the next run erased it. Read before anything of it is touched:
  // a closing day that has begun (FINAL_INDEX) is seen through whatever happens to the plan since, as closeOne does;
  // otherwise a running plan throws PlanRunsAgainError. The place in the final line read exactly (finalScoreOf): one that
  // does not read throws UnknownReplyError, neither ended nor running (rule 24), and the store waits a walk untouched.
  // One command, and only for a store whose plan reads running (PLAN_RUNS_READ_COMMANDS, tests/plan-cost-registry.ts).
  // A store whose erasure began on an earlier walk (its erasing mark there, read exactly) is erased to the end whatever
  // its plan says: part of it is already gone (Codex N1's HIGH on #3156). One more command, again only for a store whose
  // plan reads running and whose closing day is not in the final line any more.
  if (planRuns(store, now) && finalScoreOf(await redisPipeline([["ZSCORE", FINAL_INDEX, ref]])) === null && (await erasingSince(ref)) === null) {
    throw new PlanRunsAgainError(`a closing store's plan runs again: ${ref}`);
  }
  const { marks } = await marksOf(store);
  const extra: string[] = [];
  // Read whole or not at all: a team not read is never "no teammates" (rule 24); it throws, and the walk waits.
  const team = store.sid ? await readTeam(store.sid) : { members: [], invites: [] };
  const own = new Set(marks);
  const hosts = [store.email, ...team.members.map((m) => m.email)];
  // A host's own calendar is the host's, across the stores they serve: it goes with the last of them, and only when
  // it is known to be the last (servesAnother). Whether they serve another store is read exactly (Claude 6 on #3156):
  // until then accountStores read an account set that did not answer as a list as no other store, and memberStores
  // left out a store whose team or record did not read and stopped at fifty, so a live store's host lost their
  // calendar. Not known is never "no other store" (rules 24 and 30): their calendar is kept, and the rest of the
  // closing store goes on. Until then not known moved the store back a walk, and a host on more stores than are read
  // (MEMBER_STORES_READ), which nothing bounds, made every closing store they host unerasable (Claude 4 on #3660).
  // One not known is read again before the store is finished (decideCalendars), so a reply that did not read once
  // never keeps a host's calendar, with their private calendar link, for good (Claude 4 on #3660 at af59d74bde).
  const calendars: string[] = [];
  for (const email of hosts) {
    const serves = await servesAnother(email, store.sid);
    if (serves === false) extra.push(...hostCalendarKeys(hostId(email)));
    else if (serves === null) calendars.push(email);
  }
  if (store.domain?.name) extra.push(domainKey(store.domain.name));
  // What the live store holds (its hosts' claims for it, its team, API keys, webhooks, email sync, mail outboxes, phones,
  // its owner's path, its hosts' calendars and its domain) is deleted only under the store's lock, once the record read
  // there again says its plan does not run (below). Deleted here, before that read, a plan started in between kept the
  // record but left the store partly wiped (Codex X4's MEDIUM on #3643). Any of these that fails throws there, before
  // the record goes: the record stays, its entry stays pending, and the walk tries the store again later.
  const forgetLive = async (held: LockHeld) => {
    // Every delete made only while the store's lock closeStoreRecord holds is still held, read in the same step
    // (fencedBy, CLOSING_FENCED), and the lock made to last again before each step: a lock that ran out (a paused
    // function, a slow network) stops here with LockBusyError before anything more is deleted, the record still there,
    // so a plan started once it ran out keeps everything of its store (Codex M's focal M1 on #3156, on #3643's design).
    // The two mail outboxes (forgetShipmentMail, forgetOrderConfirmationMail) are the exception: they delete nothing
    // while CURRENT_SHIPMENT_MAIL_LIFECYCLE is "never_activated", and they take the same `apply` before it changes
    // (Claude 5's LOW on #3156); tests/erase-lock-fence.test.ts fails the day it changes without them.
    const apply = fencedBy(held);
    const keep = async () => {
      if (!(await holdLock(held))) throw new LockBusyError("a closing store's lock ran out while its live data was deleted");
    };
    // The erasing mark first (Codex N1's HIGH on #3156): written through the same fence as the deletes, before any of
    // them, so from the first delete on no plan starts on this store (lib/store.ts, setSubscription) and a payment for it
    // is returned (closingSince). Its write not proved throws here, with nothing deleted. It goes with the record.
    await keep();
    await apply([["HSET", ERASING_KEY, await erasingField(ref), String(now)]]);
    // Its calendar hosts' claims, which are kept by the host, across the stores they serve: each page read exactly, each
    // HDEL made through the lock (fencedBy), the lock made to last before a host's first, and where a walk stopped kept
    // for the next (clearClaims, Claude 4 on #3660). The key of that place goes with the store's other keys below.
    const claimsPlace = await clearClaims(store, hosts.map(hostId), own, keep, apply);
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
    await keep();
    await del([...extra, claimsPlace], apply);
  };
  // Out of the closing day's line before its record goes (queue item 307 [EC1]): a new store its owner opens
  // under the same key is never taken for this one. A plan paid under this store's addresses after this is
  // still found by their mark (lib/closing-plan-guard.ts, markShut).
  // Its answer says whether its closing day had begun (1: it was in that line), read again under the lock below.
  const finalGone = countOf(repliesFor(await redisPipeline([["ZREM", FINAL_INDEX, ref]]), 1)?.[0]);
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
    ...(calendars.length ? { calendars } : {}),
  };
  // The walk's entry is written before the record goes: once the record is gone, only this entry names the store's
  // keys. A write that fails throws with the record still there, and the walk tries the store again later.
  // Only HSET's own count (0 for an entry rewritten, 1 for a new one) is a write; any other answer is not known to
  // have landed and throws before the record goes (Codex T on #3181).
  let wrote = "";
  const write = async (batched: Batched) => {
    const bytes = JSON.stringify(batched);
    const written = repliesFor(await redisPipeline([["HSET", BATCH_KEY, ref, bytes]]), 1)?.[0];
    if (written !== 0 && written !== 1) throw new Error("the closing store's walk entry was not confirmed written");
    wrote = bytes;
  };
  // Pending until the record's going confirms it this store's (below): a pending entry is never walked (Codex on #3643).
  await write({ ...entry, pending: true });
  // The record is read again under its lock right before it goes (closeStoreRecord), since all of the above worked
  // from the walk's first read: an id it names now and the entry does not (a photo put on meanwhile, through the photo
  // route's setPhotoId; an id made since) becomes a mark, and an address it moved to since one of the entry's, before
  // the record goes, so the walk erases their keys too and nothing is left that no record names (Codex G on #3614).
  // Only ids never to be marks stay out: our own Stripe customer and subscription, its Stripe account (a mark already,
  // unless another store shares it) and its owner's address. The entry rewritten is confirmed or this throws, with the
  // record still there, and the store waits a walk.
  // The entry is always written again here, without `pending`, under the lock and before the record goes: only an entry
  // so confirmed is walked (Codex on #3643). A step that fails after it (the addresses' hold, the id's release, the fenced
  // delete) or a rewrite whose answer is lost leaves the entry as it is: whether the record went is not known here, since
  // a delete or a rewrite may land with its answer lost (Codex L and Codex P on #3643). It is never taken out for it: the
  // walk reads the record before it starts (startableBatch) and walks the entry only once the record is confirmed gone.
  const closed = await closeStoreRecord(store, [], async (fresh, held) => {
    // A plan started since the read above, seen under the lock before the record goes (Claude 5's MEDIUM on #3643):
    // unless its closing day had begun (the ZREM above took it out of that line), the record stays and the store leaves
    // the line; its entry, still pending, is never walked and is taken out by the idle pass (withdrawPending). That
    // ZREM's answer not known is neither (rule 24): the record stays and the store waits a walk. No command is added:
    // the record is the one closeStoreRecord read again.
    // A store whose erasure began on an earlier walk (its mark there, read exactly under the lock) is erased to the end:
    // part of it is already gone, and it is never left open half erased (Codex N1's HIGH on #3156).
    const began = (await erasingSince(ref)) !== null;
    if (fresh && planRuns(fresh, now) && finalGone !== 1 && !began) {
      if (finalGone === 0) throw new PlanRunsAgainError(`a closing store's plan runs again: ${ref}`);
      throw new UnknownReplyError("a closing store's place in the final closing line (ZREM)");
    }
    // Only now, past that read and with the lock held (a plan's start waits on it), is anything of the live store deleted.
    await forgetLive(held);
    if (fresh) {
      const never = new Set([store, fresh].flatMap((s) => [s.stripeCustomerId, s.subscriptionId, s.stripeAccountId, s.email]));
      const added = (await recordIds(fresh)).filter((id) => !own.has(id) && !never.has(id));
      const moved = [...saleHandles(fresh)].filter((handle) => !entry.handles.includes(handle));
      entry.marks = [...new Set([...marks, ...added])].sort();
      entry.handles = [...entry.handles, ...moved];
    }
    await write(entry);
  });
  if (closed) return entry;
  // Another store (another sid) is kept at this one's key: this one's record is already gone, and its ref and its
  // owner's folder are the other store's now. Its entry, left in the batch, made the walk erase the other store's keys
  // by that ref (its break and its last break, nl:pause:<ref> and nl:pause:last:<ref>) and finish it under that ref
  // (Revisor 2 on #3643): it is taken out, only while it still holds the bytes written here, and nothing of it is
  // walked. At most WITHDRAW_TRIES scripts, no more commands than the record's going they replace (its addresses held
  // back, its id and places released, the entry's rewrite, the fenced delete), so inside PREPARE_COMMANDS
  // (tests/closing-cost.test.ts).
  // Tried WITHDRAW_TRIES times: 0 after a try whose answer was unknown is that try having taken it, or another
  // preparation's entry, which is not this call's either way.
  for (let tries = 0; tries < WITHDRAW_TRIES; tries += 1) {
    const taken = repliesFor(await redisPipeline([["EVAL", WITHDRAW_ENTRY, 1, BATCH_KEY, ref, wrote]]).catch(() => null), 1)?.[0];
    if (taken === 0 || taken === 1) return null;
  }
  throw new EntryNotWithdrawnError("a closing store's walk entry, taken out with another store at its key (EVAL)");
}

/** Where a closing store's preparation stopped in its hosts' claims, until it reaches their end (clearClaims). */
const claimsLeftKey = (ref: string) => `nl:closed:claims:${createHash("sha256").update(`closing-claims:${ref}`).digest("hex").slice(0, 40)}`;
/** A host whose claims were read to their end, in claimsLeftKey. */
const CLAIMS_END = "end";
/**
 * A host read to their end once more on the walk that finishes (clearClaims): "r:<cursor>" while that re-read is under
 * way, CLAIMS_REREAD once it reached the end. A host is re-read at most once a closing (Claude 4's LEVE on #3660: two
 * big hosts each re-reading the other made the store never prepared).
 */
const CLAIMS_REREAD = "end2";
const CURSOR = /^\d{1,20}$/;
const REREAD_CURSOR = /^r:\d{1,20}$/;

/** A closing store whose hosts' claims are more than one walk reads: it waits a walk, and goes on from where it stopped. */
class ClaimsLeftError extends Error {
  constructor() {
    super(`a closing store's hosts' claims are more than ${CLAIM_PAGES} pages a host; the next walk goes on from where this one stopped`);
  }
}

/**
 * Where an earlier walk stopped in this store's hosts' claims: a host's cursor, or CLAIMS_END for one read to the end.
 * Only what this closing of the store wrote counts (`ended`, its plan's end): a store that ran again and closes again
 * starts over. Nothing kept, or what does not read as one (an answer of another shape, a damaged value), starts over
 * too: where it stopped only ever lets a walk skip pages already read, so starting over reads pages again and never
 * leaves a claim (rule 24 is about the other way round: what does not read is never taken for "nothing to delete").
 */
async function claimsLeft(key: string, ended: string): Promise<Record<string, string>> {
  const raw = repliesFor(await redisPipeline([["GET", key]]), 1)?.[0];
  const value = typeof raw === "string" ? json(raw) : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const { ended: was, hosts } = value as { ended?: unknown; hosts?: unknown };
  if (was !== ended || !hosts || typeof hosts !== "object" || Array.isArray(hosts)) return {};
  const out: Record<string, string> = {};
  for (const [host, at] of Object.entries(hosts)) if (typeof at === "string" && (at === CLAIMS_END || at === CLAIMS_REREAD || CURSOR.test(at) || REREAD_CURSOR.test(at))) out[host] = at;
  return out;
}

/**
 * Deletes the closing store's claims from each of its hosts' claims (a host's claims are theirs, across the stores
 * they serve: only those that name one of the store's ids go), CLAIM_PAGES pages of HSCAN a host a walk at the most.
 * Answers the key of where it stopped, for the preparation to delete with the store's other keys.
 *
 * A page that does not read, or a field without its value, is unknown, never the end of the host's claims (rules 24
 * and 30, as scanAll; Claude 6 on #3156); a host not at their end after CLAIM_PAGES pages is not finished either
 * (Claude 4 on #3660). Either way where it stopped is written (SET with EX, fenced as the deletes are, the lock made
 * to last first) and the store waits a walk (ClaimsLeftError, or the error of the page): the next walk goes on from
 * there, so every walk reads new pages and the store is prepared once the last host reaches their end. Until then
 * the walk started over each time and a host with more than CLAIM_PAGES pages made the store unerasable, forever.
 * A delete that fails, or whose count does not read (rule 24, #4391), throws as it is, and the walk goes on from
 * where the last one wrote it stopped.
 *
 * A cursor kept from one walk to the next is a SCAN cursor: what was in the hash from the first page to the last is
 * returned (Redis's SCAN guarantee); a claim of this store written in between may not be, as within one walk.
 */
async function clearClaims(store: Store, hosts: string[], own: Set<string>, keep: () => Promise<void>, apply: Apply): Promise<string> {
  const key = claimsLeftKey(storeRef(store));
  const ended = String(store.planEndedAt ?? "");
  const left = await claimsLeft(key, ended);
  // Hosts read to their end on an earlier walk: a claim naming this store may have been written to them since (a paid
  // booking is written whatever is there), so each is read once more from its start on the walk that finishes
  // (Claude 5's LOW on #3660), within CLAIM_PAGES like any other host.
  const endedBefore = hosts.filter((host) => left[host] === CLAIMS_END);
  let moved = false;
  let stopped: unknown = null;
  let kept = false;
  /**
   * Reads `host`'s claims from `from`, CLAIM_PAGES pages at the most, deleting this store's: where it stopped. A re-read
   * (`again`) keeps its place as "r:<cursor>" and its end as CLAIMS_REREAD, so it is never started over.
   */
  const walkHost = async (host: string, from: string, again = false): Promise<string> => {
    let cursor = from;
    for (let round = 0; round < CLAIM_PAGES && cursor !== CLAIMS_END; round += 1) {
      let page: ReturnType<typeof scanPage> = null;
      try {
        page = scanPage(await redisPipeline([["HSCAN", claimsKey(host), cursor, "COUNT", 500]]));
      } catch (error) {
        stopped = error;
        break;
      }
      if (!page || page.items.length % 2 !== 0) {
        stopped = new UnknownReplyError("a closing store's host's claims (HSCAN)");
        break;
      }
      const { next, items: flat } = page;
      const mine: string[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) if (pieces(flat[i + 1]).some((part) => own.has(part))) mine.push(flat[i]);
      if (mine.length) {
        // Once a walk, before the first of them goes.
        if (!kept) await keep();
        kept = true;
        // Through the walk's lock each HDEL is read exactly by the fenced step; without it, its answer must be one
        // whole count from 0 to the fields asked (rule 24, #4391): anything else throws as a failed delete.
        const replies = await apply([["HDEL", claimsKey(host), ...mine]]);
        if (apply === redisPipeline) {
          const gone = countOf(repliesFor(replies, 1)?.[0]);
          if (gone === null || gone > mine.length) throw new UnknownReplyError("the closing walk's removal of a host's claims");
        }
      }
      cursor = next === "0" ? CLAIMS_END : next;
      left[host] = again ? (cursor === CLAIMS_END ? CLAIMS_REREAD : `r:${cursor}`) : cursor;
      moved = true;
    }
    return cursor;
  };
  let unfinished = false;
  for (const host of hosts) {
    const at = left[host] ?? "0";
    // Re-read already done: nothing more. A re-read under way goes on from where it stopped, as a re-read.
    if (at === CLAIMS_REREAD) continue;
    const again = REREAD_CURSOR.test(at);
    const cursor = await walkHost(host, again ? at.slice(2) : at, again);
    if (stopped) break;
    if (cursor !== CLAIMS_END) unfinished = true;
  }
  if (!stopped && !unfinished && endedBefore.length > 0) {
    for (const host of endedBefore) {
      const cursor = await walkHost(host, "0", true);
      if (stopped) break;
      if (cursor !== CLAIMS_END) unfinished = true;
    }
  }
  if (!stopped && !unfinished) return key;
  if (moved) {
    await keep();
    await apply([["SET", key, JSON.stringify({ ended, hosts: left }), "EX", CLAIMS_LEFT_DAYS * 86_400]]);
  }
  throw stopped ?? new ClaimsLeftError();
}

/**
 * Whether this person serves a store other than `sid` now, as one of its team (memberStoresExact) or as its owner
 * (ownsAnother): true, false, or null when it cannot be known (a reply that does not read, a team or a store whose
 * record does not read, more stores in their index than are read). Only false lets their own calendar go; null is
 * never "no other store" (rule 24), and never stops the rest of the closing either (Claude 4 on #3660).
 */
async function servesAnother(email: string, sid: string): Promise<boolean | null> {
  try {
    if ((await memberStoresExact(email, sid)).some((m) => m.store.sid !== sid)) return true;
    return await ownsAnother(email, sid);
  } catch (error) {
    console.error("whether a closing store's host serves another store could not be known; their own calendar is kept", error);
    return null;
  }
}

/**
 * How long a deleted store's entry waits for its record to go: deleteStore writes it under the store's lock, held
 * LOCK_SECONDS at the most, and deletes the record right after. A record still there past this was never deleted
 * (the person was told it went wrong), and its entry is dropped, never walked.
 */
export const DELETE_SETTLES_MS = 60 * 60 * 1000;

/**
 * A store deleted from the studio (lib/store.ts deleteStore, app/api/store/stores): what the walk needs of it, written
 * under its lock before its record goes, so its keys named by its ids (its page photo, its list, its data room...) are
 * erased by the walk as a closed store's are (Claude 6's probe P3 on #3643, rule 30). Until then they stayed for good,
 * with nothing naming them. It waits for the next walk to begin (`queued`). Only HSET's own count is a write: any
 * other answer throws, and the store is not deleted (rule 24).
 */
export async function queueDeleted(store: Store, now = Date.now()): Promise<Batched> {
  const ref = storeRef(store);
  const { marks } = await marksOf(store);
  const entry: Batched = {
    ref,
    email: store.email,
    sid: store.sid,
    statsId: store.statsId,
    name: store.name,
    handle: store.handle,
    handles: [...saleHandles(store)],
    holds: [store.handle, ...store.previousHandles],
    marks,
    endedAt: now,
    at: now,
    deleted: true,
    queued: true,
    ...(store.community?.id ? { community: store.community.id } : {}),
  };
  const written = repliesFor(await redisPipeline([["HSET", BATCH_KEY, ref, JSON.stringify(entry)]]), 1)?.[0];
  if (written !== 0 && written !== 1) throw new UnknownReplyError("a deleted store's walk entry written");
  return entry;
}

/**
 * One entry of the batch changed only while it is still exactly the text read, in one step (a compare-and-set):
 * ARGV[3] written in its place, or, when ARGV[3] is empty, the field dropped. 1 changed, 0 not (another write landed
 * meanwhile, such as a retried delete's fresh entry, and is kept). Modelled by lib/redis-memory.ts.
 */
export const BATCH_SWAP = `-- marktmorgen:closed-batch-swap:v1
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
if ARGV[3] == '' then redis.call('HDEL', KEYS[1], ARGV[1]) else redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) end
return 1`;

/** BATCH_SWAP's answer read exactly: true changed, false kept (changed meanwhile), null unknown (rule 24). */
async function swapEntry(ref: string, read: string, next: string): Promise<boolean | null> {
  const reply = repliesFor(await redisPipeline([["EVAL", BATCH_SWAP, 1, BATCH_KEY, ref, read, next]]), 1)?.[0];
  return reply === 1 ? true : reply === 0 ? false : null;
}

/**
 * Before a walk begins: deleted stores waiting in the batch join it once Redis says their record is gone (nil). One
 * whose record still stands is never walked: it waits while its delete may be under way (DELETE_SETTLES_MS), and is
 * then dropped. A record not read, or a write not confirmed, leaves the entry waiting and the run unsure (rule 24).
 *
 * Each change is made only over the exact entry read (BATCH_SWAP), never by a plain HSET or HDEL: this takes no store
 * lock, and a retried delete may write a fresh entry into the same field under its own lock after this read the old
 * one (Codex T and reviewer 2 on #3670). The old entry's hour then said nothing about the new delete, and dropping or
 * rewriting the field lost the fresh entry, so the deleted store's id-named keys stayed for good. A field that changed
 * meanwhile is left as it is, for the next walk to read again.
 *
 * Its record read gone (Redis's own nil), this exact read stands in for any the delete could not make, so what the
 * delete does once the record is gone is done again here, before its entry joins the walk (Claude 6's two LOWs and
 * reviewer C3 on #3670): its addresses held back and its places released (settleDeletedStore), which a delete that
 * answered `unsure` never tried again; and its webhooks, API keys and assistant notes forgotten (forgetBoth), which a
 * delete whose record went with a reply lost, and whose read after it failed too, never forgot, while its API key's
 * lookup (family "prepare") is not erased by the walk. A forget that fails leaves the entry waiting, since the walk
 * erases the API keys' list that leads to the lookups, and goes in the line the daily job tries again
 * (queueStoreForget). Each step can run again; one not confirmed leaves the entry waiting and the run unsure.
 */
async function admitDeleted(entries: Map<string, Batched>, raws: Map<string, string>, now: number, deadline: number): Promise<{ admitted: number; sure: boolean }> {
  let admitted = 0;
  let sure = true;
  for (const [ref, entry] of entries) {
    if (!entry.queued) continue;
    // Past the run's time, the rest wait for the next run.
    if (Date.now() > deadline) {
      sure = false;
      break;
    }
    const read = raws.get(ref);
    if (read === undefined) {
      sure = false;
      continue;
    }
    let standing: Store | null;
    try {
      standing = await storeExactly(ref);
    } catch (error) {
      console.error("a deleted store's record could not be read; its walk waits", error);
      sure = false;
      continue;
    }
    if (!standing) {
      let settled: boolean;
      try {
        settled = await settleDeletedStore({ ref, sid: entry.sid, email: entry.email, holds: entry.holds ?? [entry.handle] });
      } catch (error) {
        console.error("a deleted store's addresses held back and its places released: not confirmed; its walk waits", error);
        settled = false;
      }
      if (!settled) {
        sure = false;
        continue;
      }
      try {
        await forgetBoth(entry.statsId ?? null, entry.sid);
      } catch (error) {
        // Not admitted: the walk would erase the API keys' list (nl:api:keys:<sid>), the only way to their lookups,
        // and a later try would then find none to forget (reviewer C3's LEVE on #3670). The entry waits for the next
        // run's try; the daily job's line tries meanwhile, while the list still stands.
        console.error("forgetting a deleted store's webhooks, keys and assistant notes at its walk failed; its walk waits, and it is put in line to try again", error);
        sure = false;
        try {
          // Its community too, checked there against COMMUNITY_ID, so the round lists its pictures as well.
          await queueStoreForget(entry.statsId ?? null, entry.sid, Date.now(), typeof entry.community === "string" ? entry.community : null);
        } catch (queued) {
          console.error("putting a deleted store's webhooks, keys and assistant notes in line failed", queued);
        }
        continue;
      }
      const walkable: Batched = { ...entry };
      delete walkable.queued;
      const set = await swapEntry(ref, read, JSON.stringify(walkable));
      if (set === true) admitted += 1;
      else if (set === null) sure = false;
      continue;
    }
    if (now - entry.at <= DELETE_SETTLES_MS) continue;
    if ((await swapEntry(ref, read, "")) === null) sure = false;
  }
  return { admitted, sure };
}

/** Who owns a key: the closing store one of whose ids names it. */
type Owners = { byMark: Map<string, string>; byHandle: Map<string, string>; byRef: Map<string, string> };

function ownersOf(batch: Batched[]): Owners {
  const owners: Owners = { byMark: new Map(), byHandle: new Map(), byRef: new Map() };
  for (const entry of batch) {
    if (entry.unfinished || entry.pending || entry.queued) continue;
    for (const mark of entry.marks) owners.byMark.set(mark, entry.ref);
    // A store walked by its own ids only (marksOnly): its address and handles may be another store's now.
    if (entry.marksOnly) continue;
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

/**
 * Whether this owner keeps a store other than `sid` now, read exactly (as accountHeld reads their stores): their first
 * store, then each store of their account's set, at most MAX_STORES_PER_ACCOUNT of them. A reply that does not read, a
 * record there that is not the store of its key, or a set of more stores than an account may have throws
 * UnknownReplyError; an id with no record (nil), or a record of another owner (a move half done, which accountStores
 * does not list either), is not one. Until then prepareStore read accountStores, which reads a set that does not
 * answer as a list as no other store (Claude 6 on #3156). A member of the set that is not a store's id makes the whole
 * set unknown, as in a teammate's index (memberStoresExact): only store ids are ever added to it, so one that is not
 * is a damaged set, never proof of no other store (Codex N1 on #3660). Its caller takes a throw as not known
 * (servesAnother).
 */
async function ownsAnother(email: string, sid: string): Promise<boolean> {
  const first = await storeUnder(email, "whether the owner of a closing store keeps a first store (GET)");
  if (first && first.sid !== sid) return true;
  const ids = stringList(repliesFor(await redisPipeline([["SMEMBERS", accountStoresKey(email)]]), 1)?.[0]);
  if (!ids) throw new UnknownReplyError("the owner's other stores (SMEMBERS)");
  if (ids.some((id) => !STORE_ID_PATTERN.test(id))) throw new UnknownReplyError("the owner's other stores (an id that is not a store's)");
  const others = ids.filter((id) => id !== sid);
  // The set holds only the stores after the account's first one, so at most MAX_STORES_PER_ACCOUNT - 1 members can
  // remain after the closing store itself is left out. Exactly MAX_STORES_PER_ACCOUNT is already an impossible set,
  // never proof that the owner has no other live store.
  if (others.length >= MAX_STORES_PER_ACCOUNT) throw new UnknownReplyError(`the owner's other stores, more than an account may have (SMEMBERS),`);
  for (const id of others) {
    const other = await storeUnder(`#${id}`, "whether the owner of a closing store keeps another store (GET)");
    if (other && other.email.toLowerCase() === email.toLowerCase()) return true;
  }
  return false;
}

/** Whether a store of this owner sells through this Stripe account now, read exactly: its first store and every other store of its account. */
async function accountHeld(email: string, account: string): Promise<boolean> {
  const first = await storeUnder(email, "whether the owner's first store sells through a closing store's account (GET)");
  if (first?.stripeAccountId === account) return true;
  const replies = repliesFor(await redisPipeline([["SMEMBERS", accountStoresKey(email)]]), 1);
  const ids = replies?.[0];
  if (!replies || !Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new UnknownReplyError("the owner's other stores (SMEMBERS)");
  // An id that is not a store's does not prove that no store holds the account: unknown, as in ownsAnother.
  if ((ids as string[]).some((id) => !STORE_ID_PATTERN.test(id))) throw new UnknownReplyError("the owner's other stores (an id that is not a store's)");
  // The set holds only stores after the account's first one. Five members already exceed the four-extra-store bound;
  // an impossible set is not proof that no live store keeps this shared account.
  if (ids.length >= MAX_STORES_PER_ACCOUNT) throw new UnknownReplyError("the owner's other stores, more than an account may have (SMEMBERS)");
  for (const id of ids as string[]) {
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
    if ((ids as string[]).some((id) => !STORE_ID_PATTERN.test(id))) throw new UnknownReplyError("the owner's other stores (an id that is not a store's)");
    known = ids as string[];
    checks = [ownerKeyOf(one.email), accountStoresKey(one.email), ...known.map((id) => ownerKeyOf(`#${id}`))];
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

/** A community post's picture path, read from the post as kept; "" for anything else. */
function postPicture(raw: string): string {
  try {
    const path = (JSON.parse(raw) as { img?: { path?: unknown } | null } | null)?.img?.path;
    return typeof path === "string" && /^community\/[0-9a-f]{24}\/[0-9a-f]{32}\.(webp|jpg)$/.test(path) ? path : "";
  } catch {
    return "";
  }
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
  // A community's members: the link in their announcements that stops them. And its posts: the mark each posted
  // picture keeps for as long as its post keeps it (lib/community-files.ts, pictureNoteKey; Claude 6 on #3414).
  "nl:cm:": {
    match: (key) => /^nl:cm:[^:]+:m$/.test(key) || /^nl:cm:[^:]+:p:[^:]+$/.test(key),
    find: async (keys) => {
      const members = keys.filter((key) => key.endsWith(":m"));
      const posts = keys.filter((key) => !key.endsWith(":m"));
      const marks = (await stringsOf(posts)).map((raw) => postPicture(raw)).filter(Boolean).map(pictureNoteKey);
      return [...(await fieldsOf(members, "t")).map(communityUnsubKey), ...marks];
    },
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

/** `unfinished`: the stores left in the batch whose records are gone but whose last mark could not be written yet. */
export type WalkReport = { started: boolean; stores: number; pages: number; deleted: number; pruned: number; finished: number; unfinished: number; done: boolean };

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
 * finished every store and emailed its owner while those pages' keys remained. The idle pass wrote the count of
 * stores left as 0 from it too (Claude 5's second money review of #3279). An entry that does not read is kept and
 * counted in `unreadable`, so the count of stores left is never lowered past it.
 */
async function readBatch(): Promise<{ entries: Map<string, Batched>; raws: Map<string, string>; unreadable: number }> {
  const list = stringList(repliesFor(await redisPipeline([["HGETALL", BATCH_KEY]]), 1)?.[0]);
  if (!list || list.length % 2 !== 0) throw new UnknownReplyError("the closing walk's batch (HGETALL)");
  const entries = new Map<string, Batched>();
  // Each entry's text exactly as read, so a change is made only over it (admitDeleted, BATCH_SWAP).
  const raws = new Map<string, string>();
  let unreadable = 0;
  for (let i = 0; i + 1 < list.length; i += 2) {
    const value = json(list[i + 1]) as Batched | null;
    if (value && Array.isArray(value.marks)) {
      entries.set(list[i], value);
      raws.set(list[i], list[i + 1]);
    } else unreadable += 1;
  }
  return { entries, raws, unreadable };
}

/** The entries a walk may walk and finish: never one still pending (Codex on #3643), whose store's record never went by its closing. */
function walkable(entries: Map<string, Batched>): Map<string, Batched> {
  return new Map([...entries].filter(([, entry]) => !entry.pending));
}

/**
 * Takes every pending entry out of the batch (Codex on #3643): one a preparation left when another store was at its
 * key and its own taking-out was never confirmed, or one whose preparation stopped before the record went (that store
 * waits a walk and writes it again). Only while the field still holds the exact text read (WITHDRAW_ENTRY), so an entry
 * written again since is never taken. One script each; true only when every one answered 0 or 1 (rule 24). One not
 * taken out is still never walked, and is tried again on the next run.
 */
async function withdrawPending(batch: { entries: Map<string, Batched>; raws: Map<string, string> }): Promise<boolean> {
  let confirmed = true;
  for (const [field, entry] of batch.entries) {
    if (!entry.pending) continue;
    const raw = batch.raws.get(field);
    const taken = raw === undefined ? null : repliesFor(await redisPipeline([["EVAL", WITHDRAW_ENTRY, 1, BATCH_KEY, field, raw]]).catch(() => null), 1)?.[0];
    if (taken !== 0 && taken !== 1) {
      console.error("a pending closing entry was not confirmed taken out of the batch; it is never walked and is tried again on the next run", taken);
      confirmed = false;
    }
  }
  return confirmed;
}

/**
 * Before a walk starts (Codex L, Codex P and Claude 2 cloud L on #3643): every confirmed entry's record is read
 * exactly. One whose record is confirmed gone is walked. One with anything still kept at its key (its own record, a
 * delete or a rewrite not known to have landed, or another store's) is never walked: it is taken out, only while it
 * still holds the exact text read (WITHDRAW_ENTRY), and its store is put back in line (ZADD NX) to be prepared again.
 * True only when every record read and every taking-out was confirmed; otherwise no walk starts in this run. No
 * preparation runs while a walk is on, so the entries a walk starts with are the ones it finishes. A deleted store's
 * entry (queueDeleted) is never put in the closing line: one still waiting is left to its admission (admitDeleted), and
 * one admitted is walked as before, or by its own ids only when another store's record is at its key.
 */
async function startableBatch(batch: { entries: Map<string, Batched>; raws: Map<string, string> }, now: number): Promise<boolean> {
  let confirmed = true;
  for (const [field, entry] of batch.entries) {
    // A deleted store still waiting (queued) is read by its own admission (admitDeleted), never here: putting it in the
    // closing line would close it instead, and taking its entry out would lose its ids.
    if (entry.pending || entry.unfinished || entry.queued) continue;
    let read: Awaited<ReturnType<typeof storeRecordAt>>;
    try {
      read = await storeRecordAt(entry.ref);
    } catch (error) {
      console.error("a closing store's record could not be read before the walk; no walk starts in this run", error);
      confirmed = false;
      continue;
    }
    if (read.state === "gone") continue;
    const raw = batch.raws.get(field);
    // Its own record (the same id, or, for a store from before ids, the same stats id) is still there: it is taken out
    // and prepared again. Another store's record at its key (Claude 7's ALTO 1 on #3643): this store's record is gone,
    // so its entry stays to be walked by its own ids only, and the other store is never put in line to be closed.
    const own = read.sid === entry.sid || (entry.sid === "" && Boolean(entry.statsId) && read.statsId === entry.statsId);
    if (!own) {
      if (entry.marksOnly) continue;
      const next = JSON.stringify({ ...entry, marksOnly: true });
      const written = raw === undefined ? null : repliesFor(await redisPipeline([["EVAL", REWRITE_ENTRY, 1, BATCH_KEY, field, raw, next]]).catch(() => null), 1)?.[0];
      if (written === 1) {
        batch.entries.set(field, { ...entry, marksOnly: true });
        batch.raws.set(field, next);
        continue;
      }
      console.error("a closing entry with another store at its key was not confirmed set to its own ids; no walk starts in this run", written);
      confirmed = false;
      continue;
    }
    // A deleted store (queueDeleted), admitted once its record read gone, is never put in the closing line: that would
    // close it, with a closing record and an email, though its owner deleted it. Its own record read there again is
    // walked with it, by its ids and its key, as the walk does for every admitted deleted store (admitDeleted).
    if (entry.deleted) continue;
    // Put back in line first, and taken out of the batch only once that is confirmed (Codex L on #3643): the other
    // order, with the ZADD's answer lost, left the store in neither, and its record was never erased. Back in line
    // with its entry still there is safe: the entry is never walked while its record is read there, and it is taken
    // out on this or a later run.
    const back = repliesFor(await redisPipeline([["ZADD", DUE_KEY, "NX", now, entry.ref]]).catch(() => null), 1)?.[0];
    if (back !== 0 && back !== 1) {
      console.error("a closing store whose record is still there was not confirmed put back in line; its entry stays, and no walk starts in this run", back);
      confirmed = false;
      continue;
    }
    const taken = raw === undefined ? null : repliesFor(await redisPipeline([["EVAL", WITHDRAW_ENTRY, 1, BATCH_KEY, field, raw]]).catch(() => null), 1)?.[0];
    if (taken !== 0 && taken !== 1) {
      console.error("a closing entry whose record is still there was not confirmed taken out; no walk starts in this run", taken);
      confirmed = false;
      continue;
    }
    batch.entries.delete(field);
  }
  return confirmed;
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
 * Finishes walked stores, each on its own: one finished leaves the batch. One whose last mark could not be written,
 * such as a closing record that does not read (rule 24, Claude 2's review of #3279), is never taken as finished: it
 * stays in the batch, set aside (`unfinished`) so it holds neither the other stores nor the walks after, and is
 * finished again on the next runs. Answers how many are left so, or null when the run must stop where it is: its
 * deadline passed, or a store's setting aside was not confirmed (it is then finished again where it was).
 */
async function finishStores(entries: Iterable<[string, Batched]>, finish: Finisher, now: number, deadline: number, report: WalkReport): Promise<number | null> {
  let left = 0;
  let confirmed = true;
  for (const [ref, entry] of entries) {
    if (Date.now() > deadline) return null;
    // A deleted store waiting for the next walk was not walked by this one (admitDeleted).
    if (entry.queued) continue;
    // Its last mark is written once: a store kept in the batch only for its hosts' calendars is not told again.
    if (!entry.finished) {
      try {
        // A deleted store has no closing record, and its owner deleted it: only a closed store is finished.
        if (!entry.deleted) await finish(entry, now);
      } catch (error) {
        console.error("a closed store's records are gone but its last mark could not be written; it is finished again on the next run", error);
        left += 1;
        if (entry.unfinished) continue;
        const set = repliesFor(await redisPipeline([["HSET", BATCH_KEY, ref, JSON.stringify({ ...entry, unfinished: now })]]), 1)?.[0];
        if (set !== 0 && set !== 1) confirmed = false;
        continue;
      }
    }
    if (entry.calendars?.length) {
      const undecided = await decideCalendars(entry);
      if (undecided.length) {
        // Still not known (Claude 4 on #3660): the store stays in the batch, set aside and marked finished, with what
        // is left to decide, read again on every run until it is known; never taken as "no other store".
        left += 1;
        // Kept only for that (Claude 1 C3 on #3660): nothing of the store but its ref, its id and its hosts to decide,
        // never its owner's address, name, addresses, marks or stats id, which a walk no longer needs once it is told.
        const slim = !entry.email && !entry.name && !entry.handle && !entry.handles.length && !entry.marks.length && entry.statsId === null;
        if (entry.finished && entry.unfinished && slim && undecided.length === entry.calendars.length) continue;
        const kept: Batched = { ...entry, email: "", name: "", handle: "", handles: [], marks: [], statsId: null, calendars: undecided, finished: entry.finished ?? now, unfinished: entry.unfinished ?? now };
        const set = repliesFor(await redisPipeline([["HSET", BATCH_KEY, ref, JSON.stringify(kept)]]), 1)?.[0];
        if (set !== 0 && set !== 1) confirmed = false;
        continue;
      }
    }
    // Out of the batch only on Redis's own answer (Claude 5 on #3279, rule 30): one still in it, not set aside,
    // would have its ids counted by the next walk. Not known to be out, the run stops here and finishes it again.
    const gone = repliesFor(await redisPipeline([["HDEL", BATCH_KEY, ref]]), 1)?.[0];
    if (gone !== 0 && gone !== 1) {
      console.error("taking a finished store out of the walk's batch was not confirmed; it is finished again on the next run", gone);
      confirmed = false;
      continue;
    }
    report.finished += 1;
  }
  return confirmed ? left : null;
}

/**
 * The hosts of a walked store whose own calendar was kept because whether they serve another store was not known
 * (prepareStore), read again: one known to serve no other store loses their calendar now, one known to serve another
 * keeps it, and one still not known is answered back, to be read again on the next run. A delete not confirmed is not
 * known either (rule 24). The store's record is gone by then, so the store itself is never counted as another.
 */
async function decideCalendars(entry: Batched): Promise<string[]> {
  const undecided: string[] = [];
  for (const email of entry.calendars ?? []) {
    const serves = typeof email === "string" ? await servesAnother(email, entry.sid) : null;
    if (serves === true) continue;
    if (serves === false) {
      // One DEL of the calendar's keys answers how many it removed: only 0 to that many is a count; anything above it
      // proves nothing, and the host is decided again on the next run (Codex U, U-20261119-0633).
      const keys = hostCalendarKeys(hostId(email));
      const reply = repliesFor(await redisPipeline([["DEL", ...keys]]), 1)?.[0];
      if (Number.isSafeInteger(reply) && (reply as number) >= 0 && (reply as number) <= keys.length) continue;
      console.error("deleting a closed store's host's calendar was not confirmed; it is decided again on the next run", reply);
    }
    undecided.push(email);
  }
  return undecided;
}

/**
 * One run: starts a walk when stores are due and none ran in the last
 * WALK_GAP_MS, carries one on to where it stops, and finishes its stores.
 * Bounded by `deadline` and WALK_PAGES_PER_RUN.
 */
export async function eraseClosed(deadline: number, finish: Finisher, now = Date.now()): Promise<WalkReport> {
  const report: WalkReport = { started: false, stores: 0, pages: 0, deleted: 0, pruned: 0, finished: 0, unfinished: 0, done: false };
  if (!isRedisConfigured()) return report;
  // A move back a walk that Redis did not confirm (moveBack): this run is never said to be done.
  let unsure = false;
  // An entry naming another store's key not confirmed out of the batch (EntryNotWithdrawnError): no walk starts in this run.
  let entryLeft = false;
  const [rawState] = await redisPipeline([["HMGET", WALK_KEY, "cursor", "started", "phase", "unfinished"]]);
  const [cursorRaw, startedRaw, phaseRaw, unfinishedRaw] = Array.isArray(rawState) ? rawState.map((v) => (typeof v === "string" ? v : "")) : ["", "", "", ""];
  let phase = phaseRaw || "idle";
  let cursor = cursorRaw || "0";

  if (phase === "idle" || phase === "") {
    // Walked stores left unfinished (finishStores) are finished again on every run until they are, never walked again.
    if (unfinishedRaw !== "" && unfinishedRaw !== "0") {
      const { entries, unreadable } = await readBatch();
      const left = await finishStores([...entries].filter(([, entry]) => entry.unfinished), finish, now, deadline, report);
      if (left === null) return report;
      await redisPipeline([["HSET", WALK_KEY, "unfinished", left + unreadable]]);
      report.unfinished = left + unreadable;
    }
    const started = Number(startedRaw) || 0;
    if (now - started < WALK_GAP_MS) return { ...report, done: true };
    const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, "-inf", now, "LIMIT", 0, BATCH_MAX]]);
    const refs = Array.isArray(due) ? (due as unknown[]).map(String) : [];
    // None due still reads the batch below: a store prepared by a run that stopped before its walk started is walked.
    for (const ref of refs) {
      if (Date.now() > deadline) break;
      // The store's record, read exactly; then whether it is still due (dueForErasure, below). What it holds is deleted
      // only under its own lock, once its record read again there says its plan does not run (prepareStore,
      // closeStoreRecord), each delete fenced by that lock; once prepared, its record is closed and no plan can reach
      // it any more (lib/closing-plan-guard.ts).
      let store: Store | null;
      try {
        store = await storeForRefExact(ref);
      } catch (error) {
        // Not read (rule 24): a failed request, a record that does not parse or one under that key for another owner
        // (storeForRefExact, lib/store.ts) is never "no store". It stays in line, moved back a walk so it does not hold
        // the head of the line, and is prepared once its record reads; only a store Redis says is gone (nil) leaves it.
        console.error("a closed store's record could not be read; it waits for the next walk", error);
        if (!(await moveBack(ref, now))) unsure = true;
        continue;
      }
      if (store) {
        // Still due, read again right before the first destructive step (dueForErasure, #3156): a store with no closing
        // day whose plan did not end, whose ending does not close it, or whose closing record does not say "removed" for
        // that ending is live, and leaves the line untouched; one whose closing day has begun but whose record does not
        // yet say "removed" holds, in line, untouched. A read that does not answer is unknown (rule 24): it waits a walk.
        // A plan started again after this read is caught under the store's lock before anything of it goes
        // (prepareStore, PlanRunsAgainError, #3643).
        let seen: Awaited<ReturnType<typeof dueForErasure>>;
        try {
          seen = await dueForErasure(store, now);
        } catch (error) {
          console.error("whether a closed store is still due could not be read; it waits for the next walk", error);
          if (!(await moveBack(ref, now))) unsure = true;
          continue;
        }
        if (seen.due === "hold") continue;
        if (seen.due === "live") {
          await redisPipeline([["ZREM", DUE_KEY, ref]]);
          continue;
        }
      }
      if (store) {
        let prepared: Batched | null;
        try {
          prepared = await prepareStore(store, now);
        } catch (error) {
          if (error instanceof PlanRunsAgainError) {
            // Its plan runs again (Claude 5's MEDIUM on #3643): out of line, never prepared, as closeOne takes it out.
            // An entry of it left in the batch is never walked while its record stands (startableBatch, withdrawPending).
            console.error("a closing store's plan runs again; it leaves the line, not prepared", error);
            await redisPipeline([["ZREM", DUE_KEY, ref]]);
            continue;
          }
          if (error instanceof EntryNotWithdrawnError) {
            // Never moved back: the record at this key is another store's, which must not be prepared under it.
            console.error("a closing store's walk entry, with another store at its key, was not confirmed taken out; no walk starts in this run", error);
            entryLeft = true;
            unsure = true;
            await redisPipeline([["ZREM", DUE_KEY, ref]]);
            continue;
          }
          // Something it needs could not be read (rule 24), such as a page of a host's claims: never taken as
          // "nothing". It waits a walk, as above, and is prepared again (prepareStore is safe to repeat); its hosts'
          // claims go on from where this walk stopped (clearClaims), so a store with more than a walk reads still
          // gets prepared.
          console.error("a closed store could not be prepared; it waits for the next walk", error);
          if (!(await moveBack(ref, now))) unsure = true;
          continue;
        }
        // prepareStore wrote the walk's entry before it closed the record; none when another store is kept at its key.
        if (prepared) report.stores += 1;
      }
      await redisPipeline([["ZREM", DUE_KEY, ref]]);
    }
    if (entryLeft) return { ...report, done: false };
    // A pending entry never starts a walk (Codex on #3643): it is taken out here, on this run and the next ones until
    // Redis confirms it, and one not confirmed out leaves the run unsure.
    const first = await readBatch();
    if (!(await withdrawPending(first))) unsure = true;
    // Deleted stores waiting since the last walk join this one, once their records are gone (admitDeleted).
    const admission = await admitDeleted(first.entries, first.raws, now, deadline);
    report.stores += admission.admitted;
    if (!admission.sure) unsure = true;
    // Read again: the admission rewrote its entries (BATCH_SWAP), and startableBatch changes an entry only over its
    // exact text. Only entries whose record is confirmed gone are walked; anything not known stops the walk from starting.
    const waiting = await readBatch();
    if (!(await startableBatch(waiting, now))) return { ...report, done: false };
    // Only a store not walked yet starts a walk: one left unfinished is finished again above, never walked again; one
    // still pending or waiting to be admitted is not walked.
    if (![...waiting.entries.values()].some((entry) => !entry.unfinished && !entry.pending && !entry.queued)) return { ...report, done: !unsure };
    await redisPipeline([["HSET", WALK_KEY, "phase", "walk", "cursor", "0", "started", now]]);
    phase = "walk";
    cursor = "0";
    report.started = true;
  }

  const read = await readBatch();
  const batch = walkable(read.entries);
  const { unreadable } = read;
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
    // Each store on its own (finishStores): one whose mark cannot be written never keeps the walk in this phase.
    const left = await finishStores(batch, finish, now, deadline, report);
    if (left === null) return report;
    await redisPipeline([["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "finished", now, "unfinished", left + unreadable]]);
    report.unfinished = left + unreadable;
    report.done = !unsure && !(left + unreadable);
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
 *
 * The search asks only for what can still charge (Stripe's search query
 * language: clauses joined by AND, one negated by a leading "-"; status is a
 * subscription search field): an ended one never comes back, so a store that
 * sold thousands over its life is not read past the same first pages on
 * every run (Claude 2 on #3332), and each run starts again from the first
 * page with what is left. A member stopped leaves that search, and a page may
 * be cut short by the ones that just left it; so a pass of several pages that
 * found any of the store's subscriptions is not taken for the last, and the
 * handle is done only on a pass of one page, or a pass that found none.
 * At the most, for N running on a handle and a run never out of time, each
 * run reading at most RENEWAL_SEARCH_ROUNDS (50) pages of 100 a handle:
 * pages that stay put take ceil(N / 5,000) runs, and one more that finds
 * none; pages cut by an offset into what the search matches now still stop
 * at least half of what is left (up to 5,000) on each run, so 5,000 running
 * take 6 runs (tests/closed-store-renewals-exact.test.ts). Ended ones cost
 * no search at all.
 */
export async function stopRenewals(store: Store, until: number): Promise<{ done: boolean; stopped: number; subs: string[] }> {
  const account = store.stripeAccountId;
  const out = { done: true, stopped: 0, subs: [] as string[] };
  if (!account) return out;
  for (const handle of saleHandles(store)) {
    let page = "";
    let reachedEnd = false;
    // Pages read, and the store's own subscriptions they held, on this handle's pass.
    let read = 0;
    let found = 0;
    for (let round = 0; round < RENEWAL_SEARCH_ROUNDS; round += 1) {
      if (Date.now() > until) return { ...out, done: false };
      const query = encodeURIComponent(`metadata['store']:'${handle}' AND -status:'canceled' AND -status:'incomplete_expired'`);
      const reply = await onAccount("GET", account, `/subscriptions/search?limit=100&query=${query}${page ? `&page=${encodeURIComponent(page)}` : ""}`);
      // Read in its exact shape (rule 24/30, lib/stripe-list.ts): a reply with no `data` list or no boolean `has_more`
      // is not "nothing to stop". It throws StripeListUnreadable, the closing day is held and the search asked again,
      // so no member goes on being charged after the store closed (until 9 November 2026 it was read as an empty list).
      const listed = readStripePage(reply, renewalRowReadable, RENEWAL_ID);
      read += 1;
      // A row that cannot be read may be a running member: the pass is not done (the readable ones are still stopped).
      if (listed.unreadable > 0) {
        console.error(`plan-closing: Stripe's search gave ${listed.unreadable} subscription(s) that could not be read; asked again`);
        out.done = false;
      }
      const toStop: string[] = [];
      for (const sub of listed.rows) {
        // Only the store's own sales of the handle searched (rule 30, as lib/closing-holds.ts): another's is never ended.
        // Another's only when it names another store as text (Codex CX1 on #3332): a store that is not named, or not as
        // text, is not known, so nothing is ended on a guess and the pass is not done, asked again on the next run.
        const named = (ownField(sub, "metadata") as Record<string, unknown>).store;
        if (typeof named !== "string" || !named) {
          // Ended already (the search catches up within moments): whoever's it is, nothing to stop.
          if (["canceled", "incomplete_expired"].includes(ownField(sub, "status") as string)) continue;
          console.error("plan-closing: Stripe's search gave a running subscription whose store is not known; asked again");
          out.done = false;
          continue;
        }
        if (named !== handle) {
          console.error("plan-closing: Stripe's search gave a subscription of another store; left alone");
          continue;
        }
        found += 1;
        // Ended already, though the search, which catches up within moments, still gave it: nothing to stop.
        if (["canceled", "incomplete_expired"].includes(ownField(sub, "status") as string)) continue;
        out.subs.push(sub.id);
        toStop.push(sub.id);
      }
      for (let i = 0; i < toStop.length; i += RENEWALS_AT_ONCE) {
        if (Date.now() > until) return { ...out, done: false };
        await Promise.all(toStop.slice(i, i + RENEWALS_AT_ONCE).map((id) =>
          onAccount("DELETE", account, `/subscriptions/${encodeURIComponent(id)}`, undefined, undefined, `closed-now:${id}`)));
        out.stopped += Math.min(RENEWALS_AT_ONCE, toStop.length - i);
      }
      if (!listed.hasMore) {
        reachedEnd = true;
        break;
      }
      // More follow and the page does not say where: not the end, never read as one.
      const next = ownField(reply as Record<string, unknown>, "next_page");
      if (typeof next !== "string" || !next) {
        console.error("plan-closing: Stripe's search said more subscriptions follow but not where; asked again");
        return { ...out, done: false };
      }
      page = next;
    }
    // The run's pages ran out before the search's did: the rest are asked for on the next run, from the first page,
    // which no longer holds the ones stopped. The store's other handles are still searched on this run.
    if (!reachedEnd) out.done = false;
    // Several pages, and some of them held the store's subscriptions: a later page may have been cut short by the ones
    // that left the search, so the end reached is not known to be the last. The next run's search must find none.
    else if (read > 1 && found > 0) out.done = false;
  }
  return out;
}

/** Pages of one handle's search read in one run; past them the pass is not done and the next run starts again from the first. */
const RENEWAL_SEARCH_ROUNDS = 50;
/** A subscription id as Stripe writes it; it goes into the DELETE's path. */
const RENEWAL_ID = /^sub_[A-Za-z0-9]{1,250}$/;
/** A search row counts only with its status in text and its metadata as an object (to tell its store). */
function renewalRowReadable(row: Record<string, unknown>): boolean {
  return typeof ownField(row, "status") === "string" && plainObject(ownField(row, "metadata"));
}

