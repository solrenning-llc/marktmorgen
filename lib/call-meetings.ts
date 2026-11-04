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
 */
import { whereOf } from "@/lib/call-place";
import { saleHandles } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isSenderConfigured } from "@/lib/email";
import { onAccount } from "@/lib/stripe-account";
import { lostCursorKey, lostDisputesOrRetry, rowGivesBack } from "@/lib/refunds";
import { readListing } from "@/lib/catalog";
import { readMoves } from "@/lib/call-records";
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
  for (let page = 0; page < REFUND_PAGES && Date.now() < deadline; page += 1) {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    query.append("expand[]", "data.charge");
    if (after) query.set("starting_after", after);
    const listed = await onAccount("GET", account, `/refunds?${query}`);
    const refunds = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
    // A dispute closed as lost ends the booking's meeting
    // as a full refund does (lib/refunds.ts, queue 388 [TB14]): read once,
    // with the first page, from Stripe's closing events (kept thirty days).
    const lost = page === 0 ? await lostDisputesOrRetry(account, since, deadline, lostCursorKey("meet", callsId)) : { rows: [], complete: true, newest: 0 };
    if (!lost.complete) unsure = true;
    // The latest closing of the whole sweep (lib/refunds.ts, lostDisputesSince): reached the end, the place moves past it.
    else newest = Math.max(newest, lost.newest);
    const rows = [...lost.rows, ...refunds];
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
      if (!INTENT.test(intent) || lookups <= 0) continue;
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
        // A team booking refunded in full gives its hosts their time back, on every store.
        const hosts = (meta.hosts ?? "").split(",").filter(isHostId);
        if (hosts.length && isClaimId(meta.claim)) await releaseClaim(hosts, meta.claim).catch(() => {});
      }
      await redisPipeline([
        ["SADD", seenKey(callsId), id],
        ["EXPIRE", seenKey(callsId), REFUND_KEEP_SECONDS],
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
  // Moved forward only past what was read to the end, as the license keys do.
  if ((complete && !unsure && lookups > 0 && Date.now() < deadline) || !(Number(anchorRaw) > 0)) {
    await redisPipeline([["SET", anchorKey(callsId), String(complete && !unsure ? Math.max(newest, anchor) : anchor), "EX", REFUND_KEEP_SECONDS * 2]]);
  }
  return handled;
}
