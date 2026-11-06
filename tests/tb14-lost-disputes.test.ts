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

  part("Adversarial: every field that decides a closing is read in its exact shape");
  const shaped = (n: number, change: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, unknown> => {
    const event = closing(n, "lost", `pi_tb14shape${String(n).padStart(8, "0")}`);
    return { ...event, ...top, data: { object: { ...(event.data as { object: Record<string, unknown> }).object, ...change } } };
  };
  for (const [label, event] of [
    ["an outcome Stripe does not have", shaped(70, { status: "something_new" })],
    ["an outcome that is not text", shaped(71, { status: 1 })],
    ["a lost dispute without its charge", shaped(72, { charge: null })],
    ["a lost dispute whose charge is not a charge's id", shaped(73, { charge: "not-a-charge" })],
    ["an event whose time is not a number", shaped(74, {}, { created: "now" })],
    ["an event without its dispute", { ...closing(75, "lost", "pi_tb14shape00000075"), data: { object: null } }],
    ["a payment that is neither an id, an object nor nothing", shaped(76, { payment_intent: 42 })],
    ["a payment object whose id is empty", shaped(81, { payment_intent: { id: "" } })],
  ] as [string, Record<string, unknown>][]) {
    closings = [event];
    is(`${label}: the read is incomplete, so nothing moves past it`, (await lostDisputesSince("acct_1TestTb14Lost01", NOW - 600)).complete, false);
  }
  closings = [shaped(77, { status: "warning_closed" }), closing(78, "won", "pi_tb14shape00000078"), shaped(79, { payment_intent: null }), closing(80, "lost", "pi_tb14shape00000080")];
  const knownOutcomes = await lostDisputesSince("acct_1TestTb14Lost01", NOW - 600);
  is("known outcomes read as they are: complete, each lost one a row", [knownOutcomes.complete, knownOutcomes.rows.map((row) => row.id)], [true, ["evt_closed0000000079", "evt_closed0000000080"]]);
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

  part("Adversarial: an empty expanded payment id cannot be completed and passed over");
  closings = [shaped(52, { payment_intent: { id: "" } })];
  refunds = [];
  await revokeRefundedPreorders(store, Date.now() + 10_000, drop);
  is("the anchor stays before a lost dispute whose payment id is unknown", (await redis.pipeline([["GET", preorderAnchor]]))[0], anchorBefore);
  await redis.pipeline([anchorBefore === null ? ["DEL", preorderAnchor] : ["SET", preorderAnchor, String(anchorBefore)]]);

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
  const fullRefund = { created: NOW - 4, status: "succeeded", payment_intent: "pi_tb14refundshape0001", charge: { object: "charge", refunded: true } };
  let r = 0;
  for (const [label, change] of [
    ["an outcome Stripe does not have", { status: "something_new" }],
    ["an outcome that is not text", { status: true }],
    ["a charge left as an id, though it was asked for in full", { charge: "ch_tb14refundshape0001" }],
    ["a charge without whether it was refunded", { charge: { object: "charge" } }],
    ["a payment that is neither an id nor nothing", { payment_intent: 7 }],
  ] as [string, Record<string, unknown>][]) {
    r += 1;
    refunds = [{ id: `re_tb14shape${String(r).padStart(8, "0")}`, ...fullRefund, ...change }];
    closings = [closing(80 + r, "lost", `pi_tb14unrelated${String(r + 10).padStart(8, "0")}`)];
    await revokeRefundedPreorders(store, Date.now() + 10_000, drop);
    is(`pre-orders, a refund with ${label}: the anchor stays`, (await redis.pipeline([["GET", preorderAnchor]]))[0], anchorBefore);
  }
  // The control: every field known, one refund that failed and one charged without a payment, and the anchor moves.
  refunds = [{ id: "re_tb14shape00000090", ...fullRefund, status: "failed", charge: { object: "charge", refunded: false } }, { id: "re_tb14shape00000091", ...fullRefund, payment_intent: null, charge: null }];
  closings = [];
  await revokeRefundedPreorders(store, Date.now() + 10_000, drop);
  is("pre-orders, every field known: the anchor moves", (await redis.pipeline([["GET", preorderAnchor]]))[0] !== anchorBefore, true);
  await redis.pipeline([anchorBefore === null ? ["DEL", preorderAnchor] : ["SET", preorderAnchor, String(anchorBefore)]]);
  refunds = [];

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

  part("Gifts: a refund without the fields that decide it cannot move the anchor");
  const giftAnchor = `nl:gift:${store.statsId}:refunds`;
  const [giftAnchorBefore] = await redis.pipeline([["GET", giftAnchor]]);
  refunds = [{ id: "re_tb14giftshape0001", created: NOW - 3, payment_intent: "pi_tb14giftshape0001", charge: { object: "charge", refunded: true } }];
  const keptClosings = closings;
  closings = [closing(95, "won", "pi_tb14giftshape0002")];
  await revokeRefundedGifts(store, Date.now() + 10_000, drop);
  is("gifts, a refund with no outcome: the anchor stays", (await redis.pipeline([["GET", giftAnchor]]))[0], giftAnchorBefore);
  refunds = [{ id: "re_tb14giftshape0002", created: NOW - 3, status: "succeeded", payment_intent: "pi_tb14giftshape0001", charge: "ch_tb14giftshape0001" }];
  await revokeRefundedGifts(store, Date.now() + 10_000, drop);
  is("gifts, a charge left as an id: the anchor stays", (await redis.pipeline([["GET", giftAnchor]]))[0], giftAnchorBefore);
  refunds = [];
  closings = keptClosings;

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

  part("A write left unknown marks nothing read and keeps the anchor; the next run finishes it (Codex Z, write acknowledgements)");
  // The command matched is not run and is answered with `reply`: a shape no command gives, or a count a write of
  // one item can never return (Codex Z: HDEL, HSET, SADD and EXPIRE of one item answer 0 or 1); the rest run as they are.
  const unknownWrite = (when: (command: (string | number)[]) => boolean, reply: unknown = "QUEUED") => {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const ran = await realPipeline(commands.filter((command) => !when(command)));
      let at = 0;
      return commands.map((command) => (when(command) ? reply : ran[at++]));
    }) as typeof redis.pipeline;
  };
  const read = async (key: string, id: string) => (await realPipeline([["SISMEMBER", key, id]]))[0];
  const preSeen = `nl:pre:${store.statsId}:seen`;
  const giftSeen = `nl:gift:${store.statsId}:seen`;
  const writes: [string, number, string, (command: (string | number)[]) => boolean, unknown?][] = [
    ["the purchase's removal", 6, "fay@tb14.example", (c) => c[0] === "HDEL" && String(c[1]).startsWith("nl:imp:buy:")],
    ["the pre-order's taken-back mark", 7, "gus@tb14.example", (c) => c[0] === "HSET" && c[1] === `nl:pre:${store.statsId}:${product.id}`],
    ["the row's read mark", 8, "hal@tb14.example", (c) => c[0] === "SADD" && c[1] === preSeen],
    ["the purchase's removal answered 2", 9, "ida@tb14.example", (c) => c[0] === "HDEL" && String(c[1]).startsWith("nl:imp:buy:"), 2],
    ["the pre-order's taken-back mark answered 2", 10, "jo@tb14.example", (c) => c[0] === "HSET" && c[1] === `nl:pre:${store.statsId}:${product.id}`, 2],
    ["the pre-order's keep answered 2", 11, "kit@tb14.example", (c) => c[0] === "EXPIRE" && c[1] === `nl:pre:${store.statsId}:${product.id}`, 2],
    ["the row's read mark answered 2", 12, "lu@tb14.example", (c) => c[0] === "SADD" && c[1] === preSeen, 2],
  ];
  for (const [label, n, email, when, reply] of writes) {
    is(`pre-order ${n} handed over`, await confirmPreorder(store, session(n, email) as never, product, deps), "given");
    const event = closing(100 + n, "lost", session(n, "").payment_intent);
    closings = [event];
    refunds = [];
    const anchorThen = (await realPipeline([["GET", preorderAnchor]]))[0];
    unknownWrite(when, reply);
    try {
      await revokeRefundedPreorders(store, Date.now() + 10_000, drop);
    } finally {
      redis.pipeline = realPipeline;
    }
    is(`pre-orders, ${label} unknown: not marked read, and the anchor stays`, [await read(preSeen, String(event.id)), (await realPipeline([["GET", preorderAnchor]]))[0]], [0, anchorThen]);
    await revokeRefundedPreorders(store, Date.now() + 10_000, drop);
    is(`pre-orders, ${label}: the next run finishes it and marks it read`, [await has(email), Boolean((await readPreorder(store, product.id, session(n, "").id))?.revoked), await read(preSeen, String(event.id))], [false, true, 1]);
  }
  let g = 4;
  for (const [label, when, reply] of [
    ["the purchase's removal", (c: (string | number)[]) => c[0] === "HDEL" && String(c[1]).startsWith("nl:imp:buy:")],
    ["the gift's taken-back mark", (c: (string | number)[]) => c[0] === "SET" && String(c[1]).startsWith("nl:gift:g")],
    ["the row's read mark", (c: (string | number)[]) => c[0] === "SADD" && c[1] === giftSeen],
    ["the purchase's removal answered 2", (c: (string | number)[]) => c[0] === "HDEL" && String(c[1]).startsWith("nl:imp:buy:"), 2],
    ["the row's read mark answered 2", (c: (string | number)[]) => c[0] === "SADD" && c[1] === giftSeen, 2],
  ] as [string, (command: (string | number)[]) => boolean, unknown?][]) {
    g += 1;
    const to = `friend${g}@tb14.example`;
    const started = await startGift(store, product as Listing, { to, from: "Ana", message: "" });
    if (!started.ok) throw new Error("no gift");
    const pi = `pi_tb14gift${String(g).padStart(8, "0")}`;
    await deliverGift({
      store,
      session: { id: `cs_test_tb14gift${String(g).padStart(8, "0")}`, created: NOW - 600, amount_total: 2500, currency: "usd", payment_intent: pi, metadata: { store: "tb14shop", product: product.id, gift: started.gift.id }, customer_details: { email: "buyer@tb14.example" } } as never,
      product: product as Listing,
      base: deps.base,
      from: deps.from,
      recordStart: async () => {},
      ordersLink: async () => null,
    });
    const event = closing(110 + g, "lost", pi);
    closings = [event];
    refunds = [];
    const anchorThen = (await realPipeline([["GET", giftAnchor]]))[0];
    unknownWrite(when, reply);
    try {
      await revokeRefundedGifts(store, Date.now() + 10_000, drop);
    } finally {
      redis.pipeline = realPipeline;
    }
    is(`gifts, ${label} unknown: not marked read, and the anchor stays`, [await read(giftSeen, String(event.id)), (await realPipeline([["GET", giftAnchor]]))[0]], [0, anchorThen]);
    await revokeRefundedGifts(store, Date.now() + 10_000, drop);
    is(`gifts, ${label}: the next run finishes it and marks it read`, [await holds(to), Boolean((await readGift(started.gift.id))?.revoked), await read(giftSeen, String(event.id))], [false, true, 1]);
  }

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
  sessions = [call(1, true), call(2, true), call(3, true), call(4, false)];
  disputes["ch_tb14call00000001"] = [{ status: "lost" }];
  disputes["ch_tb14call00000002"] = [{ status: "won" }];
  disputesFail.add("ch_tb14call00000003");
  disputeReads = 0;
  is("the lost one no longer holds its time; the won one, the one Stripe could not be asked about, and the undisputed one do", sessionsOf(await paidCalls(store)), [call(2, true).id, call(3, true).id, call(4, false).id].sort());
  is("three questions, one a disputed charge; none for the undisputed one", disputeReads, 3);
  is("read alone, the lost one is not a paid booking", await paidCall(store, call(1, true).id), null);
  is("and the won one is", (await paidCall(store, call(2, true).id))?.session, call(2, true).id);
  sessions = Array.from({ length: 7 }, (_, i) => call(10 + i, true));
  for (let i = 0; i < 7; i += 1) disputes[`ch_tb14call${String(10 + i).padStart(8, "0")}`] = [{ status: "lost" }];
  disputeReads = 0;
  const left = await paidCalls(store);
  is("past the reading's five questions, a disputed booking keeps its time (never more questions)", [disputeReads, left.length], [5, 2]);

  done();
}

void main();
