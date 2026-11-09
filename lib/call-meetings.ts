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
 *   nl:meet:rf:<callsId>:since   the time refunds were read up to, in seconds
 *   nl:meet:rf:<callsId>:seen    refunds already read
 *
 * Hosts who left. A team booking's meeting can be on the own Google Calendar
 * of its host (lib/host-calendar.ts), with the buyer on the guest list, and
 * a collective call's other hosts are its guests. A store whose team somebody
 * leaves is marked (lib/team.ts removeMember, lib/meet-links.ts markHostLeft):
 * a record in the queue above, so the very next run looks at it. As a net,
 * each run also looks at one page of HOST_STORES stores with meetings to
 * come, the page turning every SLOT_MS, so every store is looked at once
 * every (stores / HOST_STORES) runs. A look (sweepStore) reads the store's
 * team bookings to come from its diary (lib/calls.ts, teamBookingsAhead) and
 * its team once: a meeting on the calendar of somebody no longer on it is
 * deleted there and replaced by the store's own or the call's room
 * (replaceFormerHost), only for a booking the list of bookings shows, read in
 * full; the people booked are then emailed the new link until it reaches them
 * (a "tell" record, lib/calls.ts tellFormerHost), the owner told once. A host
 * who left and is only a guest is taken off the guest list (dropFormerGuests).
 * A team, a diary or a list of bookings that cannot be read changes nothing,
 * and a marked store is looked at again later.
 */
import { whereOf } from "@/lib/call-place";
import { saleHandles } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isSenderConfigured } from "@/lib/email";
import { onAccount } from "@/lib/stripe-account";
import { type LostRead, confirmLostRead, lostCursorKey, lostDisputesOrRetry, rowGivesBack } from "@/lib/refunds";
import { readListing } from "@/lib/catalog";
import { markBookingsChanged, readMoves } from "@/lib/call-records";
import { readRecord } from "@/lib/meet-records";
import { MEET_STORES, callRefunded, dropScope, dueScopes, retryRecord } from "@/lib/meet-links";
import { type PaidCall, isCallProduct, paidCalls, tellNewLink } from "@/lib/calls";
import { eventStillWants, readEventScope } from "@/lib/event-meetings";
import type { Store } from "@/lib/store";
import { isClaimId, isHostId, releaseClaim } from "@/lib/host-claims";
// Hosts who left the team (sweepStore, below).
import { dropFormerGuests, finishPending, leaveFormerHost, postponeRecord, rememberTell, replaceFormerHost, teamHostIds } from "@/lib/meet-links";
import { type MeetRecord, callScope, readRecords } from "@/lib/meet-records";
import { hostId } from "@/lib/host-claims";
import { teamBookingsAhead, tellFormerHost, paidCallsRead } from "@/lib/calls";
import { roomOf } from "@/lib/call-rooms";

const BATCH = 40;
const REFUND_STORES = 20;
/** Stores with meetings to come looked at per run for hosts who left, as a net (above), and how often the page turns. */
const HOST_STORES = 20;
const SLOT_MS = 300_000;
const REFUND_PAGES = 2;
const REFUND_LOOKUPS = 10;
const REFUND_KEEP_SECONDS = 30 * 86_400;
const INTENT = /^pi_[A-Za-z0-9]{6,200}$/;

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
  bookingLists = new Map();
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
    if (outcome.kind === "former-host") {
      // A move or a guest list still to do on the calendar of a host who left: deleted there instead, and the
      // booking given the store's own meeting or the room, only when its booking is known. Otherwise tried again.
      const replaced = await replaceKnown(store, outcome.record, origin, run);
      if (replaced === "unknown") await postponeRecord(scope);
      continue;
    }
    if (outcome.kind === "sweep") {
      const complete = await sweepStore(store, origin, run).catch((error) => {
        console.error("looking at a store whose team a host left failed", error);
        return false;
      });
      await finishPending(scope, complete);
      continue;
    }
    if (outcome.kind === "tell") {
      const sent = await tellPending(store, outcome.record, origin, false).catch(() => false);
      if ((await finishPending(scope, sent)) === "gave-up") await tellPending(store, outcome.record, origin, true).catch(() => false);
      continue;
    }
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
  if (Date.now() < deadline) {
    await netSweep(storeFor, deadline, origin, run).catch((error) => console.error("looking for hosts who left failed", error));
  }
  return run;
}

/** One page of the stores with meetings to come, the page turning every SLOT_MS (above): a net under the marks. */
async function netSweep(storeFor: (handle: string) => Promise<Store | null>, deadline: number, origin: string, run: MeetingsRun): Promise<void> {
  const [count] = await redisPipeline([["ZCARD", MEET_STORES]]);
  const total = Number(count);
  if (!Number.isInteger(total) || total <= 0) return;
  const pages = Math.ceil(total / HOST_STORES);
  const first = (Math.floor(Date.now() / SLOT_MS) % pages) * HOST_STORES;
  // By rank, as ZRANGE would: every score, from the page's first place.
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", MEET_STORES, 0, Number.MAX_SAFE_INTEGER, "LIMIT", first, HOST_STORES]]);
  const members = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  for (const member of members) {
    if (Date.now() > deadline) break;
    const [callsId, handle] = member.split("|");
    if (!callsId || !handle) continue;
    const store = await storeFor(handle).catch(() => null);
    if (!store || store.callsId !== callsId) continue;
    await sweepStore(store, origin, run).catch((error) => console.error("looking for hosts who left a store failed", error));
  }
}

/**
 * One store looked at for hosts who left (above). True when every booking was
 * read and nothing was left for later; false when something could not be read
 * or done, so a marked store is looked at again.
 */
async function sweepStore(store: Store, origin: string, run: MeetingsRun): Promise<boolean> {
  const callsId = store.callsId;
  if (!callsId) return true;
  const now = Date.now();
  const ahead = await teamBookingsAhead(store, now);
  if (!ahead.length) return true;
  const owner = hostId(store.email);
  // One read of the team for the store; one that cannot be read changes nothing (rule 24).
  const team = await teamHostIds(store);
  if (!team) return false;
  const suspects = ahead.filter((b) => b.hosts.some((h) => h !== owner && !team.has(h)));
  if (!suspects.length) return true;
  const scopes = suspects.map((b) => callScope(callsId, { group: false, session: b.session, product: b.product, start: b.start }));
  const records = await readRecords(scopes);
  let complete = true;
  for (let i = 0; i < suspects.length; i += 1) {
    const record = records[i];
    if (!record || record.gone) continue;
    if (record.host && record.host !== owner && !team.has(record.host)) {
      const replaced = await replaceKnown(store, record, origin, run);
      if (replaced === "unknown") complete = false;
      continue;
    }
    // Only a guest: a host of the call who left is taken off the guest list of the event.
    const gone = new Set(suspects[i].hosts.filter((h) => h !== owner && !team.has(h)));
    const leaving = record.guests.filter((g) => gone.has(hostId(g)));
    if (leaving.length) await dropFormerGuests(store, scopes[i], leaving);
  }
  return complete;
}

/** The list of bookings of a store, read once a run (emptied as each run starts); null when it could not be read. */
let bookingLists = new Map<string, Promise<Awaited<ReturnType<typeof paidCallsRead>> | null>>();
function bookingsOf(store: Store) {
  if (!bookingLists.has(store.handle)) bookingLists.set(store.handle, paidCallsRead(store).catch(() => null));
  return bookingLists.get(store.handle)!;
}

/**
 * A booking's meeting on the calendar of a host who left, replaced
 * (replaceFormerHost) only when the list of bookings is read in full and
 * shows it, so its people are known and told ("tell" record). "unknown":
 * nothing was changed, to be tried again.
 */
async function replaceKnown(store: Store, record: MeetRecord, origin: string, run: MeetingsRun): Promise<"done" | "unknown"> {
  const read = await bookingsOf(store);
  if (!read || read.partial) return "unknown";
  const booked = read.paid.filter((c) => c.session === record.session);
  if (!booked.length) return "unknown";
  const product = await readListing(store, record.product);
  if (!product || !isCallProduct(product)) {
    await leaveFormerHost(store, record.scope, record.host);
    return "done";
  }
  const replaced = await replaceFormerHost(store, product, { session: record.session, start: record.start, end: record.end, email: booked[0].email, host: record.host });
  if (!replaced) return "done";
  run.switched += 1;
  if (whereOf(product.call).kind === "place") return "done";
  const tell = await rememberTell(store, record.scope, { session: record.session, product: record.product, start: record.start, end: record.end }, { ...replaced.meeting, link: replaced.previous });
  const sent = await tellPending(store, tell, origin, false).catch(() => false);
  if (sent) run.told += 1;
  await finishPending(tell.scope, sent);
  return "done";
}

/**
 * A "tell" record's people emailed the booking's link now (tellFormerHost):
 * read again from the booking's record, so a meeting made since is the one
 * given. False when the list of bookings is not read in full, or an email did
 * not go. `gaveUp`: only the owner is told who to send it to.
 */
async function tellPending(store: Store, tell: MeetRecord, origin: string, gaveUp: boolean): Promise<boolean> {
  const product = await readListing(store, tell.product);
  if (!product || !isCallProduct(product) || whereOf(product.call).kind === "place" || !store.callsId) return true;
  const read = await bookingsOf(store);
  if (!read || read.partial) return false;
  const people = read.paid.filter((c) => c.session === tell.session);
  const scope = tell.scope.replace(/:tell$/, "");
  const [base] = await readRecords([scope]);
  const live = base && !base.gone ? base : null;
  const link = live ? live.link : ((await roomOf(store.callsId, { product: product.id, setup: product.call, session: tell.session, start: tell.start, end: tell.end }).catch(() => null)) ?? "");
  const pending = !!live && !live.made && live.todo === "create";
  const meeting: MeetRecord = { ...(live ?? tell), scope, link, start: tell.start, end: tell.end, updates: tell.updates };
  return tellFormerHost({ store, product, meeting, previous: tell.previous ?? "", people, origin, pending, gaveUp });
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
      if (!rowGivesBack(refund)) {
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
  if (done) await redisPipeline([["SET", anchorKey(callsId), String(Math.max(newest, anchor)), "EX", REFUND_KEEP_SECONDS * 2]]);
  else if (!(Number(anchorRaw) > 0)) {
    await redisPipeline([
      ["SET", anchorKey(callsId), String(anchor), "EX", REFUND_KEEP_SECONDS * 2],
      ["EXPIRE", seenKey(callsId), REFUND_KEEP_SECONDS * 2 + 86_400],
    ]);
  }
  return handled;
}
