/**
 * A charge Stripe marks `disputed` keeps that mark after its dispute is closed: won by the merchant, or an inquiry
 * closed without a chargeback (warning_closed). The money then stayed with the merchant, so the closing still owes the
 * member (lib/closing-refunds.ts) or the creator (lib/closing-plan-guard.ts) what it would owe on a charge never
 * disputed. Only the dispute's own status decides, read exactly from Stripe's list of this charge's disputes:
 *   - won or warning_closed (every dispute of the charge): given back once, as an undisputed charge;
 *   - open (the inquiry, chargeback and appeal stages), lost, prevented or the legacy charge_refunded: not given back;
 *   - a list or a row that does not read (a status Stripe does not give, another charge's row, more pages, none listed
 *     although the charge says disputed, Stripe not answering): unknown, never given back on a guess (that could give
 *     the money back twice), and tried again on the next run (rule 24).
 * A charge not marked disputed asks Stripe nothing more. Stripe is a stand-in; nothing real is reached.
 */
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { UNDO_KEY, settleOne } from "@/lib/closing-plan-guard";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6), SEC = DAY / 1000;
const SUB = "sub_DispWon00001", INV = "in_DispWon00001", PI = "pi_DispWon00001", CH = "ch_DispWon00001";
const PLAN = "sub_PlanDispWon01", PLAN_INV = "in_PlanDispWon01", PLAN_PI = "pi_PlanDispWon01", PLAN_CH = "ch_PlanDispWon01";

type Answer = unknown | ((charge: string) => Response);
const world = {
  disputed: true,
  /** What GET /disputes answers: a list body, or a function giving the whole response. */
  disputes: null as Answer,
  disputeReads: 0,
  posts: [] as URLSearchParams[],
  refunds: [] as Record<string, unknown>[],
  planCanceled: false,
};
const list = (data: unknown[], hasMore = false) => ({ object: "list", url: "/v1/disputes", has_more: hasMore, data });
const dispute = (status: unknown, charge: unknown = CH, id = "du_DispWon00001") => ({ id, object: "dispute", amount: 1000, currency: "usd", charge, status });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname;
  const method = init?.method ?? "GET";
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  if (path === "/v1/disputes" && method === "GET") {
    world.disputeReads += 1;
    const answer = world.disputes;
    if (typeof answer === "function") return (answer as (charge: string) => Response)(String(url.searchParams.get("charge")));
    return Response.json(answer);
  }
  // The member's payment, on the creator's account (lib/closing-refunds.ts).
  if (path === "/v1/balance") return Response.json({ object: "balance", available: [{ amount: 100000, currency: "usd" }] });
  if (path === `/v1/payment_intents/${PI}`) {
    const refunded = world.refunds.filter((r) => r.payment_intent === PI && r.status === "succeeded").reduce((sum, r) => sum + Number(r.amount), 0);
    return Response.json({ id: PI, latest_charge: { id: CH, payment_intent: PI, amount: 1000, currency: "usd", amount_refunded: refunded, disputed: world.disputed, balance_transaction: null } });
  }
  // The creator's plan payment, on our own account (lib/closing-plan-guard.ts).
  if (path === `/v1/subscriptions/${PLAN}`) {
    if (method === "DELETE") world.planCanceled = true;
    return Response.json({ id: PLAN, status: world.planCanceled ? "canceled" : "active", created: SEC - 3600 });
  }
  if (path === "/v1/invoices" && method === "GET") {
    return Response.json({ object: "list", has_more: false, data: [{ id: PLAN_INV, status: "paid", amount_paid: 6900, created: SEC - 3600, payment_intent: PLAN_PI, status_transitions: { paid_at: SEC + 600 } }] });
  }
  if (path === `/v1/payment_intents/${PLAN_PI}`) {
    const refunded = world.refunds.filter((r) => r.payment_intent === PLAN_PI && r.status === "succeeded").reduce((sum, r) => sum + Number(r.amount), 0);
    return Response.json({ id: PLAN_PI, latest_charge: { id: PLAN_CH, amount: 6900, currency: "usd", amount_refunded: refunded, disputed: world.disputed } });
  }
  if (path === "/v1/refunds" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    world.posts.push(body);
    const intent = String(body.get("payment_intent"));
    const refund = { object: "refund", id: `re_DispWon${String(world.refunds.length + 1).padStart(5, "0")}`, amount: Number(body.get("amount")), currency: "usd", payment_intent: intent, charge: intent === PI ? CH : PLAN_CH, status: "succeeded", metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) };
    world.refunds.push(refund);
    return Response.json(refund);
  }
  if (path === "/v1/refunds") {
    const intent = url.searchParams.get("payment_intent");
    const charge = url.searchParams.get("charge");
    return Response.json({ object: "list", has_more: false, data: world.refunds.filter((r) => (intent && r.payment_intent === intent) || (charge && r.charge === charge)) });
  }
  return Response.json({ error: { message: `no stand-in for ${method} ${path}` } }, { status: 404 });
}) as typeof fetch;

function reset(disputes: Answer, disputed = true) {
  redis.clear();
  world.disputed = disputed;
  world.disputes = disputes;
  world.disputeReads = 0;
  world.posts = [];
  world.refunds = [];
  world.planCanceled = false;
}

let members = 0;
async function closingMember(label: string, calls = 30, rcalls = 30): Promise<{ store: Store; folder: string }> {
  members += 1;
  const email = `dw-member${members}@example.com`;
  if (!(await claimHandle(email, `dwmember${members}`, `Dispute won (${label})`, "")).ok) throw new Error(`the store for ${label} was not made`);
  const store = { ...(await storeForEmail(email))!, stripeAccountId: "acct_DispWon01" } as Store;
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INV, pi: PI, amt: 1000, tot: 1000, cur: "usd", ps: SEC - 15 * 86400, pe: SEC + 15 * 86400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", calls, "rcalls", rcalls],
  ]);
  return { store, folder };
}
async function settledAs(folder: string) {
  const [raw] = await redis.pipeline([["HGET", paidKey(folder), SUB]]);
  return JSON.parse(String(raw)).r ?? null;
}
const memberPosts = () => world.posts.filter((p) => p.get("payment_intent") === PI);
const planPosts = () => world.posts.filter((p) => p.get("payment_intent") === PLAN_PI);
type Run = Awaited<ReturnType<typeof giveBackUnused>>;
const summary = (r: Run) => (typeof r === "object" ? { done: r.done.map((x) => [x.sub, x.amount]), disputed: r.disputed, failed: r.failed, unmade: r.unmade.length } : r);

async function seedPlan() {
  await redis.pipeline([["HSET", UNDO_KEY, PLAN, JSON.stringify({ h: "dwplan", c: "", to: "", name: "Dispute won", since: DAY, at: DAY, n: 0 })]]);
}
async function planEntry() {
  const [raw] = await redis.pipeline([["HGET", UNDO_KEY, PLAN]]);
  return JSON.parse(String(raw)) as { done?: number; n: number };
}

const OPEN_OR_LOST = ["warning_needs_response", "warning_under_review", "needs_response", "under_review", "appeal_needs_response", "appeal_under_review", "lost", "prevented", "charge_refunded"];
const UNREADABLE: [string, Answer][] = [
  ["a status Stripe does not give", list([dispute("processing")])],
  ["a status missing", list([dispute(undefined)])],
  ["a status not text", list([dispute(7)])],
  ["a row of another charge", list([dispute("won", "ch_SomeoneElse01")])],
  ["a row with no charge", list([dispute("won", null)])],
  ["a row that is not a dispute", list([{ ...dispute("won"), object: "charge" }])],
  ["a row with no id", list([{ ...dispute("won"), id: "" }])],
  ["more pages than read", list([dispute("won")], true)],
  ["no dispute listed although the charge says disputed", list([])],
  ["a reply that is not a list", { object: "dispute", status: "won" }],
  ["has_more not true or false", { object: "list", data: [dispute("won")] }],
  ["Stripe failing", () => Response.json({ error: { type: "api_error", message: "a stand-in failure" } }, { status: 500 })],
];

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_closing_dispute_won";

  part("Members' unused time on the closing day (lib/closing-refunds.ts)");
  for (const status of ["won", "warning_closed"]) {
    reset(list([dispute(status)]));
    const { store, folder } = await closingMember(status);
    const first = await giveBackUnused(store, DAY, { final: true });
    is(`${status}: the member's unused time is given back`, summary(first), { done: [[SUB, 500]], disputed: 0, failed: 0, unmade: 0 });
    is(`${status}: one refund, of the unused part, under the invoice's key`, memberPosts().map((p) => [p.get("amount"), p.get("metadata[closing_refund]")]), [["500", INV]]);
    is(`${status}: settled done`, await settledAs(folder), "done");
    is(`${status}: Stripe was asked once for this charge's disputes`, world.disputeReads, 1);
    await giveBackUnused(store, DAY, { final: true });
    is(`${status}: a second run gives nothing back again`, memberPosts().length, 1);
  }

  for (const status of OPEN_OR_LOST) {
    reset(list([dispute(status)]));
    const { store, folder } = await closingMember(status);
    const got = await giveBackUnused(store, DAY, { final: true });
    is(`${status}: nothing given back, counted disputed`, [summary(got), memberPosts().length, await settledAs(folder)], [{ done: [], disputed: 1, failed: 0, unmade: 0 }, 0, "disputed"]);
  }

  // A charge with two disputes (an inquiry closed, then a chargeback lost): one not closed in the merchant's favor holds it.
  reset(list([dispute("warning_closed", CH, "du_DispWonInq01"), dispute("lost", CH, "du_DispWonCb001")]));
  const two = await closingMember("two");
  is("an inquiry closed and a chargeback lost: nothing given back", [summary(await giveBackUnused(two.store, DAY, { final: true })), memberPosts().length], [{ done: [], disputed: 1, failed: 0, unmade: 0 }, 0]);
  reset(list([dispute("warning_closed", CH, "du_DispWonInq01"), dispute("won", CH, "du_DispWonCb001")]));
  const both = await closingMember("both");
  is("an inquiry closed and a chargeback won: given back once", [summary(await giveBackUnused(both.store, DAY, { final: true })), memberPosts().length], [{ done: [[SUB, 500]], disputed: 0, failed: 0, unmade: 0 }, 1]);

  for (const [label, answer] of UNREADABLE) {
    reset(answer);
    const { store, folder } = await closingMember(label);
    const got = await giveBackUnused(store, DAY, { final: true });
    is(`${label}: unknown, nothing given back, tried again`, [summary(got), memberPosts().length, await settledAs(folder)], [{ done: [], disputed: 0, failed: 1, unmade: 0 }, 0, null]);
    world.disputes = list([dispute("won")]);
    const next = await giveBackUnused(store, DAY, { final: true });
    is(`${label}: read as won on the next run, given back once`, [summary(next), memberPosts().length], [{ done: [[SUB, 500]], disputed: 0, failed: 0, unmade: 0 }, 1]);
  }

  // The dispute list is one more call to the creator's account: taken from the closing's call budget before it is made.
  reset(list([dispute("won")]));
  const spent = await closingMember("spent", 0, 3);
  const over = await giveBackUnused(spent.store, DAY, { final: true });
  is("no call left in the budget for the dispute list: not asked, not given back, told as not made automatically", [summary(over), world.disputeReads, memberPosts().length, await settledAs(spent.folder)], [{ done: [], disputed: 0, failed: 0, unmade: 1 }, 0, 0, "over"]);

  // Control: a charge never disputed asks Stripe nothing about disputes.
  reset(list([dispute("lost")]), false);
  const clean = await closingMember("clean");
  is("control: an undisputed charge is given back without asking about disputes", [summary(await giveBackUnused(clean.store, DAY, { final: true })), world.disputeReads], [{ done: [[SUB, 500]], disputed: 0, failed: 0, unmade: 0 }, 0]);

  part("A plan paid for a closing store (lib/closing-plan-guard.ts)");
  for (const status of ["won", "warning_closed"]) {
    reset(list([dispute(status, PLAN_CH, "du_PlanDispWon1")]));
    await seedPlan();
    is(`${status}: the plan is settled`, await settleOne(PLAN), true);
    is(`${status}: its payment is given back in full, once`, planPosts().map((p) => [p.get("amount"), p.get("metadata[closing_plan]")]), [["6900", PLAN]]);
    await settleOne(PLAN, true);
    is(`${status}: a recheck gives nothing back again`, planPosts().length, 1);
  }
  for (const status of OPEN_OR_LOST) {
    reset(list([dispute(status, PLAN_CH, "du_PlanDispWon1")]));
    await seedPlan();
    is(`${status}: settled as disputed, nothing given back`, [await settleOne(PLAN), planPosts().length], [true, 0]);
  }
  for (const [label, answer] of UNREADABLE) {
    const swapped = typeof answer === "function" ? answer : JSON.parse(JSON.stringify(answer).replaceAll(CH, PLAN_CH));
    reset(swapped);
    await seedPlan();
    is(`${label}: kept in line, nothing given back`, [await settleOne(PLAN), planPosts().length, Boolean((await planEntry()).done)], [false, 0, false]);
    world.disputes = list([dispute("won", PLAN_CH, "du_PlanDispWon1")]);
    is(`${label}: read as won on the next run, given back once`, [await settleOne(PLAN), planPosts().length], [true, 1]);
  }
  reset(list([dispute("lost", PLAN_CH)]), false);
  await seedPlan();
  is("control: an undisputed plan payment is given back without asking about disputes", [await settleOne(PLAN), planPosts().length, world.disputeReads], [true, 1, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
