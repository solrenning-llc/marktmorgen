/**
 * The five-minute job's part in Google Meet and Zoom meetings for calls
 * (lib/meet-links.ts): trying again what failed, and hearing about refunds.
 *
 * Tries again. Every record with something left to do — a meeting that
 * could not be made, a move or a removal the provider did not take, a guest
 * list to put right — is in one queue, by when its next try is due
 * (lib/meet-records.ts). Up to BATCH are taken per run. A meeting made at
 * last, more than two hours before its call, replaces the link the people
 * booked were given, and each of them is emailed the new one with a
 * calendar file that replaces the old (lib/calls.ts, tellNewLink).
 *
 * A community live event's meeting (lib/event-meetings.ts) is in the same
 * queue. Before its try, the event is read: one that was cancelled, taken
 * away or moved to another place has its meeting removed instead. Nobody is
 * emailed when an event's meeting is made late: nobody was given a link yet
 * (an event's way in is only on its page, fifteen minutes before), and the
 * page reads the record.
 *
 * Refunds. A booking refunded in full in the creator's Stripe account has
 * its meeting removed (a one-to-one call) or its buyer taken off the guest
 * list (a group). Refunds are read from Stripe, as the license keys read
 * them (lib/licence-keys.ts): only for stores with meetings still to come,
 * from where the last run stopped, a bounded number per run, each once. A
 * partial refund changes nothing, the rule every other door follows
 * (lib/refunds.ts).
 *
 * Only money gone back for good ends a meeting (the owner's decision 18,
 * 9 November 2026: a full refund that succeeded, or a dispute lost). A full
 * refund still on its way (pending, or waiting on an action) may still fail:
 * when it is a call's it ends nothing, is marked as a call's (so it is not
 * looked up again) and keeps the anchor at its time, so the next pass reads
 * it again; one on its way for more than seven days is said in the log once a
 * day, never taken for that; one that is not a call's is read and holds
 * nothing. A refund that failed or was canceled ends nothing. A full refund
 * made of parts ends the meeting only once the parts that succeeded add up to
 * the charge (read from the charge's own refunds, as lib/licence-keys.ts does
 * on #2868). The refunds are read in a pass that goes on from where the last
 * run stopped (A3), so a refund held for later is read again however many
 * newer refunds came after it, and the anchor is written again at the end of
 * every pass, so it never lapses while one holds it.
 *
 *   nl:meet:rf:<callsId>:since         the time refunds were read up to, in seconds
 *   nl:meet:rf:<callsId>:seen          refunds already read, and `call:<id>` for a call's refund held for later
 *   nl:meet:rf:<callsId>:pass          where a pass over the refunds stands
 *   nl:meet:rf:<callsId>:said:<charge> a call's refund pending more than seven days was said today
 */
import { whereOf } from "@/lib/call-place";
import { saleHandles } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isSenderConfigured } from "@/lib/email";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { type LostRead, confirmLostRead, lostCursorKey, lostDisputesOrRetry, refundRowKnown, refundedInFull, rowGivesBack } from "@/lib/refunds";
import { STRIPE_LIST_VERSION, StripeListUnreadable, ownField, plainObject, readStripePage, type StripePage } from "@/lib/stripe-list";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { readListing } from "@/lib/catalog";
import { markBookingsChanged, readMoves } from "@/lib/call-records";
import { readRecord } from "@/lib/meet-records";
import { MEET_STORES, callRefunded, dropScope, dueScopes, retryRecord } from "@/lib/meet-links";
import { type PaidCall, isCallProduct, paidCalls, tellNewLink } from "@/lib/calls";
import { eventStillWants, readEventScope } from "@/lib/event-meetings";
import type { Store } from "@/lib/store";
import { isClaimId, isHostId, releaseClaim } from "@/lib/host-claims";

const BATCH = 40;
const REFUND_STORES = 20;
const REFUND_PAGES = 2;
const REFUND_LOOKUPS = 10;
const REFUND_KEEP_SECONDS = 30 * 86_400;
const INTENT = /^pi_[A-Za-z0-9]{6,200}$/;

/**
 * A refund still on its way this long is said in the log, and still ends nothing (the owner's decision 18: a refund
 * pending for many days raises an alert, never a revocation). Said from the log alone: no store command, no email.
 */
const REFUND_STUCK_SECONDS = 7 * 86_400;

// The reading of a refund in parts below is a copy of the one on #2868 (lib/licence-keys.ts, wholeOnItsOwn and
// chargeRefundsSettled) and on claude5/group-buy-cursor-account (lib/group-buy.ts), not yet on main: once they are, one
// shared function in lib/refunds.ts should take the place of every copy.
/** The most refunds of one charge read in one GET /refunds?charge= (one page; more than that is unknown). */
const CHARGE_REFUNDS_PAGE = 100;
const CHARGE_PATTERN = /^(ch|py)_[A-Za-z0-9]{6,255}$/;
/** Statuses a refund still on its way has: it may yet fail, and Stripe already counts it in amount_refunded. */
const REFUND_ON_ITS_WAY = new Set(["pending", "requires_action"]);
const REFUND_STATUS_KNOWN = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);
const centsKnown = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Whether a succeeded refund whose charge reads refunded in full gave the whole charge back by itself: its own amount
 * covers the charge's. Only then is no other refund of the charge needed to say the money went back for good.
 */
function wholeOnItsOwn(refund: Record<string, unknown>): boolean {
  const charge = refund.charge;
  if (!plainObject(charge)) return false;
  const amount = ownField(charge, "amount");
  return centsKnown(refund.amount) && centsKnown(amount) && amount > 0 && refund.amount >= amount;
}

/**
 * A full refund made of several refunds of one charge, read from all of that charge's refunds (one GET /refunds?charge=,
 * Stripe's own list): "held" while any is still on its way (it may still fail, and Stripe counts it in the charge's
 * amount_refunded already), "through" when the ones that succeeded add up to the whole charge. Anything else (no
 * charge id, a row or a list in another shape, more than one page, or succeeded refunds that do not add up although
 * the charge reads refunded in full) throws StripeListUnreadable: never "nothing pending" (CX-123 rule 24).
 */
async function chargeRefundsSettled(account: string, refund: Record<string, unknown>): Promise<"held" | "through"> {
  const charge = refund.charge;
  const id = plainObject(charge) ? ownField(charge, "id") : undefined;
  const amount = plainObject(charge) ? ownField(charge, "amount") : undefined;
  if (typeof id !== "string" || !CHARGE_PATTERN.test(id) || !centsKnown(amount) || amount <= 0) {
    throw new StripeListUnreadable("a refund's charge without its id or amount");
  }
  const legible = (row: Record<string, unknown>) => {
    const status = ownField(row, "status");
    const named = ownField(row, "charge");
    const chargeId = typeof named === "string" ? named : plainObject(named) ? ownField(named, "id") : undefined;
    return typeof status === "string" && REFUND_STATUS_KNOWN.has(status) && centsKnown(ownField(row, "amount")) && chargeId === id;
  };
  const listed = readStripePage(
    await onAccount("GET", account, `/refunds?${new URLSearchParams({ charge: id, limit: String(CHARGE_REFUNDS_PAGE) })}`, undefined, STRIPE_LIST_VERSION),
    legible,
  );
  if (listed.unreadable > 0 || listed.hasMore) throw new StripeListUnreadable("a charge's refunds");
  // The refund being read is one of them, as it now stands: if Stripe's list does not have it, the list proves nothing.
  if (!listed.rows.some((row) => row.id === refund.id)) throw new StripeListUnreadable("a charge's refunds without the one read");
  if (listed.rows.some((row) => REFUND_ON_ITS_WAY.has(ownField(row, "status") as string))) return "held";
  const through = listed.rows.reduce((sum, row) => sum + (ownField(row, "status") === "succeeded" ? (ownField(row, "amount") as number) : 0), 0);
  if (through >= amount) return "through";
  throw new StripeListUnreadable("a charge read refunded in full whose succeeded refunds do not add up");
}

const anchorKey = (callsId: string) => `nl:meet:rf:${callsId}:since`;
const seenKey = (callsId: string) => `nl:meet:rf:${callsId}:seen`;

export type MeetingsRun = { done: number; failed: number; switched: number; told: number; refunds: number };

export async function syncMeetings(
  findStore: (handle: string) => Promise<Store | null>,
  deadline: number,
  origin: string,
): Promise<MeetingsRun> {
  const run: MeetingsRun = { done: 0, failed: 0, switched: 0, told: 0, refunds: 0 };
  if (!isRedisConfigured()) return run;
  const stores = new Map<string, Store | null>();
  const paid = new Map<string, PaidCall[] | null>();
  const storeFor = async (handle: string) => {
    if (!stores.has(handle)) stores.set(handle, await findStore(handle).catch(() => null));
    return stores.get(handle) ?? null;
  };
  const paidFor = async (store: Store) => {
    if (!paid.has(store.handle)) paid.set(store.handle, await paidCalls(store).catch(() => null));
    return paid.get(store.handle) ?? null;
  };

  for (const scope of await dueScopes(BATCH)) {
    if (Date.now() > deadline) break;
    const record = await readRecord(scope);
    if (!record) {
      await dropScope(scope);
      continue;
    }
    const store = await storeFor(record.handle);
    if (!store || store.statsId !== record.statsId || (record.callsId && store.callsId !== record.callsId)) {
      // The store is gone or is somebody else's now: nothing we may do with it.
      await dropScope(scope);
      continue;
    }
    const event = readEventScope(scope) !== null;
    if (event) {
      const wants = await eventStillWants(store, record).catch((error) => {
        console.error("reading a live event for its meeting failed", error);
        return "retry" as const;
      });
      if (wants === "drop") {
        await dropScope(scope);
        continue;
      }
      if (wants === "done") {
        run.done += 1;
        continue;
      }
    }
    // Who was given the link, for a late switch: unknowable without Stripe,
    // and nobody can be told without email, so neither switches anything.
    // Nobody was given an event's link yet (lib/event-meetings.ts).
    const people = async () => {
      if (event) return 0;
      if (!isSenderConfigured()) return Number.POSITIVE_INFINITY;
      const list = await paidFor(store);
      if (!list) return Number.POSITIVE_INFINITY;
      return list.filter((c) => (record.group ? c.product === record.product && c.start === record.start : c.session === record.session)).length;
    };
    const outcome = await retryRecord(store, scope, people).catch((error) => {
      console.error("retrying a meeting failed", error);
      return null;
    });
    if (!outcome) continue;
    if (outcome.kind === "done") run.done += 1;
    if (outcome.kind === "failed") run.failed += 1;
    if (outcome.kind === "switched") {
      run.switched += 1;
      if (event) continue;
      const list = (await paidFor(store)) ?? [];
      const product = await readListing(store, record.product);
      const booked = list.filter((c) =>
        outcome.record.group ? c.product === outcome.record.product && c.start === outcome.record.start : c.session === outcome.record.session,
      );
      // In person now (lib/call-place.ts): no link is sent to anybody.
      if (product && isCallProduct(product) && whereOf(product.call).kind !== "place" && booked.length) {
        run.told += await tellNewLink({ store, product, meeting: outcome.record, previous: outcome.previous, people: booked, origin }).catch(() => 0);
      }
    }
  }

  if (Date.now() < deadline) run.refunds = await readRefunds(storeFor, deadline).catch((error) => {
    console.error("reading refunds for meetings failed", error);
    return 0;
  });
  return run;
}

/** Refunds in full since the last run, for every store with meetings still to come. */
async function readRefunds(storeFor: (handle: string) => Promise<Store | null>, deadline: number): Promise<number> {
  const now = Date.now();
  // Stores whose last meeting is over leave the list.
  const [old] = await redisPipeline([["ZRANGEBYSCORE", MEET_STORES, 0, now - 86_400_000, "LIMIT", 0, 100]]);
  const stale = Array.isArray(old) ? (old as unknown[]).map(String) : [];
  if (stale.length) await redisPipeline([["ZREM", MEET_STORES, ...stale]]);
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", MEET_STORES, now - 86_400_000, now + 400 * 86_400_000, "LIMIT", 0, REFUND_STORES]]);
  const members = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  let handled = 0;
  for (const member of members) {
    if (Date.now() > deadline) break;
    const [callsId, handle] = member.split("|");
    const store = callsId && handle ? await storeFor(handle) : null;
    if (!store || store.callsId !== callsId || !store.stripeAccountId) continue;
    handled += await refundsOf(store, callsId, deadline).catch((error) => {
      console.error("reading a store's refunds for meetings failed", error);
      return 0;
    });
  }
  return handled;
}

/** How long a pass is kept without moving: well past the runs it takes; one left behind starts again from the anchor. */
const REFUND_PASS_SECONDS = 7 * 86_400;
/** A refund's id as the pass keeps it, to read on from (Stripe's `starting_after`). */
const REFUND_CURSOR = /^[A-Za-z0-9_]{3,255}$/;
/**
 * The Redis commands one run of the meetings' refund job sends for its place in a store's refunds, outside the rows it
 * reads (pre-review of claude5/call-refunds-confirmed; Claude 5's audit of the Stripe reads, A3): one GET of the anchor
 * and one of the pass, then at most three writes: at the end of a pass the anchor written, the read set's expiry
 * renewed and the pass deleted; otherwise the pass kept (or deleted when Stripe no longer knows its place) and the
 * anchor and the read set either written (a store with none yet) or their expiry renewed, so a refund held for later
 * never lets them lapse. The pass is one key a store, under 400 bytes, kept REFUND_PASS_SECONDS.
 */
export const MEET_REFUND_PLACE_COMMANDS = 5;
/**
 * The refunds of one charge read in one run (one GET /refunds?charge= each, for a call's refund that succeeded on a
 * charge read refunded in full without covering it by itself; each charge read once a run): past it, the refund is
 * held for the next pass. Apart from REFUND_LOOKUPS, so a part held for later never takes the lookups of new refunds.
 * A scheduled job bounded by its schedule; Stripe bills no API call and no store command is sent for it.
 */
export const MEET_CHARGE_READS = 10;
/**
 * The Redis commands one refund row of the meetings' refund job sends at the most, outside the meeting's own closing
 * writes (callRefunded, markBookingsChanged, releaseClaim, as before): one SMISMEMBER of the read set (read before, and
 * the call mark of a refund held for later), then one write of three commands (SADD and EXPIRE of the read set, and the
 * SREM of the call mark once it is handled; or SADD and EXPIRE of the call mark of one held for later), and one SET NX
 * of the day's alert for a call's refund on its way more than seven days (at most once a day a charge).
 */
export const MEET_REFUND_ROW_COMMANDS = 5;

/** The call mark in the read set: a refund on its way, or a part not settled, already known to be a call's. */
const callMark = (id: string) => `call:${id}`;
const passKey = (callsId: string) => `nl:meet:rf:${callsId}:pass`;
/** One a charge and day: a call's refund on its way more than seven days is said once a day (SET NX EX). */
const alertKey = (callsId: string, charge: string) => `nl:meet:rf:${callsId}:said:${charge}`;

/**
 * A pass over the refunds: `from` the anchor it began at (the window starts 300 seconds before), `start` when it began
 * (the anchor never moves past it), `after` the last refund it read to the end, `newest` the latest refund it read,
 * and `floor` the earliest one it left for later (null when none), below which the anchor stays.
 */
type RefundPass = { from: number; start: number; after: string; newest: number; floor: number | null };
const passSeconds = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A kept pass read exactly; anything else is no pass, and a new one starts from the anchor, which never moved past it. */
function readRefundPass(raw: unknown): RefundPass | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!plainObject(value)) return null;
  const from = ownField(value, "from");
  const start = ownField(value, "start");
  const after = ownField(value, "after");
  const newest = ownField(value, "newest");
  const floor = ownField(value, "floor");
  if (!passSeconds(from) || !passSeconds(start) || !passSeconds(newest) || (floor !== null && !passSeconds(floor))) return null;
  if (typeof after !== "string" || !REFUND_CURSOR.test(after) || start < from || newest < from) return null;
  return { from, start, after, newest, floor };
}

/**
 * One store's refunds since its anchor, read in a pass that may take several runs (as lib/review-proof.ts does, A3):
 * where the pass stands is kept, so the next run goes on from the last refund read instead of the newest pages again,
 * and a run that resumes a pass first reads the newest page, so a refund made meanwhile does not wait for the pass.
 *
 * The owner's decision 18 (9 November 2026): a meeting ends only once the money went back for good. A refund on its way
 * (whatever its charge reads now) is looked up once: when it is a call's, it is marked as one in the read set and
 * held (the anchor stays at or below it, so the next pass reads it again; no lookup again); when not, it is read. A
 * succeeded part of a call's charge waits for the charge's refunds to add up, from its own MEET_CHARGE_READS. A refund
 * that failed or was canceled ends nothing. A call's refund on its way more than seven days is said once a day.
 */
async function refundsOf(store: Store, callsId: string, deadline: number): Promise<number> {
  const account = store.stripeAccountId as string;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [anchorRaw, passRaw] = await redisPipeline([["GET", anchorKey(callsId)], ["GET", passKey(callsId)]]);
  // The first look goes back a day: meetings are only made from now on, and
  // a refund made before one existed has nothing to remove.
  const anchor = Number(anchorRaw) > 0 ? Number(anchorRaw) : nowSeconds - 86_400;
  const kept = readRefundPass(passRaw);
  const pass: RefundPass = kept ? { ...kept } : { from: anchor, start: nowSeconds, after: "", newest: anchor, floor: null };
  // A little overlap, so a refund created in the second the last pass read is not missed; the read set keeps it from
  // counting twice.
  const since = Math.max(0, pass.from - 300);
  const handles = saleHandles(store);
  let lookups = REFUND_LOOKUPS;
  let chargeReads = MEET_CHARGE_READS;
  /** Each charge's refunds read once a run, whatever number of its parts are read. */
  const charges = new Map<string, "held" | "through" | "unknown">();
  let handled = 0;
  /** The anchor stays at or below a refund of this pass left for later: the next pass reads it again. */
  const hold = (created: number) => {
    pass.floor = pass.floor === null ? created : Math.min(pass.floor, created);
  };
  const keepSeen = (): (string | number)[] => ["EXPIRE", seenKey(callsId), REFUND_KEEP_SECONDS * 2 + 86_400];

  /** A succeeded part of a charge read refunded in full: "through" only once the charge's succeeded refunds add up. */
  const settle = async (refund: Record<string, unknown>): Promise<"held" | "through" | "unknown"> => {
    const charge = plainObject(refund.charge) ? ownField(refund.charge, "id") : undefined;
    const known = typeof charge === "string" ? charges.get(charge) : undefined;
    if (known) return known;
    if (chargeReads <= 0) return "unknown";
    chargeReads -= 1;
    const result = await chargeRefundsSettled(account, refund).catch((error: unknown) => {
      if (!(error instanceof StripeListUnreadable) && !(error instanceof StripeError)) throw error;
      console.error("reading the refunds of a refunded charge for meetings failed; held for the next pass", store.handle, error);
      return "unknown" as const;
    });
    if (typeof charge === "string") charges.set(charge, result);
    return result;
  };

  /** A call's refund still on its way after REFUND_STUCK_SECONDS: said in the log at most once a day a charge. */
  const sayStuck = async (refund: Record<string, unknown>, created: number) => {
    if (created > nowSeconds - REFUND_STUCK_SECONDS) return;
    const charge = plainObject(refund.charge) ? ownField(refund.charge, "id") : undefined;
    if (typeof charge !== "string" || !CHARGE_PATTERN.test(charge)) return;
    const [first] = await redisPipeline([["SET", alertKey(callsId, charge), "1", "NX", "EX", 86_400]]);
    if (first !== "OK") return;
    // An alert for whoever reads the logs, never a revocation: the meeting stays until the refund succeeded.
    console.error("a refund for a call has been pending for more than seven days; its meeting is kept until it succeeds", { store: store.handle, account, refund: refund.id, charge, status: refund.status, created });
  };

  /** Rows read in their exact shape; false when the run's time ran out first, so the page is read again. */
  const take = async (rows: Record<string, unknown>[], inPass: boolean): Promise<boolean> => {
    for (const refund of rows) {
      if (Date.now() >= deadline) return false;
      const id = refund.id as string;
      const created = refund.created as number;
      const passed = () => {
        if (inPass) pass.newest = Math.max(pass.newest, created);
      };
      // Held for later, read again by the next pass: the newest page a resuming run reads first never moves the pass
      // (a refund of the pass's window is held when the pass reads it, and a newer one is in the next pass's window).
      const later = () => {
        if (inPass) hold(created);
      };
      const dispute = refund.object === "dispute";
      // A refund still on its way may still fail, and may still give the whole charge back once it goes through: nothing
      // says Stripe already counts it in the charge's amount_refunded (main's #3188 reads it the other way), so every one
      // is held when it is a call's, whatever its charge reads now (the owner's decision 18; 2nd pre-review of
      // 779bcbfc0d). A succeeded one ends a meeting only on a charge read refunded in full.
      const onItsWay = !dispute && REFUND_ON_ITS_WAY.has(refund.status as string);
      const givesBack = dispute ? rowGivesBack(refund) : onItsWay || (refund.status === "succeeded" && refundedInFull(refund.charge));
      if (!givesBack) {
        passed();
        continue;
      }
      const flags = repliesFor(await redisPipeline([["SMISMEMBER", seenKey(callsId), id, callMark(id)]]), 1)?.[0];
      if (!Array.isArray(flags) || flags.length !== 2) throw new UnknownReplyError("the refunds already read");
      if (Number(flags[0]) === 1) {
        passed();
        continue;
      }
      const knownCall = Number(flags[1]) === 1;
      const intent = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
      if (!INTENT.test(intent)) {
        // No payment to look up (a charge made without one): no booking can be told from it, so it is read, and a
        // lost dispute like it never holds the place back (review of #2158).
        await redisPipeline([["SADD", seenKey(callsId), id], keepSeen()]);
        passed();
        continue;
      }
      // A call's refund already held for later: no lookup until it went through.
      if (knownCall && onItsWay) {
        await sayStuck(refund, created);
        later();
        continue;
      }
      const part = !dispute && !onItsWay && !wholeOnItsOwn(refund);
      if (knownCall && part && (await settle(refund)) !== "through") {
        later();
        continue;
      }
      if (lookups <= 0) {
        later();
        continue;
      }
      lookups -= 1;
      const sessions = await onAccount("GET", account, `/checkout/sessions?${new URLSearchParams({ payment_intent: intent, limit: "1" })}`);
      const session = (Array.isArray(sessions.data) ? (sessions.data as Record<string, unknown>[]) : [])[0];
      const meta = ((session?.metadata ?? {}) as Record<string, string>) ?? {};
      const isCall = !!session && typeof session.id === "string" && meta.kind === "call" && handles.has(meta.store ?? "");
      if (!isCall) {
        // Not a call of this store: nothing to end, whatever becomes of the refund.
        await redisPipeline([["SADD", seenKey(callsId), id], keepSeen()]);
        passed();
        continue;
      }
      // A call's refund that has not gone back for good: marked as a call's, so it is not looked up again, and held.
      // A succeeded part of a charge read refunded in full (Stripe counts a refund still pending in amount_refunded)
      // waits for the charge's succeeded refunds to add up; one of them on its way, or refunds that do not read, hold it.
      if (onItsWay || (part && !knownCall && (await settle(refund)) !== "through")) {
        await redisPipeline([["SADD", seenKey(callsId), callMark(id)], keepSeen()]);
        if (onItsWay) await sayStuck(refund, created);
        later();
        continue;
      }
      const sessionId = session.id as string;
      const moved = (await readMoves([sessionId])).get(sessionId);
      const start = moved ? moved.s : Number(meta.start);
      const details = (session.customer_details ?? {}) as { email?: unknown };
      if (Number.isFinite(start) && (await callRefunded(store, { session: sessionId, product: meta.product ?? "", start, email: typeof details.email === "string" ? details.email : null }))) {
        handled += 1;
      }
      // A call refunded in full leaves the private calendar feed (lib/calls.ts, callFromRow, drops a payment
      // refunded in full): marked, its file is made again at the app's next check, not a day later, with or
      // without a meeting room (inbox C4-18, M3). A lost dispute is not marked: the feed reads the payment, which a
      // lost dispute does not show as refunded, so the booking stays there until lib/calls.ts reads it.
      if (!dispute) {
        await markBookingsChanged(callsId).catch((error: unknown) => console.error("marking the bookings changed failed", error));
      }
      // A team booking refunded in full gives its hosts their time back, on every store.
      const hosts = (meta.hosts ?? "").split(",").filter(isHostId);
      if (hosts.length && isClaimId(meta.claim)) await releaseClaim(hosts, meta.claim).catch(() => {});
      await redisPipeline([["SADD", seenKey(callsId), id], ["SREM", seenKey(callsId), callMark(id)], keepSeen()]);
      passed();
    }
    return true;
  };

  /**
   * One page of refunds from `after` (the newest when empty), each row by the refunds' own rule (refundRowKnown,
   * lib/refunds.ts: its id, time, status, payment and charge.refunded as Stripe gives them); null when the page itself
   * is in another shape, which is not "no refunds".
   */
  const readPage = async (after: string): Promise<StripePage | null> => {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (after) query.set("starting_after", after);
    try {
      return readStripePage(await onAccount("GET", account, `/refunds?${query}`), refundRowKnown);
    } catch (error) {
      if (!(error instanceof StripeListUnreadable)) throw error;
      console.error("reading refunds for meetings: a page in another shape", error);
      return null;
    }
  };

  // A dispute closed as lost ends the booking's meeting as a full refund does (lib/refunds.ts, queue 388 [TB14]): read
  // once a run, with the first page of refunds that reads, from Stripe's closing events (kept thirty days), from their
  // own kept place in the same window.
  let lost: LostRead | null = null;
  /** False when the run's time ran out before the lost disputes were all handled. */
  const readLost = async (): Promise<boolean> => {
    if (lost) return true;
    const read = await lostDisputesOrRetry(account, since, deadline, lostCursorKey("meet", callsId));
    lost = read;
    return take(read.rows, true);
  };

  let ended = false;
  // A cursor Stripe answers it does not know: the pass starts again from the anchor, which never moved past it.
  let restart = false;
  let pages = REFUND_PAGES;
  if (pass.after && Date.now() < deadline) {
    // Resuming a pass: the newest refunds first, so one made meanwhile does not wait for the pass to end.
    pages -= 1;
    const top = await readPage("");
    if (top && (await readLost())) await take(top.rows, false);
  }
  for (let page = 0; page < pages && Date.now() < deadline; page += 1) {
    let listed: StripePage | null;
    try {
      listed = await readPage(pass.after);
    } catch (error) {
      if (!pass.after || !(error instanceof StripeError) || (error.status !== 400 && error.status !== 404)) throw error;
      console.error("a store's kept place in its refunds for meetings is not known to Stripe; read again from the anchor", error);
      restart = true;
      break;
    }
    // A page in another shape: the pass stays where it is and reads it again.
    if (!listed) break;
    if (!(await readLost())) break;
    // A row that cannot be read proves nothing (a pending refund with no time among them): the pass reads on past it,
    // but the anchor stays where this pass began, so the next pass reads it again. The readable rows are still read.
    if (listed.unreadable > 0) hold(since);
    // The run's time ran out inside the page: the pass stays where it was and reads the page again.
    if (!(await take(listed.rows, true))) break;
    if (!listed.hasMore) {
      ended = true;
      break;
    }
    // The pass goes on from the last row that reads; a page with no row that reads leaves the rest unknown.
    const last = listed.rows.at(-1);
    if (!last) break;
    pass.after = last.id;
  }

  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead), every run.
  // Set inside readLost, which the type checker does not follow.
  const lostRead = lost as LostRead | null;
  const lostKept = lostRead ? await confirmLostRead(lostRead, seenKey(callsId)) : false;
  if (ended) {
    // The end of a pass: the anchor moves to the newest refund it read (a sweep of the lost disputes that went on from a
    // kept place no further than the newest closing it read, so a dispute closed meanwhile is read from the top next
    // run; review of #2158, inbox C4-24), never past when the pass began, nor past a refund it held for later or left
    // unknown, nor at all while the lost disputes were not all read and handled. It is written every time, also where
    // it stays, so a refund held for later never lets it lapse (pre-review of claude5/call-refunds-confirmed).
    let top = pass.newest;
    if (!lostRead || !lostKept || !lostRead.complete) hold(since);
    else top = lostRead.resumed ? lostRead.newest : Math.max(top, lostRead.newest);
    const moved = Math.max(pass.from, Math.min(top, pass.start, pass.floor ?? Number.POSITIVE_INFINITY));
    await redisPipeline([["SET", anchorKey(callsId), String(moved), "EX", REFUND_KEEP_SECONDS * 2], keepSeen(), ["DEL", passKey(callsId)]]);
    return handled;
  }
  // A pass not at its end is kept only when it moved, so one that cannot move lapses and starts again from the anchor.
  // A store with no anchor yet keeps the one its pass began at, so the next run reads the same window and the lost
  // disputes' kept place still counts; one with an anchor has it and its read set kept as long (reviews of #2158).
  const next = JSON.stringify(pass);
  const writes: (string | number)[][] = [];
  if (restart) writes.push(["DEL", passKey(callsId)]);
  else if (pass.after && next !== passRaw) writes.push(["SET", passKey(callsId), next, "EX", REFUND_PASS_SECONDS]);
  if (!(Number(anchorRaw) > 0)) writes.push(["SET", anchorKey(callsId), String(pass.from), "EX", REFUND_KEEP_SECONDS * 2], keepSeen());
  else writes.push(["EXPIRE", anchorKey(callsId), REFUND_KEEP_SECONDS * 2], keepSeen());
  await redisPipeline(writes);
  return handled;
}
