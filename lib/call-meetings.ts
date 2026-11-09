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
 * it ends nothing, is not taken as read, and keeps the anchor at its time, so
 * the next run reads it again; one on its way for more than seven days is
 * said in the log, never taken for that. A refund that failed or was
 * canceled ends nothing. A full refund made of parts ends the meeting only
 * once the parts that succeeded add up to the charge (read from the charge's
 * own refunds, as lib/licence-keys.ts does on #2868).
 *
 *   nl:meet:rf:<callsId>:since   the time refunds were read up to, in seconds
 *   nl:meet:rf:<callsId>:seen    refunds already read
 */
import { whereOf } from "@/lib/call-place";
import { saleHandles } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isSenderConfigured } from "@/lib/email";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { type LostRead, confirmLostRead, lostCursorKey, lostDisputesOrRetry, refundedInFull, rowGivesBack } from "@/lib/refunds";
import { StripeListUnreadable, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
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
    await onAccount("GET", account, `/refunds?${new URLSearchParams({ charge: id, limit: String(CHARGE_REFUNDS_PAGE) })}`),
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

async function refundsOf(store: Store, callsId: string, deadline: number): Promise<number> {
  const account = store.stripeAccountId as string;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const [anchorRaw] = await redisPipeline([["GET", anchorKey(callsId)]]);
  // The first look goes back a day: meetings are only made from now on, and
  // a refund made before one existed has nothing to remove.
  const anchor = Number(anchorRaw) > 0 ? Number(anchorRaw) : nowSeconds - 86_400;
  const since = Math.max(0, anchor - 300);
  const handles = saleHandles(store);
  let newest = anchor;
  let lookups = REFUND_LOOKUPS;
  let handled = 0;
  let after = "";
  let complete = false;
  // A failed or unfinished read of the lost disputes keeps the anchor.
  let unsure = false;
  let lostRead: LostRead | null = null;
  /**
   * The earliest refund this run left for later because its money has not gone back for good yet (on its way, a part
   * of a charge whose rest is on its way, or one whose charge's refunds did not read): the anchor never moves past it,
   * so the next run reads it again (the owner's decision 18).
   */
  let holdAt: number | null = null;
  const hold = (created: number) => {
    holdAt = holdAt === null ? created : Math.min(holdAt, created);
  };
  for (let page = 0; page < REFUND_PAGES && Date.now() < deadline; page += 1) {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (after) query.set("starting_after", after);
    const listed = await onAccount("GET", account, `/refunds?${query}`);
    const refunds = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
    // A dispute closed as lost ends the booking's meeting
    // as a full refund does (lib/refunds.ts, queue 388 [TB14]): read once,
    // with the first page, from Stripe's closing events (kept thirty days).
    const lost = page === 0 ? await lostDisputesOrRetry(account, since, deadline, lostCursorKey("meet", callsId)) : null;
    if (lost) lostRead = lost;
    if (lost && !lost.complete) unsure = true;
    const rows = [...(lost?.rows ?? []), ...refunds];
    for (const refund of rows) {
      if (Date.now() >= deadline) break;
      const id = typeof refund.id === "string" ? refund.id : "";
      const created = typeof refund.created === "number" ? refund.created : 0;
      if (!id) continue;
      const dispute = refund.object === "dispute";
      // A refund still on its way may still fail: it ends nothing and holds the anchor (the owner's decision 18).
      if (!dispute && REFUND_ON_ITS_WAY.has(refund.status as string)) {
        if (created <= nowSeconds - REFUND_STUCK_SECONDS) {
          // An alert for whoever reads the logs, never a revocation: the meeting stays until the refund succeeded.
          console.error("a refund for a call has been pending for more than seven days; its meeting is kept until it succeeds", { store: store.handle, account, refund: id, status: refund.status, created });
        }
        hold(created);
        continue;
      }
      // Only a refund that succeeded on a charge refunded in full, or a dispute lost, takes anything back: a refund that
      // failed or was canceled, or a part, ends nothing.
      if (dispute ? !rowGivesBack(refund) : refund.status !== "succeeded" || !refundedInFull(refund.charge)) {
        newest = Math.max(newest, created);
        continue;
      }
      const [seen] = await redisPipeline([["SISMEMBER", seenKey(callsId), id]]);
      if (Number(seen) === 1) {
        newest = Math.max(newest, created);
        continue;
      }
      const intent = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
      if (!INTENT.test(intent)) {
        // No payment to look up (a charge made without one): no booking can be told from it, so it is read, and a
        // lost dispute like it never holds the place back (review of #2158).
        await redisPipeline([
          ["SADD", seenKey(callsId), id],
          ["EXPIRE", seenKey(callsId), REFUND_KEEP_SECONDS * 2 + 86_400],
        ]);
        newest = Math.max(newest, created);
        continue;
      }
      if (lookups <= 0) continue;
      lookups -= 1;
      const sessions = await onAccount("GET", account, `/checkout/sessions?${new URLSearchParams({ payment_intent: intent, limit: "1" })}`);
      const session = (Array.isArray(sessions.data) ? (sessions.data as Record<string, unknown>[]) : [])[0];
      const meta = ((session?.metadata ?? {}) as Record<string, string>) ?? {};
      if (session && typeof session.id === "string" && meta.kind === "call" && handles.has(meta.store ?? "")) {
        // A succeeded part of a charge read refunded in full (Stripe counts a refund still pending in amount_refunded):
        // the meeting ends only once the charge's succeeded refunds add up to it. While one of them is on its way, past
        // the run's lookups, or when they do not read, the refund is held, never taken as read. A lost dispute, and a
        // single refund of the whole charge, need no read.
        if (!dispute && !wholeOnItsOwn(refund)) {
          let settled: "held" | "through" | "unknown" = "held";
          if (lookups > 0) {
            lookups -= 1;
            settled = await chargeRefundsSettled(account, refund).catch((error: unknown) => {
              if (!(error instanceof StripeListUnreadable) && !(error instanceof StripeError)) throw error;
              console.error("reading the refunds of a refunded charge for meetings failed; held for the next run", store.handle, error);
              return "unknown" as const;
            });
          }
          if (settled !== "through") {
            hold(created);
            continue;
          }
        }
        const moved = (await readMoves([session.id])).get(session.id);
        const start = moved ? moved.s : Number(meta.start);
        const details = (session.customer_details ?? {}) as { email?: unknown };
        if (Number.isFinite(start) && (await callRefunded(store, { session: session.id, product: meta.product ?? "", start, email: typeof details.email === "string" ? details.email : null }))) {
          handled += 1;
        }
        // A call refunded in full leaves the private calendar feed (lib/calls.ts, callFromRow, drops a payment
        // refunded in full): marked, its file is made again at the app's next check, not a day later, with or
        // without a meeting room (inbox C4-18, M3). A lost dispute is not marked: the feed reads the payment, which a
        // lost dispute does not show as refunded, so the booking stays there until lib/calls.ts reads it.
        if (refund.object !== "dispute") {
          await markBookingsChanged(callsId).catch((error: unknown) => console.error("marking the bookings changed failed", error));
        }
        // A team booking refunded in full gives its hosts their time back, on every store.
        const hosts = (meta.hosts ?? "").split(",").filter(isHostId);
        if (hosts.length && isClaimId(meta.claim)) await releaseClaim(hosts, meta.claim).catch(() => {});
      }
      await redisPipeline([
        ["SADD", seenKey(callsId), id],
        ["EXPIRE", seenKey(callsId), REFUND_KEEP_SECONDS * 2 + 86_400],
      ]);
      newest = Math.max(newest, created);
    }
    const last = refunds[refunds.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") {
      complete = true;
      break;
    }
    after = last.id;
  }
  // The lost disputes' place moves only once every one read was handled (lib/refunds.ts, confirmLostRead); a sweep
  // that went on from a kept place moves the job no further than the newest closing it read, so a dispute closed
  // meanwhile is read from the top next run (review of #2158, inbox C4-24).
  if (lostRead) {
    if (!(await confirmLostRead(lostRead, seenKey(callsId)))) unsure = true;
    else if (lostRead.complete) newest = lostRead.resumed ? lostRead.newest : Math.max(newest, lostRead.newest);
  }
  // The place moves only past what was read to the end, sure, with lookups left and inside its time. A store with no place yet keeps
  // the one it started from, so the next run reads the same window and the lost disputes' kept place still counts; its
  // refunds already read are kept as long (reviews of #2158). Otherwise nothing is written: a place that cannot move
  // lapses as it always did, and the read refunds, kept sixty-one days after the last one, always outlive it.
  const done = complete && !unsure && lookups > 0 && Date.now() < deadline;
  // A refund held for later keeps the anchor at its time, so the next run reads it again (the owner's decision 18).
  const moved = holdAt === null ? Math.max(newest, anchor) : Math.min(Math.max(newest, anchor), holdAt);
  if (done) await redisPipeline([["SET", anchorKey(callsId), String(moved), "EX", REFUND_KEEP_SECONDS * 2]]);
  else if (!(Number(anchorRaw) > 0)) {
    await redisPipeline([
      ["SET", anchorKey(callsId), String(anchor), "EX", REFUND_KEEP_SECONDS * 2],
      ["EXPIRE", seenKey(callsId), REFUND_KEEP_SECONDS * 2 + 86_400],
    ]);
  }
  return handled;
}
