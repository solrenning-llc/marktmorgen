/**
 * More lost disputes in a job's window than one run may read (review of
 * #2129, inbox C4-15 (3)(c)). Stripe lists the closing events newest first:
 * without a place kept across runs, every run read the same newest pages,
 * `complete` stayed false and the jobs' place never moved. With the cursor
 * (lib/refunds.ts, lostCursorKey), the next run reads on from where the last
 * stopped, and the run that reaches the end hands back the newest closing of
 * the whole sweep, so the job's place moves past every page read.
 */
import { LOST_DISPUTE_PAGES, lostCursorKey, lostDisputesSince } from "@/lib/refunds";
import { markRefundedReviews } from "@/lib/review-proof";
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import { revokeRefunded } from "@/lib/licence-keys";
import { KIND } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_lost_dispute_cursor_only";
const ACCOUNT = "acct_1TestCursor0001";
const NOW = Math.floor(Date.now() / 1000);
// The jobs read the clock: runs five minutes apart, as the schedule makes them.
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const TOTAL = 100 * LOST_DISPUTE_PAGES + 200;
// Newest first, as Stripe lists them.
const events = Array.from({ length: TOTAL }, (_, i) => ({
  id: `evt_Cursor${String(i).padStart(6, "0")}`,
  object: "event",
  type: "charge.dispute.closed",
  created: NOW - i * 60,
  data: { object: { id: `du_${i}`, object: "dispute", status: "lost", charge: `ch_Cursor${String(i).padStart(6, "0")}`, payment_intent: `pi_Cursor${String(i).padStart(6, "0")}` } },
}));
let reads = 0;
const lookedUp = new Set<string>();
let refundsList: Record<string, unknown>[] = [];
let eventsOn = true;
let eventsDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === "/v1/checkout/sessions" && url.searchParams.get("payment_intent")) lookedUp.add(String(url.searchParams.get("payment_intent")));
  if (url.pathname === "/v1/refunds") {
    // As Stripe lists them: only those created at or after the asked time.
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    return new Response(JSON.stringify({ object: "list", data: refundsList.filter((r) => Number(r.created) >= gte), has_more: false }));
  }
  if (url.pathname !== "/v1/events") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  if (url.pathname === "/v1/events" && eventsDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  if (!eventsOn || url.searchParams.get("type") !== "charge.dispute.closed") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  reads += 1;
  const after = url.searchParams.get("starting_after");
  const from = after ? events.findIndex((e) => e.id === after) + 1 : 0;
  const limit = Number(url.searchParams.get("limit") ?? 10);
  const data = events.slice(from, from + limit);
  return new Response(JSON.stringify({ object: "list", data, has_more: from + limit < events.length }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const since = NOW - 86_400;
  const key = lostCursorKey("keys", "s".repeat(32));
  const seen = new Set<string>();

  part("Without a place kept, the same newest pages every run");
  const first = await lostDisputesSince(ACCOUNT, since);
  const again = await lostDisputesSince(ACCOUNT, since);
  is("each run reads the newest pages and is never complete", [first.complete, again.complete, first.rows[0].id === again.rows[0].id], [false, false, true]);

  part("With the job's place kept");
  reads = 0;
  const one = await lostDisputesSince(ACCOUNT, since, Number.POSITIVE_INFINITY, LOST_DISPUTE_PAGES, key);
  is("reading keeps no place by itself: only the job's confirmation does (review of #2158)", (await redis.pipeline([["GET", key]]))[0], null);
  await one.commit();
  for (const row of one.rows) seen.add(String(row.id));
  is("the first run reads as many pages as it may, not complete, and keeps where it stopped", [one.complete, one.rows.length, reads, typeof (await redis.pipeline([["GET", key]]))[0]], [false, 100 * LOST_DISPUTE_PAGES, LOST_DISPUTE_PAGES, "string"]);
  const two = await lostDisputesSince(ACCOUNT, since, Number.POSITIVE_INFINITY, LOST_DISPUTE_PAGES, key);
  await two.commit();
  for (const row of two.rows) seen.add(String(row.id));
  is("the next run reads on from there and reaches the end", [two.complete, two.rows.length, two.rows.some((r) => one.rows.some((o) => o.id === r.id))], [true, 200, false]);
  is("every lost dispute read once, across the two runs", seen.size, TOTAL);
  is("the end hands back the newest closing of the whole sweep, so the job's place moves past every page", two.newest, NOW);
  is("and the place is let go", (await redis.pipeline([["GET", key]]))[0], null);

  part("The review job keeps its place too (inbox C4-21)");
  const statsId = "r".repeat(32);
  const shop = { statsId, stripeAccountId: ACCOUNT, handle: "cursor-shop" } as unknown as Store;
  const placeKey = `nl:rev:refunds:since:${statsId}`;
  await markRefundedReviews(shop, Date.now() + 60_000);
  const started = Number((await redis.pipeline([["GET", placeKey]]))[0]);
  is("its first run is not complete, so it keeps only the window it started from (review of #2158)", started > 0 && started <= NOW - 29 * 86_400, true);
  shift += 5 * 60_000;
  await markRefundedReviews(shop, Date.now() + 60_000);
  is("its next run, five minutes later, reads on in that window, reaches the end and moves its place past the newest closing", Number((await redis.pipeline([["GET", placeKey]]))[0]), NOW);

  part("A dispute that closes while a sweep goes on over several runs (review of #2158, inbox C4-24)");
  // A run that went on from a kept place reads only older pages: its job may not move past the newest closing the
  // sweep read, or a dispute closed meanwhile, older than a refund read in that run, would never be read.
  const late = "q".repeat(32);
  const lateShop = { statsId: late, stripeAccountId: ACCOUNT, handle: "cursor-late" } as unknown as Store;
  const latePlace = `nl:rev:refunds:since:${late}`;
  await markRefundedReviews(lateShop, Date.now() + 60_000);
  const newer = { ...events[0], id: "evt_CursorNewer01", created: NOW + 120, data: { object: { ...events[0].data.object, id: "du_newer", charge: "ch_CursorNewer01", payment_intent: "pi_CursorNewer01" } } };
  events.unshift(newer);
  refundsList = [{ id: "re_CursorLater01", object: "refund", status: "succeeded", created: NOW + 3_600, payment_intent: "pi_CursorLater01", charge: { object: "charge", refunded: false, amount: 100, amount_refunded: 10 } }];
  await markRefundedReviews(lateShop, Date.now() + 60_000);
  is("the run that went on from the kept place moves the place no further than the newest closing it read", Number((await redis.pipeline([["GET", latePlace]]))[0]) <= NOW, true);
  reads = 0;
  const top = await lostDisputesSince(ACCOUNT, Number((await redis.pipeline([["GET", latePlace]]))[0]) - 300);
  is("so the next run reads from the top, where the dispute that closed meanwhile is", top.rows.some((r) => r.id === "evt_CursorNewer01"), true);
  events.shift();
  refundsList = [];

  part("Through a real job with a limit on its lookups (review of #2158, inbox C4-24)");
  // The call job asks Stripe about at most REFUND_LOOKUPS payments a run: a place kept on reading alone skipped every
  // row past them, and they were never read again. Kept only once every row read is handled, each is looked up.
  const callsId = "c".repeat(16);
  const callStore = { statsId: "m".repeat(32), callsId, stripeAccountId: ACCOUNT, handle: "cursor-calls", previousHandles: [] } as unknown as Store;
  await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|cursor-calls`]]);
  lookedUp.clear();
  await syncMeetings(async (handle) => (handle === "cursor-calls" ? callStore : null), Date.now() + 60_000, "https://marktmorgen.com");
  is("a run that could look up only some of the rows it read keeps no place past the others", [lookedUp.size < 100 * LOST_DISPUTE_PAGES, (await redis.pipeline([["GET", lostCursorKey("meet", callsId)]]))[0]], [true, null]);
  for (let run = 0; run < 2 * TOTAL && lookedUp.size < TOTAL; run += 1) {
    await syncMeetings(async (handle) => (handle === "cursor-calls" ? callStore : null), Date.now() + 60_000, "https://marktmorgen.com");
  }
  is("every lost dispute's payment is looked up, across as many runs as it takes", lookedUp.size, TOTAL);

  part("A lost dispute with no payment to look up (review of #2158)");
  // A charge made without a payment intent (the older Charges API, on the creator's own account) closes a dispute
  // Stripe lists like any other. Left unread, it failed every run's confirmation: the place was never kept, the
  // rows past the first pages never read, and the job's place never moved.
  events[7].data.object.payment_intent = null as unknown as string;
  const keysStore = { statsId: "k".repeat(32), stripeAccountId: ACCOUNT, handle: "cursor-keys", previousHandles: [], catalog: { items: [{ id: "keyproduct", kind: KIND.paid | KIND.keys }] } } as unknown as Store;
  const keysPlace = `nl:keys:${keysStore.statsId}:refunds:since`;
  lookedUp.clear();
  for (let run = 0; run < 4 * TOTAL && Number((await redis.pipeline([["GET", keysPlace]]))[0]) !== NOW; run += 1) {
    shift += 5 * 60_000;
    await revokeRefunded(keysStore, Date.now() + 60_000);
  }
  is("the license key job looks up every other lost dispute's payment", lookedUp.size, TOTAL - 1);
  is("and its place moves past the newest closing", Number((await redis.pipeline([["GET", keysPlace]]))[0]), NOW);
  // A run that ends unsure (here, out of time at once) leaves a place it cannot move as it is, and the refunds already
  // read always outlive it, so none is ever taken for new and revoked again (reviews of #2158).
  await redis.pipeline([["EXPIRE", keysPlace, 1_000]]);
  await revokeRefunded(keysStore, Date.now() - 1);
  const [kept, ttl, keysSeenTtl] = await redis.pipeline([["GET", keysPlace], ["TTL", keysPlace], ["TTL", `nl:keys:${keysStore.statsId}:refunds:seen`]]);
  is("an unsure run leaves the place as it is", [Number(kept), Number(ttl) <= 1_000], [NOW, true]);
  is("and the refunds already read live at least as long as the place", Number(keysSeenTtl) >= Number(ttl), true);
  const noPayCalls = "d".repeat(16);
  const noPayStore = { statsId: "n".repeat(32), callsId: noPayCalls, stripeAccountId: ACCOUNT, handle: "cursor-nopay", previousHandles: [] } as unknown as Store;
  await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${noPayCalls}|cursor-nopay`]]);
  lookedUp.clear();
  for (let run = 0; run < 2 * TOTAL && lookedUp.size < TOTAL - 1; run += 1) {
    shift += 5 * 60_000;
    await syncMeetings(async (handle) => (handle === "cursor-nopay" ? noPayStore : null), Date.now() + 60_000, "https://marktmorgen.com");
  }
  is("the call job looks up every other one too", lookedUp.size, TOTAL - 1);
  // The run of the last lookup may stop mid-sweep; the next ones read on from the kept place to the end.
  const callsPlace = `nl:meet:rf:${noPayCalls}:since`;
  for (let run = 0; run < LOST_DISPUTE_PAGES && Number((await redis.pipeline([["GET", callsPlace]]))[0]) < NOW; run += 1) {
    shift += 5 * 60_000;
    await syncMeetings(async (handle) => (handle === "cursor-nopay" ? noPayStore : null), Date.now() + 60_000, "https://marktmorgen.com");
  }
  is("and its place moves past the newest closing", Number((await redis.pipeline([["GET", callsPlace]]))[0]) >= NOW, true);
  events[7].data.object.payment_intent = `pi_Cursor${String(7).padStart(6, "0")}`;

  part("The review and call jobs leave a place they cannot move, and the refunds they read outlive it (reviews of #2158)");
  for (const [label, key, seen, run] of [
    ["review", placeKey, `nl:rev:refunds:seen:${statsId}`, () => markRefundedReviews(shop, Date.now() + 60_000)],
    ["call", callsPlace, `nl:meet:rf:${noPayCalls}:seen`, () => syncMeetings(async (handle) => (handle === "cursor-nopay" ? noPayStore : null), Date.now() + 60_000, "https://marktmorgen.com")],
  ] as const) {
    // The closing events cannot be read, so the run ends unsure.
    const [before] = await redis.pipeline([["GET", key]]);
    await redis.pipeline([["SADD", seen, "re_KeptForTheTest"], ["EXPIRE", key, 1_000], ["EXPIRE", seen, 1_000]]);
    eventsDown = true;
    await run();
    eventsDown = false;
    const [after, placeTtl, seenTtl] = await redis.pipeline([["GET", key], ["TTL", key], ["TTL", seen]]);
    // Rule 23 (pre-review of claude5/review-proof-refunds-progress at 589eb24c1b): the review job now writes the place
    // it cannot move again at the end of each pass, its time renewed, so a refund held for later (the owner's decision
    // 18) never lets it lapse; the call job still leaves it as it is on this branch.
    const renewed = label === "review";
    is(`the ${label} job, unsure: the same place, ${renewed ? "its time renewed" : "left as it is"}, and the read refunds at least as long`, [after, Number(placeTtl) <= 1_000, Number(seenTtl) >= Number(placeTtl)], [before, !renewed, true]);
  }

  part("A first run that could not look up every refund keeps its window (review of #2158)");
  // The call job asks about at most REFUND_LOOKUPS payments a run. A store with no place yet had its place moved past
  // every refund the first run listed, also those it never looked up: they were never read again.
  eventsOn = false;
  const firstCalls = "e".repeat(16);
  const firstStore = { statsId: "f".repeat(32), callsId: firstCalls, stripeAccountId: ACCOUNT, handle: "cursor-first", previousHandles: [] } as unknown as Store;
  await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${firstCalls}|cursor-first`]]);
  const nowAt = Math.floor(Date.now() / 1000);
  refundsList = Array.from({ length: 15 }, (_, i) => ({
    id: `re_CursorFirst${String(i).padStart(3, "0")}`,
    object: "refund",
    status: "succeeded",
    created: nowAt - 3_600 * (i + 1),
    payment_intent: `pi_CursorFirst${String(i).padStart(3, "0")}`,
    charge: { object: "charge", refunded: true, amount: 100, amount_refunded: 100 },
  }));
  lookedUp.clear();
  for (let run = 0; run < 5; run += 1) {
    shift += 5 * 60_000;
    await syncMeetings(async (handle) => (handle === "cursor-first" ? firstStore : null), Date.now() + 60_000, "https://marktmorgen.com");
  }
  is("every refund's payment is looked up, across the runs", refundsList.every((r) => lookedUp.has(String(r.payment_intent))), true);
  refundsList = [];
  eventsOn = true;

  part("A place of another window is never followed");
  await (await lostDisputesSince(ACCOUNT, since, Number.POSITIVE_INFINITY, LOST_DISPUTE_PAGES, key)).commit();
  const other = await lostDisputesSince(ACCOUNT, since - 60, Number.POSITIVE_INFINITY, LOST_DISPUTE_PAGES, key);
  is("a run with another window starts from the newest", other.rows[0].id, events[0].id);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
