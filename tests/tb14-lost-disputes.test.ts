/**
 * A dispute lost takes back a gift and a pre-order as a full refund does
 * (queue 388 [TB14], completeness add-on of 5 November 2026; the owner's rule
 * of 4 November 2026 in lib/refunds.ts: a lost dispute closes the whole order,
 * whatever its amount).
 *
 * revokeRefundedGifts (lib/gifts.ts) and revokeRefundedPreorders
 * (lib/preorders.ts) read only /refunds, so a buyer whose bank took the money
 * back kept the gift's recipient's purchase, and a pre-order already handed
 * over. Checked against a stand-in for the creator's Stripe account, through
 * the real gift and pre-order journeys:
 *
 *   - a dispute closed as lost takes it back, whatever its amount;
 *   - a dispute won takes nothing back, nor does a refund of part of the price;
 *   - a read of the closing events that fails keeps everything, keeps the
 *     place, and the next run takes it back;
 *   - a lost dispute read again takes nothing back twice;
 *   - a booked call (lib/calls.ts, callFromRow) whose charge Stripe marks as
 *     disputed is asked about, and a lost dispute frees its time as a full
 *     refund does; a won one, one Stripe cannot be asked about, and one past
 *     the reading's DISPUTE_READS_PER_READING keep it; a charge not marked
 *     disputed costs no request.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, readGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { importedFor, importedKey } from "@/lib/imported-purchases";
import { confirmPreorder, readPreorder, revokeRefundedPreorders } from "@/lib/preorders";
import { paidCall, paidCalls } from "@/lib/calls";
import { lostDisputesSince } from "@/lib/refunds";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
let refunds: Record<string, unknown>[] = [];
let refundsMalformed = false;
/** Closing events of disputes, newest first, as Stripe lists them. */
let closings: Record<string, unknown>[] = [];
let eventsFail = false;
let eventsMalformed = false;
let eventReads = 0;
/** The store's completed checkouts, newest first, as Stripe lists them with their payment's latest charge. */
let sessions: Record<string, unknown>[] = [];
/** A charge's disputes, by charge id; a charge listed in `disputesFail` cannot be asked about. */
const disputes: Record<string, { status: string }[]> = {};
const disputesFail = new Set<string>();
let disputeReads = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds") return answer(refundsMalformed ? { object: "list", data: null, has_more: false } : { object: "list", data: refunds, has_more: false });
  if (path === "/events") {
    eventReads += 1;
    if (eventsFail) return answer({ error: { message: "rate limited" } }, 429);
    if (eventsMalformed) return answer({ object: "list", data: null, has_more: false });
    const after = url.searchParams.get("starting_after");
    const from = after ? closings.findIndex((e) => e.id === after) + 1 : 0;
    return answer({ object: "list", data: closings.slice(from, from + 100), has_more: from + 100 < closings.length });
  }
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions, has_more: false });
  if (path.startsWith("/checkout/sessions/")) return answer(sessions.find((row) => row.id === path.split("/")[3]) ?? { error: { message: "no such session" } }, sessions.some((row) => row.id === path.split("/")[3]) ? 200 : 404);
  if (path === "/disputes") {
    disputeReads += 1;
    const charge = url.searchParams.get("charge") ?? "";
    if (disputesFail.has(charge)) return answer({ error: { message: "rate limited" } }, 429);
    return answer({ object: "list", data: disputes[charge] ?? [], has_more: false });
  }
  if (path.startsWith("/payment_intents/")) return answer({ id: path.split("/")[2], object: "payment_intent", latest_charge: { object: "charge", refunded: false, amount: 2500, amount_refunded: 0 } });
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

/** A dispute Stripe closed, as its charge.dispute.closed event. */
function closing(n: number, status: "lost" | "won", payment: string, amount = 2500): Record<string, unknown> {
  return {
    id: `evt_closed${String(n).padStart(10, "0")}`,
    object: "event",
    type: "charge.dispute.closed",
    created: NOW - 60 + n,
    data: { object: { object: "dispute", id: `dp_${String(n).padStart(12, "0")}`, status, amount, charge: `ch_disputed${String(n).padStart(8, "0")}`, payment_intent: payment } },
  };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_tb14_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_tb14_only";

  await claimHandle("owner@tb14.example", "tb14shop", "TB14 Shop", "");
  await ensureStatsId("owner@tb14.example");
  await setStripeAccount("owner@tb14.example", "acct_1TestTb14Lost01", true);
  await setSubscription("owner@tb14.example", { customerId: "cus_Tb14Owner01", subscriptionId: "sub_Tb14Owner01", active: true, period: paidPeriod() });

  part("Adversarial: an incomplete events list is unknown, not a completed read");
  eventsMalformed = true;
  const incomplete = await lostDisputesSince("acct_1TestTb14Lost01", NOW - 600);
  is("the caller must keep its cursor and anchor", incomplete.complete, false);
  eventsMalformed = false;

  part("Adversarial: a closing event without the status that decides lost or won is unknown");
  closings = [{
    id: "evt_tb14missingstatus0001",
    created: NOW - 5,
    data: { object: { id: "dp_tb14missingstatus0001", payment_intent: "pi_tb14missingstatus0001" } },
  }];
  const eventWithoutStatus = await lostDisputesSince("acct_1TestTb14Lost01", NOW - 600);
  is("the caller must not advance past an event whose outcome is missing", eventWithoutStatus.complete, false);
  closings = [];
  const made = await addProduct("owner@tb14.example", "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@tb14.example", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@tb14.example"))!;
  const product = (await readListing(store, made.product.id))!;
  const deps = {
    base: "https://marktmorgen.com/@tb14shop",
    from: '"TB14 Shop" <hello@marktmorgen.com>',
    ordersLink: async (email: string) => `https://marktmorgen.com/@tb14shop/orders?for=${encodeURIComponent(email)}`,
    recordStart: async () => {},
  };

  part("Pre-orders: a lost dispute takes back one handed over, whatever its amount");
  const session = (n: number, email: string) => ({
    id: `cs_test_tb14pre${String(n).padStart(8, "0")}`,
    created: NOW - 600,
    status: "complete",
    payment_status: "paid",
    amount_total: 2500,
    currency: "usd",
    payment_intent: `pi_tb14pre${String(n).padStart(8, "0")}`,
    metadata: { store: "tb14shop", product: product.id, preorder: "yes" },
    customer_details: { email },
  });
  for (const [n, email] of [[1, "ana@tb14.example"], [2, "ben@tb14.example"], [3, "cy@tb14.example"], [4, "dee@tb14.example"]] as [number, string][]) {
    is(`pre-order ${n} handed over at once`, await confirmPreorder(store, session(n, email) as never, product, deps), "given");
  }
  const has = async (email: string) => typeof (await redis.pipeline([["HGET", importedKey(store.statsId!, email), product.id]]))[0] === "string";
  const dropped: string[] = [];
  const drop = async (email: string, id: string) => void dropped.push(`${email}|${id}`);

  part("Adversarial: an incomplete refunds list cannot move the shared anchor");
  const preorderAnchor = `nl:pre:${store.statsId}:refunds`;
  const [anchorBefore] = await redis.pipeline([["GET", preorderAnchor]]);
  refundsMalformed = true;
  closings = [closing(50, "lost", "pi_tb14unrelated00000001")];
  await revokeRefundedPreorders(store, Date.now() + 10_000, drop);
  const [anchorAfter] = await redis.pipeline([["GET", preorderAnchor]]);
  is("a valid event from the other stream must not advance past unknown refunds", anchorAfter, anchorBefore);
  refundsMalformed = false;

  part("Adversarial: a refund without the status that decides success is unknown");
  refunds = [{
    id: "re_tb14missingstatus0001",
    created: NOW - 4,
    payment_intent: "pi_tb14missingstatus0001",
    charge: { refunded: true },
  }];
  closings = [closing(51, "lost", "pi_tb14unrelated00000002")];
  await revokeRefundedPreorders(store, Date.now() + 10_000, drop);
  const [anchorAfterMissingStatus] = await redis.pipeline([["GET", preorderAnchor]]);
  is("the other stream must not move the anchor past a refund with no outcome", anchorAfterMissingStatus, anchorBefore);

  // Ana's bank took part of the price back through an exchange rate: still the whole order (the owner's rule).
  closings = [closing(2, "won", session(2, "").payment_intent), closing(1, "lost", session(1, "").payment_intent, 2311)];
  refunds = [{ id: "re_tb14part01", created: NOW - 30, status: "succeeded", payment_intent: session(3, "").payment_intent, charge: { refunded: false, amount: 2500, amount_refunded: 900 } }];
  is("one taken back", await revokeRefundedPreorders(store, Date.now() + 10_000, drop), 1);
  is("Ana's, lost for less than the charge, is gone; Ben's dispute won and Cy's part refund keep theirs", [await has("ana@tb14.example"), await has("ben@tb14.example"), await has("cy@tb14.example")], [false, true, true]);
  is("and Ana's pre-order is marked taken back", Boolean((await readPreorder(store, product.id, session(1, "").id))?.revoked), true);
  is("read again, nothing is taken back twice", await revokeRefundedPreorders(store, Date.now() + 10_000, drop), 0);
  is("her course start dropped once", dropped.filter((d) => d.startsWith("ana@")).length, 1);

  part("Pre-orders: a read of the closing events that fails keeps everything and the place");
  closings = [closing(4, "lost", session(4, "").payment_intent), ...closings];
  refunds = [];
  eventsFail = true;
  const failedReads = eventReads;
  is("nothing taken back while Stripe cannot be asked", await revokeRefundedPreorders(store, Date.now() + 10_000, drop), 0);
  is("Dee keeps hers", await has("dee@tb14.example"), true);
  is("the closing events were asked", eventReads > failedReads, true);
  eventsFail = false;
  is("the next run takes it back", await revokeRefundedPreorders(store, Date.now() + 10_000, drop), 1);
  is("Dee's is gone", await has("dee@tb14.example"), false);

  part("Gifts: a lost dispute takes back what the recipient was given");
  closings = [];
  refunds = [];
  const gifts: { id: string; pi: string; to: string }[] = [];
  for (const [n, to] of [[1, "friend1@tb14.example"], [2, "friend2@tb14.example"], [3, "friend3@tb14.example"]] as [number, string][]) {
    const started = await startGift(store, product as Listing, { to, from: "Ana", message: "" });
    if (!started.ok) throw new Error("no gift");
    const pi = `pi_tb14gift${String(n).padStart(8, "0")}`;
    const given = await deliverGift({
      store,
      session: { id: `cs_test_tb14gift${String(n).padStart(8, "0")}`, created: NOW - 600, amount_total: 2500, currency: "usd", payment_intent: pi, metadata: { store: "tb14shop", product: product.id, gift: started.gift.id }, customer_details: { email: "buyer@tb14.example" } } as never,
      product: product as Listing,
      base: deps.base,
      from: deps.from,
      recordStart: async () => {},
      ordersLink: async () => null,
    });
    is(`gift ${n} given`, given, "given");
    gifts.push({ id: started.gift.id, pi, to });
  }
  // Read with the store as it is now: giving the first gift turned on its past buyers (deliverGift).
  const holds = async (email: string) => (await importedFor((await storeForEmail("owner@tb14.example")) as Store, email)).length > 0;
  closings = [closing(12, "won", gifts[1].pi), closing(11, "lost", gifts[0].pi, 1999)];
  is("one taken back", await revokeRefundedGifts(store, Date.now() + 10_000, drop), 1);
  is("the lost one is gone; the won one stays", [await holds(gifts[0].to), await holds(gifts[1].to)], [false, true]);
  is("and the gift is marked taken back", Boolean((await readGift(gifts[0].id))?.revoked), true);
  is("read again, nothing is taken back twice", await revokeRefundedGifts(store, Date.now() + 10_000, drop), 0);

  part("Gifts: a read of the closing events that fails keeps everything and the place");
  closings = [closing(13, "lost", gifts[2].pi), ...closings];
  eventsFail = true;
  is("nothing taken back while Stripe cannot be asked", await revokeRefundedGifts(store, Date.now() + 10_000, drop), 0);
  is("the third recipient keeps it", await holds(gifts[2].to), true);
  eventsFail = false;
  is("the next run takes it back", await revokeRefundedGifts(store, Date.now() + 10_000, drop), 1);
  is("gone", await holds(gifts[2].to), false);

  part("An unknown lookup of the payment's gift or pre-order marks nothing read (Codex Z, review 5794216212)");
  // Only the GET of the payment's gift or pre-order answers in an unknown shape; the next run is healthy.
  const realPipeline = redis.pipeline;
  const hideLookup = (key: string) => {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const answers = await realPipeline(commands);
      return answers.map((answer, at) => (commands[at]?.[0] === "GET" && commands[at]?.[1] === key ? undefined : answer));
    }) as typeof redis.pipeline;
  };
  is("pre-order 5 handed over", await confirmPreorder(store, session(5, "eve@tb14.example") as never, product, deps), "given");
  closings = [closing(60, "lost", session(5, "").payment_intent), ...closings];
  refunds = [];
  hideLookup(`nl:pre:pi:${session(5, "").payment_intent}`);
  try {
    is("pre-orders: nothing taken back while its lookup is unknown", await revokeRefundedPreorders(store, Date.now() + 10_000, drop), 0);
  } finally {
    redis.pipeline = realPipeline;
  }
  is("Eve keeps hers meanwhile", await has("eve@tb14.example"), true);
  is("the next run, with the lookup answered, takes it back", await revokeRefundedPreorders(store, Date.now() + 10_000, drop), 1);
  is("Eve's is gone", await has("eve@tb14.example"), false);
  const late = await startGift(store, product as Listing, { to: "friend4@tb14.example", from: "Ana", message: "" });
  if (!late.ok) throw new Error("no gift");
  const latePi = "pi_tb14gift00000004";
  is("gift 4 given", await deliverGift({
    store,
    session: { id: "cs_test_tb14gift00000004", created: NOW - 600, amount_total: 2500, currency: "usd", payment_intent: latePi, metadata: { store: "tb14shop", product: product.id, gift: late.gift.id }, customer_details: { email: "buyer@tb14.example" } } as never,
    product: product as Listing,
    base: deps.base,
    from: deps.from,
    recordStart: async () => {},
    ordersLink: async () => null,
  }), "given");
  closings = [closing(61, "lost", latePi), ...closings];
  hideLookup(`nl:gift:pi:${latePi}`);
  try {
    is("gifts: nothing taken back while its lookup is unknown", await revokeRefundedGifts(store, Date.now() + 10_000, drop), 0);
  } finally {
    redis.pipeline = realPipeline;
  }
  is("the fourth recipient keeps it meanwhile", await holds("friend4@tb14.example"), true);
  is("the next run, with the lookup answered, takes it back", await revokeRefundedGifts(store, Date.now() + 10_000, drop), 1);
  is("gone", await holds("friend4@tb14.example"), false);

  part("Booked calls: a lost dispute frees the booking's time, as a full refund does");
  const call = (n: number, disputed: boolean) => ({
    id: `cs_test_tb14call${String(n).padStart(8, "0")}`,
    object: "checkout.session",
    created: NOW - 3600,
    status: "complete",
    payment_status: "paid",
    amount_total: 9000,
    currency: "usd",
    metadata: { kind: "call", store: "tb14shop", product: "p_call", title: "A call", start: String((NOW + 86_400 * n) * 1000), end: String((NOW + 86_400 * n + 1800) * 1000) },
    customer_details: { email: `caller${n}@tb14.example`, name: `Caller ${n}` },
    payment_intent: { id: `pi_tb14call${String(n).padStart(8, "0")}`, object: "payment_intent", latest_charge: { object: "charge", id: `ch_tb14call${String(n).padStart(8, "0")}`, refunded: false, amount: 9000, amount_refunded: 0, disputed } },
  });
  const sessionsOf = (rows: { session: string }[]) => rows.map((row) => row.session).sort();
