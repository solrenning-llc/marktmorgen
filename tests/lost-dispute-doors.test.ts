/**
 * A lost dispute at the doors the first pass left on refunds only, and how
 * each door behaves when the dispute cannot be read (queue 388 [TB14], F38;
 * MM-SA-18; review of PR #2107, added 4 November 2026). Checked against a
 * stand-in for the creator's Stripe account:
 *
 *   - the license key job still revokes on a full refund when the closing
 *     events cannot be read (a restricted key, a rate limit), and keeps its
 *     place so the disputes are read again next run;
 *   - a dispute lost for less than the charge closes as one lost for the
 *     whole: Stripe says its amount can differ by an exchange rate, and
 *     nothing tells that from a part of the order (inbox C4-9; a charge of
 *     4900 lost at 4870 left everything open before);
 *   - the closing events are read with no charge read, and not once the
 *     job's time is up, which keeps its place;
 *   - a dispute that cannot be read keeps the community and the list of
 *     purchases open, as a refund read does, and no dispute is read for an
 *     offer that is not of the product asked about;
 *   - the job that ends a paid call's meeting ends it on a lost dispute, also
 *     one lost for less, and not on a won one;
 *   - a review is no longer from a "verified buyer" once its payment is lost
 *     to a dispute, both when proved and in the job that marks reviews.
 */
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { purchaseRefunded } from "@/lib/refunds";
import { paidForAny } from "@/lib/community-access";
import { purchasesFor } from "@/lib/buyer-orders";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { syncMeetings } from "@/lib/call-meetings";
import { bookingCreditsKey, bookingsChangedKey } from "@/lib/call-records";
import { lostDisputesSince } from "@/lib/refunds";
import { callScope, readRecord, writeRecord, type MeetRecord } from "@/lib/meet-records";
import { MEET_STORES } from "@/lib/meet-links";
import { bookedCalendarFeed, ensureFeedToken } from "@/lib/calendar-sync";
import { markRefundedReviews, provePurchase } from "@/lib/review-proof";
import { readReview, saveReview, visibleReviews } from "@/lib/reviews";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { NOT_A_COST } from "./plan-cost-registry";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_lost_dispute_doors_only";

const OWNER = "potter@example.com";
const ACCOUNT = "acct_1TestDoors00001";
const NOW = Math.floor(Date.now() / 1000);

const sessions: Record<string, Record<string, unknown>[]> = {};
const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
const oneSession: Record<string, Record<string, unknown>> = {};
const intents: Record<string, Record<string, unknown>[]> = {};
const paymentIntents: Record<string, Record<string, unknown>> = {};
const disputes: Record<string, { charge: string; status: string; amount?: number }[]> = {};
const charges: Record<string, Record<string, unknown>> = {};
let closings: Record<string, unknown>[] = [];
let refunds: Record<string, unknown>[] = [];
let eventsStatus = 200;
let disputesDown = false;
let disputeReads = 0;
let chargeReads = 0;
let eventReads = 0;
/** When set, the clock jumps past every job's deadline as soon as /refunds has answered, before /events is asked. */
let lateAfterRefunds = false;
const realNow = Date.now;
const lookedUp: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const pi = url.searchParams.get("payment_intent");
    if (pi) {
      lookedUp.push(pi);
      return list(sessionsByPayment[pi] ?? []);
    }
    return list(sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? []);
  }
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) return oneSession[one[1]] ? answer(oneSession[one[1]]) : answer({ error: { message: "no such" } }, 404);
  if (path === "/payment_intents") return list(intents[url.searchParams.get("customer") ?? ""] ?? []);
  const pi = /^\/payment_intents\/(pi_[A-Za-z0-9]+)$/.exec(path);
  if (pi) return answer(paymentIntents[pi[1]] ?? {});
  if (path === "/disputes") {
    disputeReads += 1;
    if (disputesDown) return answer({ error: { message: "rate limited" } }, 429);
    return list(disputes[url.searchParams.get("charge") ?? ""] ?? []);
  }
  if (path === "/events") {
    eventReads += 1;
    if (eventsStatus !== 200) return answer({ error: { type: "invalid_request_error", message: "This API key does not have the rak_event_read permission" } }, eventsStatus);
    return list(url.searchParams.get("type") === "charge.dispute.closed" ? closings : []);
  }
  const read = /^\/charges\/(ch_[A-Za-z0-9]+)$/.exec(path);
  if (read) chargeReads += 1;
  if (read) return answer(charges[read[1]] ?? { object: "charge", id: read[1], amount: 4900, amount_refunded: 0, disputed: true });
  if (path === "/refunds") {
    if (lateAfterRefunds) Date.now = () => realNow() + 3_600_000;
    return list(refunds);
  }
  return list([]);
}) as typeof fetch;

const charge = (id: string, status: string | null, amount = 4900, lost = amount) => {
  if (status) disputes[id] = [{ charge: id, status, amount: lost }];
  return { object: "charge", id, amount, amount_refunded: 0, refunded: false, disputed: status !== null };
};
const paid = (id: string, product: string, status: string | null, over: Record<string, unknown> = {}, lost = 4900) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestPotter001",
  customer_details: { email: "buyer@example.com" },
  amount_total: 4900,
  metadata: { store: "kilnworks", product },
  payment_intent: { id: `pi_${id.slice(8)}`, object: "payment_intent", latest_charge: charge(`ch_${id.slice(8)}`, status, 4900, lost) },
  ...over,
});
const closing = (id: string, intent: string, status: string, amount = 4900) => ({
  id,
  object: "event",
  type: "charge.dispute.closed",
  created: NOW - 60,
  data: { object: { id: `du_${id.slice(4)}`, object: "dispute", status, amount, charge: `ch_${intent.slice(3)}`, payment_intent: intent } },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Glaze Guide", "", "49", null);
  const other = await addProduct(OWNER, "Kiln Log", "", "19", null);
  const tool = await addProduct(OWNER, "Firing App", "", "29", null);
  if (!guide.ok || !other.ok || !tool.ok) throw new Error("no products");
  await setProductLink(OWNER, guide.product.id, "https://example.com/glaze-guide");
  await setProductLink(OWNER, other.product.id, "https://example.com/kiln-log");
  await setProductLink(OWNER, tool.product.id, "https://example.com/firing-app");
  await setProductKeys(OWNER, tool.product.id, { source: "generated", prefix: "FIRE", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;

  part("The license key job, when the closing events cannot be read");
  const app = (await readListing(store, tool.product.id))!;
  const given = await keyForSale(store, app, "cs_test_keyrefund0001", "buyer@example.com");
  if (given?.state !== "issued") throw new Error("no key");
  sessionsByPayment.pi_TestKeyRefund1 = [{ id: "cs_test_keyrefund0001", metadata: { store: "kilnworks", product: tool.product.id } }];
  refunds = [{ id: "re_TestKeyRefund1", object: "refund", created: NOW - 30, status: "succeeded", payment_intent: "pi_TestKeyRefund1", charge: { object: "charge", amount: 2900, amount_refunded: 2900, refunded: true } }];
  eventsStatus = 403;
  const ran = await revokeRefunded(store, Date.now() + 10_000).then((n) => n, () => "stopped");
  is("a full refund still revokes its key", [ran, await checkKey(store, app, given.key)], [1, "revoked"]);
  const [anchor] = await redis.pipeline([["GET", `nl:keys:${store.statsId}:refunds:since`]]);
  // A store with no anchor yet keeps the one it started from, thirty days back, never one moved forward (review of #2158).
  const notMoved = (value: unknown) => value === null || Number(value) <= NOW - 29 * 86_400;
  is("and the anchor is not moved, so the disputes are read next run", notMoved(anchor), true);
  eventsStatus = 200;
  refunds = [];

  part("A dispute lost for less than the charge (an exchange rate, or part of the order: Stripe's amount cannot tell)");
  is("4900 charged, 4870 lost: closed, as the whole", await purchaseRefunded(ACCOUNT, paid("cs_test_fx0000000001", guide.product.id, "lost", {}, 4870)), true);
  is("lost for a small part: closed too", await purchaseRefunded(ACCOUNT, paid("cs_test_part00000001", guide.product.id, "lost", {}, 1000)), true);
  is("lost for the whole price: closed", await purchaseRefunded(ACCOUNT, paid("cs_test_whole0000001", guide.product.id, "lost")), true);
  is("won: open", await purchaseRefunded(ACCOUNT, paid("cs_test_won000000001", guide.product.id, "won")), false);
  const partKey = await keyForSale(store, app, "cs_test_keypart000001", "buyer@example.com");
  const wholeKey = await keyForSale(store, app, "cs_test_keywhole00001", "buyer@example.com");
  if (partKey?.state !== "issued" || wholeKey?.state !== "issued") throw new Error("no key");
  sessionsByPayment.pi_TestKeyPart01 = [{ id: "cs_test_keypart000001", metadata: { store: "kilnworks", product: tool.product.id } }];
  sessionsByPayment.pi_TestKeyWhole1 = [{ id: "cs_test_keywhole00001", metadata: { store: "kilnworks", product: tool.product.id } }];
  closings = [closing("evt_TestKeyPart01", "pi_TestKeyPart01", "lost", 4870), closing("evt_TestKeyWhole1", "pi_TestKeyWhole1", "lost")];
  chargeReads = 0;
  await revokeRefunded(store, Date.now() + 10_000);
  is("the key job: lost for less and lost for the whole both revoke", [await checkKey(store, app, partKey.key), await checkKey(store, app, wholeKey.key)], ["revoked", "revoked"]);
  is("and no charge is read for them", chargeReads, 0);

  part("The closing events and the job's time");
  eventReads = 0;
  const late = await lostDisputesSince(ACCOUNT, NOW - 3600, Date.now() - 1);
  is("past the job's deadline: nothing is read, and the read is not complete, so the job keeps its place", [eventReads, late.rows.length, late.complete], [0, 0, false]);
  const read = await lostDisputesSince(ACCOUNT, NOW - 3600, Date.now() + 10_000);
  is("the pages read are in the cost registry, by name", typeof NOT_A_COST.LOST_DISPUTE_PAGES, "string");
  is("in time: one page read, each lost dispute a row marked lost on its charge", [eventReads, read.complete, read.rows.map((r) => (r.charge as { dispute?: { status?: string } }).dispute?.status)], [1, true, ["lost", "lost"]]);
  // Through each job: the time runs out between /refunds and /events.
  const lateKey = await keyForSale(store, app, "cs_test_keylate00001", "buyer@example.com");
  if (lateKey?.state !== "issued") throw new Error("no key");
  sessionsByPayment.pi_TestKeyLate01 = [{ id: "cs_test_keylate00001", metadata: { store: "kilnworks", product: tool.product.id } }];
  closings = [closing("evt_TestKeyLate01", "pi_TestKeyLate01", "lost")];
  await redis.pipeline([["DEL", `nl:keys:${store.statsId}:refunds:since`, `nl:rev:refunds:since:${store.statsId}`]]);
  eventReads = 0;
  lateAfterRefunds = true;
  try {
    await revokeRefunded(store, realNow() + 10_000);
    await markRefundedReviews(store, realNow() + 10_000);
    await syncMeetings(async (handle) => (handle === "kilnworks" ? { ...store, callsId: "d".repeat(16) } : null), realNow() + 10_000, "https://marktmorgen.com");
  } finally {
    Date.now = realNow;
    lateAfterRefunds = false;
  }
  const [keysAnchor, reviewsAnchor] = await redis.pipeline([["GET", `nl:keys:${store.statsId}:refunds:since`], ["GET", `nl:rev:refunds:since:${store.statsId}`]]);
  is("past the deadline after /refunds, no job reads the closing events", eventReads, 0);
  is("and neither the key job nor the review job moves its place", [notMoved(keysAnchor), notMoved(reviewsAnchor)], [true, true]);
  is("the key stays until a run in time reads its dispute", await checkKey(store, app, lateKey.key), "valid");
  await revokeRefunded(store, Date.now() + 10_000);
  is("the next run in time revokes it", await checkKey(store, app, lateKey.key), "revoked");
  closings = [];

  part("A dispute that cannot be read keeps the door open, as a refund read does");
  const ids = new Set([guide.product.id]);
  sessions["rae@example.com"] = [paid("cs_test_rae000000001", other.product.id, null, { customer: "cus_TestRae00001" })];
  intents.cus_TestRae00001 = [{ id: "pi_raeup1aaaa", object: "payment_intent", status: "succeeded", metadata: { kind: "upsell", store: "kilnworks", product: guide.product.id }, latest_charge: charge("ch_raeup1aaaa", "under_review") }];
  disputesDown = true;
  is("the community lets in", await paidForAny(store, "rae@example.com", ids).then((v) => v, () => "stopped"), true);
  const listed = await purchasesFor(store, "rae@example.com").then((p) => p.map((x) => x.reference), () => "stopped");
  is("the list of purchases still shows the order and the offer", Array.isArray(listed) ? [...listed].sort() : listed, ["cs_test_rae000000001", "pi_raeup1aaaa"]);
  disputesDown = false;
  disputeReads = 0;
  is("no dispute is read for an offer of another product", [await paidForAny(store, "rae@example.com", new Set([tool.product.id])), disputeReads], [false, 0]);

  part("The meeting of a paid call");
  const callsId = "c".repeat(16);
  const callStore: Store = { ...store, callsId };
  const callStart = Date.now() + 86_400_000;
  await redis.pipeline([["ZADD", MEET_STORES, callStart, `${callsId}|kilnworks`]]);
  const call = (pi: string) => [{ id: `cs_test_${pi.slice(3)}`, metadata: { kind: "call", store: "kilnworks", product: guide.product.id, start: String(callStart) }, customer_details: { email: "buyer@example.com" } }];
  // Each booking's meeting, as confirmBooking leaves it before the provider made it: ending it needs no provider call.
  const scopeOf = (pi: string) => callScope(callsId, { group: false, session: `cs_test_${pi.slice(3)}`, product: guide.product.id, start: callStart });
  const meeting = (pi: string): MeetRecord => ({
    provider: "google", scope: scopeOf(pi), statsId: store.statsId!, handle: "kilnworks", callsId, product: guide.product.id, session: `cs_test_${pi.slice(3)}`, group: false,
    id: "", account: "", link: "https://marktmorgen.com/call", made: false, start: callStart, end: callStart + 3_600_000, tz: "UTC", title: "Glaze call",
    guests: [], added: [], todo: "", tries: 0, next: 0, error: "", updates: 0, gone: false, host: "", calendar: "",
  });
  for (const pi of ["pi_TestCallLost01", "pi_TestCallWon001", "pi_TestCallPart01"]) {
    sessionsByPayment[pi] = call(pi);
    await writeRecord(meeting(pi));
  }
  closings = [closing("evt_TestCallLost01", "pi_TestCallLost01", "lost"), closing("evt_TestCallWon001", "pi_TestCallWon001", "won"), closing("evt_TestCallPart01", "pi_TestCallPart01", "lost", 4870)];
  lookedUp.length = 0;
  await syncMeetings(async (handle) => (handle === "kilnworks" ? callStore : null), Date.now() + 10_000, "https://marktmorgen.com");
  is("the job looks up the calls lost, not the won one", [...lookedUp].sort(), ["pi_TestCallLost01", "pi_TestCallPart01"]);
  const gone = async (pi: string) => (await readRecord(scopeOf(pi)))?.gone;
  is("and their meetings end; the won call's stays", [await gone("pi_TestCallLost01"), await gone("pi_TestCallPart01"), await gone("pi_TestCallWon001")], [true, true, false]);
  // A lost dispute leaves the booking in the private calendar feed (it reads the payment, which the dispute does not
  // show refunded), so no making is spent on a file that would come out the same (review of #2111).
  const today = new Date().toISOString().slice(0, 10);
  const [changedAfterDisputes, creditsAfterDisputes] = await redis.pipeline([["GET", bookingsChangedKey(callsId)], ["GET", bookingCreditsKey(callsId, today)]]);
  is("a lost dispute spends no making of the store's calendar feed", [changedAfterDisputes, creditsAfterDisputes], [null, null]);
  closings = [];
  // A call refunded in full (a cancellation included), in a store with no meeting room at all, so not in MEET_STORES
  // by its bookings (review C4-33, M3): its feed being read puts it there, and the feed is made again at the app's
  // next check (inbox C4-18, M3).
  const plainId = "e".repeat(16);
  const plainStore: Store = { ...store, callsId: plainId };
  const plainFor = async (handle: string) => (handle === "kilnworks" ? plainStore : null);
  sessionsByPayment.pi_TestCallRefd01 = call("pi_TestCallRefd01");
  // The refund's own amount and its charge's id, as Stripe lists them: a succeeded refund is known to cover its charge
  // only from them (the owner's decision 18; rule 23 on claude5/call-refunds-confirmed).
  const refund = { id: "re_TestCallRefd01", object: "refund", created: NOW - 30, status: "succeeded", amount: 4900, payment_intent: "pi_TestCallRefd01", charge: { object: "charge", id: "ch_TestCallRefd01", amount: 4900, amount_refunded: 4900, refunded: true } };
  is("the store is not in MEET_STORES by its bookings", await redis.pipeline([["ZSCORE", MEET_STORES, `${plainId}|kilnworks`]]), [null]);
  refunds = [refund];
  await syncMeetings(plainFor, Date.now() + 10_000, "https://marktmorgen.com");
  is("so before its feed is read, its refunds are not", (await redis.pipeline([["GET", bookingsChangedKey(plainId)]]))[0], null);
  // A feed is answered only while the store's calendar settings exist (lib/calendar-sync.ts, KEEP_COPY; inbox C4-48):
  // the store subscribed, as a creator does from the studio.
  await ensureFeedToken(store);
  const fed = await bookedCalendarFeed({ statsId: store.statsId!, handle: "kilnworks", callsId: plainId }, async () => ({ ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", listId: null, named: [] }));
  const [listedAt] = await redis.pipeline([["ZSCORE", MEET_STORES, `${plainId}|kilnworks`]]);
  is("its feed made, the store's refunds are read for two days", [fed.state, Number(listedAt) > Date.now() + 86_400_000], ["made", true]);
  await syncMeetings(plainFor, Date.now() + 10_000, "https://marktmorgen.com");
  refunds = [];
  const [changed, credits] = await redis.pipeline([["GET", bookingsChangedKey(plainId)], ["GET", bookingCreditsKey(plainId, today)]]);
  is("a call refunded in full tells the store's calendar feed its bookings changed, one making", [Number(changed) > 0, Number(credits)], [true, 1]);
  await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 30 * 86_400_000, `${plainId}|kilnworks`]]);
  await bookedCalendarFeed({ statsId: store.statsId!, handle: "kilnworks", callsId: plainId }, async () => ({ ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", listId: null, named: [] }), Date.now() + 1);
  const [kept] = await redis.pipeline([["ZSCORE", MEET_STORES, `${plainId}|kilnworks`]]);
  is("a meeting further ahead keeps its later score: the feed never lowers it", Number(kept) > Date.now() + 29 * 86_400_000, true);
  closings = [];

  part("A review's verified buyer");
  oneSession.cs_test_rev0000000lost = paid("cs_test_rev0000000lost", guide.product.id, "lost");
  oneSession.cs_test_rev00000review = paid("cs_test_rev00000review", guide.product.id, "under_review");
  const proved = async (ref: string) => {
    const proof = await provePurchase(store, ref);
    return proof.state === "ok" ? proof.proof.refunded : proof.state;
  };
  is("proved: lost is refunded, under review is not", [await proved("cs_test_rev0000000lost"), await proved("cs_test_rev00000review")], [true, false]);
  await saveReview(store.statsId!, { productId: guide.product.id, email: "rev@example.com", reference: "cs_test_revjob00000001", pi: "pi_TestRevLost01", rating: 5, text: "Clear glaze notes", name: "Rev" }, ROOM);
  const review = (await visibleReviews(store.statsId!, guide.product.id, 0, 10))[0];
  closings = [closing("evt_TestRevLost01", "pi_TestRevLost01", "lost")];
  is("the job marks a review whose payment was lost", [await markRefundedReviews(store, Date.now() + 10_000), (await readReview(store.statsId!, guide.product.id, review.id))?.refunded], [1, true]);

  done();
}

void main();
