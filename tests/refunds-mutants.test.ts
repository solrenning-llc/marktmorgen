/**
 * Mutation testing of lib/refunds.ts (Claude 7, 13/11/2026): each case kills a
 * mutant that survived every test importing the module. These are the rules
 * every door uses to close a purchase that was given back: a refund or a lost
 * dispute must be proven, an unreadable row or event is unknown and never
 * crashes the job, and a read's place moves only when the read is whole.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts.
 */
import {
  confirmLostRead,
  disputeLost,
  givenBack,
  lostCursorKey,
  lostDisputesOrRetry,
  lostDisputesSince,
  purchaseRefunded,
  refundRowKnown,
  refundedInFull,
  rowGivesBack,
} from "@/lib/refunds";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_refunds_mutants_synthetic";
const ACCOUNT = "acct_refundmut01";
const INVOICE = "in_refundmut0001";
const INTENT = "pi_refundmut0001";

let calls: string[] = [];
let queries: URLSearchParams[] = [];
let eventPages: unknown[] = [];
let failEvents = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  calls.push(path);
  if (path === "/events") {
    if (failEvents) throw new Error("synthetic network failure");
    queries.push(url.searchParams);
    return Response.json(eventPages.length > 1 ? eventPages.shift() : eventPages[0]);
  }
  if (path === `/invoices/${INVOICE}`) return Response.json({ id: INVOICE, object: "invoice", payment_intent: INTENT });
  if (path.startsWith("/payment_intents/")) {
    return Response.json({ id: INTENT, object: "payment_intent", latest_charge: { object: "charge", id: "ch_refundmut0001", payment_intent: INTENT, amount: 2000, amount_refunded: 2000, refunded: true } });
  }
  if (path === "/disputes") return Response.json({ object: "list", data: [{ id: "du_refundmut01", charge: "ch_refundmut0001", status: "lost" }], has_more: false });
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

const charge = (over: Record<string, unknown> = {}) => ({ object: "charge", id: "ch_refundmut0001", amount: 2000, amount_refunded: 0, refunded: false, disputed: false, ...over });
const refund = (over: Record<string, unknown> = {}) => ({ id: "re_refundmut01", created: 1_790_000_000, status: "succeeded", payment_intent: INTENT, charge: { refunded: true }, ...over });
const closing = (id: unknown, dispute: Record<string, unknown>, created = 1_790_000_100) => ({ id, object: "event", created, data: { object: { object: "dispute", status: "lost", charge: "ch_refundmut0001", payment_intent: INTENT, ...dispute } } });
const page = (data: unknown[], has_more = false) => ({ object: "list", data, has_more });

async function main() {
  part("A charge given back in full");
  is("marked refunded, whatever the amounts say", refundedInFull(charge({ refunded: true, amount_refunded: 0 })), true);
  is("a zero charge with nothing back is not given back", refundedInFull(charge({ amount: 0, amount_refunded: 0 })), false);

  part("A refund row read whole");
  is("a whole row", refundRowKnown(refund()), true);
  is("no row", refundRowKnown(null), false);
  is("an id that is not text", refundRowKnown(refund({ id: 5 })), false);
  is("an empty id", refundRowKnown(refund({ id: "" })), false);
  is("no creation time", refundRowKnown(refund({ created: undefined })), false);

  part("Rows that give a sale back");
  is("a dispute won on a charge refunded apart does not", rowGivesBack({ object: "dispute", status: "won", charge: charge({ refunded: true }) }), false);
  is("a failed refund does not, even on a refunded charge", rowGivesBack({ object: "refund", status: "failed", charge: charge({ refunded: true }) }), false);
  is("a pending full refund does", rowGivesBack({ object: "refund", status: "pending", charge: charge({ refunded: true }) }), true);

  part("A dispute lost");
  calls = [];
  is("no payment is not lost, never a crash", await disputeLost(ACCOUNT, null), false);
  is("lost on the charge itself, without asking", await disputeLost(ACCOUNT, charge({ id: "ch_bad", disputed: true, dispute: { status: "lost" } })), true);
  is("a charge id that cannot be read is not lost", await disputeLost(ACCOUNT, charge({ id: "ch_bad", disputed: true })), false);
  is("and neither asked Stripe", calls, []);
  is("no account and nothing refunded is not given back", await givenBack(null, charge()), false);

  part("A purchase refunded");
  const plan = { mode: "subscription", invoice: INVOICE, payment_intent: null, metadata: { kind: "plan" } };
  is("a plan's first payment refunded in full", await purchaseRefunded(ACCOUNT, plan), true);
  calls = [];
  is("a one-off payment is not read as a plan", await purchaseRefunded(ACCOUNT, { ...plan, mode: "payment" }), false);
  is("an invoice id that does not read", await purchaseRefunded(ACCOUNT, { ...plan, invoice: "in_bad" }), false);
  is("no account", await purchaseRefunded(null, plan), false);
  is("none of them asked Stripe", calls, []);

  part("Closing events");
  const since = 1_790_000_000;
  eventPages = [page([null])];
  is("a null event leaves the read incomplete", (await lostDisputesSince(ACCOUNT, since)).complete, false);
  eventPages = [page([closing(5, {})])];
  is("an event id that is not text: incomplete, nothing found", await lostDisputesSince(ACCOUNT, since).then((r) => [r.complete, r.rows.length]), [false, 0]);
  eventPages = [page([{ id: "evt_refundmut01", object: "event", created: since + 1, data: null }])];
  is("an event with no data: incomplete", (await lostDisputesSince(ACCOUNT, since)).complete, false);
  eventPages = [page([closing("evt_refundmut01", { payment_intent: { id: INTENT, object: "payment_intent" } })])];
  const expanded = await lostDisputesSince(ACCOUNT, since);
  is("an expanded payment is read", [expanded.complete, expanded.rows.map((r) => r.payment_intent)], [true, [INTENT]]);
  is("a read with no place kept is not resumed", expanded.resumed, false);

  queries = [];
  eventPages = [page([], false)];
  await lostDisputesSince(ACCOUNT, since + 0.5);
  is("the window starts at the whole second", queries[0]?.get("created[gte]"), String(since));

  queries = [];
  eventPages = [page([closing("evt_refundmut01", {})], true)];
  const one = await lostDisputesSince(ACCOUNT, since, Number.POSITIVE_INFINITY, 1);
  is("one page asked for is one page read", [queries.length, one.complete], [1, false]);

  const realNow = Date.now;
  Date.now = () => 5_000_000;
  calls = [];
  const late = await lostDisputesSince(ACCOUNT, since, 5_000_000);
  Date.now = realNow;
  is("a deadline reached at this very millisecond reads nothing", [late.complete, calls.length], [false, 0]);

  const key = lostCursorKey("mutants", "store1");
  await redis.pipeline([["SET", key, `${since}|evt_refundmut99|0`]]);
  queries = [];
  eventPages = [page([], false)];
  const resumed = await lostDisputesSince(ACCOUNT, since + 0.25, Number.POSITIVE_INFINITY, 3, key);
  is("a kept place with no closing yet is followed, for a window read in whole seconds", [resumed.resumed, queries[0]?.get("starting_after")], [true, "evt_refundmut99"]);

  eventPages = [page([closing("evt_refundmut02", {})], true), page([], false)];
  const moved = await lostDisputesSince(ACCOUNT, since, Number.POSITIVE_INFINITY, 1, key);
  await moved.commit();
  is("an incomplete read keeps its place once committed", (await redis.pipeline([["GET", key]]))[0], `${since}|evt_refundmut02|1790000100`);

  failEvents = true;
  const failed = await lostDisputesOrRetry(ACCOUNT, since);
  failEvents = false;
  is("a read that failed is not resumed and not complete", [failed.complete, failed.resumed, failed.rows.length], [false, false, 0]);

  part("Confirming a read");
  const seen = "nl:mutants:seen";
  await redis.pipeline([["SADD", seen, "evt_a"]]);
  let committed = false;
  const read = (ids: string[]) => ({ rows: ids.map((id) => ({ id })), complete: true, newest: 0, resumed: false, commit: async () => { await new Promise((wait) => setTimeout(wait, 20)); committed = true; } });
  is("a row not handled yet keeps the place", [await confirmLostRead(read(["evt_a", "evt_b"]), seen), committed], [false, false]);
  is("every row handled: the place moves, once committed", [await confirmLostRead(read(["evt_a"]), seen), committed], [true, true]);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
