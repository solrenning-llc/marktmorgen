/**
 * A plan payment whose own dispute closed as `prevented` is decided by the money that dispute itself moved (rule 30;
 * Claude 5's pre-review of claude5/plan-refund-own-dispute, with the rule agreed in the channel by Claude 6 on #3321
 * and Claude 2). Stripe gives `prevented` for two opposite outcomes: a `resolution`, refunded to the buyer before it
 * could become a chargeback, and a `block`, stopped by the card network while the money stays with the seller
 * (payment_method_details.card.case_type, stripe-node 18.5.0 / changelog basil 2025-08-27). case_type is not in the
 * API version these reads are pinned to (2024-06-20; stripe-node added the field in 16.5.0 and its two values in
 * 18.5.0), so the money is read instead: dispute.balance_transactions, "zero, one, or two balance transactions that
 * show funds withdrawn and reinstated" (stripe-node v12.18.0 and v23.1.0 Disputes.d.ts). lib/plan-refund-rules.ts read
 * every `prevented` as given back: a blocked dispute, the plan payment kept, denied a guarantee that is owed, and the
 * window then ran out. Against a stand-in Stripe; nothing real is reached.
 *
 * What fails here:
 *   - a prevented dispute that withdrew nothing, or reinstated all it withdrew, read as given back (guarantee denied);
 *   - a prevented dispute that withdrew the money and kept it read as not given back (the same money out twice);
 *   - a prevented dispute whose balance transactions are missing or not in Stripe's shape read as either (never
 *     decided: unknown, so nothing is paid and nothing is denied for good);
 *   - case_type deciding anything the money does not;
 *   - the appeal stages (appeal_needs_response, appeal_under_review) read as a status Stripe does not give.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { readPlanRefund } from "@/lib/plan-refund";
import { refundPlanPayment } from "@/lib/plan-refund-write";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
const world = {
  customers: new Map<string, string>(),
  subs: new Map<string, Row>(),
  invoices: [] as Row[],
  charges: [] as Row[],
  /** The exact reply to GET /disputes, by the charge asked for. */
  disputes: new Map<string, unknown>(),
  /** Every POST /refunds asked for. */
  refundWrites: [] as string[],
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  const q = url.searchParams;
  const page = (data: unknown[]) => json({ object: "list", data, has_more: false });
  const searchPage = (data: unknown[]) => json({ object: "search_result", data, has_more: false, next_page: null });
  if (method === "POST" && path === "/refunds") {
    const form = new URLSearchParams(String(init?.body));
    world.refundWrites.push(String(form.get("payment_intent")));
    const charge = world.charges.find((c) => c.payment_intent === form.get("payment_intent"))!;
    const amount = Number(form.get("amount"));
    return json({ id: `re_made${world.refundWrites.length}x`, object: "refund", charge: charge.id, payment_intent: charge.payment_intent, amount, currency: "usd", status: "succeeded" });
  }
  if (method !== "GET") return json({ error: { message: `no stand-in for ${method} ${path}` } }, 400);
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1])!;
    const customer = String(row.customer);
    return json({ ...row, customer: { id: customer, email: world.customers.get(customer) ?? "", balance: 0 } });
  }
  if (path === "/invoices") return page(world.invoices.filter((i) => i.subscription === q.get("subscription") && i.status === q.get("status")));
  if (path === "/charges") return page(world.charges.filter((c) => c.customer === q.get("customer")).map((c) => ({ ...c, balance_transaction: "txn_unexpanded" })));
  const charge = path.match(/^\/charges\/(ch_\w+)$/);
  if (charge) return json(world.charges.find((c) => c.id === charge[1]));
  if (path === "/charges/search" || path === "/customers/search") return searchPage([]);
  if (path === "/disputes") return json(world.disputes.get(q.get("charge") ?? "") ?? { object: "list", data: [], has_more: false });
  if (path === "/refunds") return page([]);
  return json({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

let n = 0;
/** A store whose first plan payment, three days ago, Stripe marks `disputed`. */
async function shop(disputed: unknown = true) {
  n += 1;
  const handle = `owndispute${n}`;
  const email = `${handle}@example.com`;
  const customer = `cus_${handle}0001`;
  const subscriptionId = `sub_${handle}0001`;
  await claimHandle(email, handle, `Own dispute ${n}`, "");
  await setSubscription(email, { customerId: customer, subscriptionId, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  world.customers.set(customer, email);
  world.subs.set(subscriptionId, { id: subscriptionId, status: "active", customer, metadata: { store: handle, tier: "creator" } });
  const at = NOW - 3 * DAY;
  const id = `ch_${handle}x1`;
  const inv = `in_${handle}x1`;
  const pi = `pi_${handle}x1`;
  world.invoices.push({ id: inv, subscription: subscriptionId, status: "paid", created: at, total: 6_900, tax: null, billing_reason: "subscription_create", charge: id, status_transitions: { paid_at: at }, lines: { data: [{ type: "subscription", period: { start: at }, price: { unit_amount: 6_900, currency: "usd", recurring: { interval: "month" } } }] } });
  world.charges.push({ id, customer, invoice: inv, payment_intent: pi, status: "succeeded", paid: true, currency: "usd", created: at, amount_captured: 6_900, amount_refunded: 0, disputed, payment_method_details: { card: { fingerprint: `fp${handle}` } }, balance_transaction: { fee: 230, currency: "usd" } });
  const store = async () => (await storeForEmail(email))!;
  return { id, pi, store, read: async () => (await readPlanRefund(await store(), NOW)).refund };
}

const list = (data: unknown[], more = false) => ({ object: "list", data, has_more: more });
/** A balance transaction of a dispute: negative withdrew from the seller's account, positive reinstated to it. */
const move = (amount: unknown) => ({ id: `txn_${Math.abs(Number(amount) || 0)}x${Math.random().toString(36).slice(2, 10)}`, object: "balance_transaction", amount, currency: "usd", fee: 1_500 });
/** A dispute row; `moves` undefined leaves balance_transactions out entirely. */
const dispute = (charge: string, status: string, moves?: unknown, caseType?: string) => ({
  id: `du_${charge.slice(3)}`,
  object: "dispute",
  charge,
  status,
  amount: 6_900,
  currency: "usd",
  ...(moves === undefined ? {} : { balance_transactions: moves }),
  ...(caseType ? { payment_method_details: { type: "card", card: { brand: "visa", case_type: caseType, network_reason_code: "10.4" } } } : {}),
});

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "https://redis.example.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "stand-in-token";

  // Rule 23: the pre-review draft decided `prevented` by case_type (block owed, resolution returned, none unknown).
  // The rule agreed since (Claude 6 on #3321, the coordinator's note) reads the dispute's own money instead, which
  // exists at the pinned version 2024-06-20 where case_type does not; the same three outcomes are asserted below by
  // balance_transactions, and case_type is shown to decide nothing.
  part("prevented: the dispute's own money decides whether it went back");
  const block = await shop();
  world.disputes.set(block.id, list([dispute(block.id, "prevented", [])]));
  is("prevented, nothing withdrawn (a block): the guarantee is owed", await block.read(), { kind: "guarantee", cents: 6_900 });
  const back = await shop();
  world.disputes.set(back.id, list([dispute(back.id, "prevented", [move(-6_900), move(6_900)])]));
  is("prevented, withdrawn then reinstated: the guarantee is owed", await back.read(), { kind: "guarantee", cents: 6_900 });
  const resolution = await shop();
  world.disputes.set(resolution.id, list([dispute(resolution.id, "prevented", [move(-6_900)])]));
  is("prevented, withdrawn and kept (a resolution): nothing more, given back already", await resolution.read(), { kind: "none", reason: "dispute_returned" });
  const partial = await shop();
  world.disputes.set(partial.id, list([dispute(partial.id, "prevented", [move(-6_900)])]));
  (world.disputes.get(partial.id) as { data: Row[] }).data[0].amount = 2_000;
  is("prevented, kept, for part of the charge: unknown, as a partial loss", await partial.read(), { kind: "unknown", reason: "dispute_partial" });

  part("prevented: money that cannot be read is unknown, never paid and never denied");
  for (const [name, moves] of [
    ["no balance_transactions", undefined],
    ["balance_transactions not a list", { object: "list", data: [] }],
    ["an amount that is not whole cents", [move(-69.5)]],
    ["an amount as a string", [move("-6900")]],
    ["a row that is not a balance transaction", [{ id: "txn_x", object: "refund", amount: -6_900 }]],
    ["more reinstated than withdrawn", [move(6_900)]],
    ["more than the two Stripe documents", [move(-6_900), move(6_900), move(-6_900)]],
  ] as const) {
    const s = await shop();
    world.disputes.set(s.id, list([dispute(s.id, "prevented", moves)]));
    is(`${name}: unknown`, await s.read(), { kind: "unknown", reason: "unreadable" });
  }
  const unread = await shop();
  world.disputes.set(unread.id, list([dispute(unread.id, "prevented")]));
  const writesBefore = world.refundWrites.length;
  const made = await refundPlanPayment(await unread.store(), NOW);
  is("and the refund write asks Stripe for nothing on it", { ok: made.ok, writes: world.refundWrites.length - writesBefore }, { ok: false, writes: 0 });

  part("case_type decides nothing the money does not");
  const blockedButTaken = await shop();
  world.disputes.set(blockedButTaken.id, list([dispute(blockedButTaken.id, "prevented", [move(-6_900)], "block")]));
  is("case_type block, money withdrawn and kept: given back", await blockedButTaken.read(), { kind: "none", reason: "dispute_returned" });
  const resolvedNothing = await shop();
  world.disputes.set(resolvedNothing.id, list([dispute(resolvedNothing.id, "prevented", [], "resolution")]));
  is("case_type resolution, nothing withdrawn: the guarantee is owed", await resolvedNothing.read(), { kind: "guarantee", cents: 6_900 });

  part("Controls: lost and won as before");
  const lost = await shop();
  world.disputes.set(lost.id, list([dispute(lost.id, "lost", [move(-6_900)])]));
  is("lost: given back", await lost.read(), { kind: "none", reason: "dispute_returned" });
  const won = await shop();
  world.disputes.set(won.id, list([dispute(won.id, "won", [move(-6_900), move(6_900)])]));
  is("won: the guarantee", await won.read(), { kind: "guarantee", cents: 6_900 });

  // Rule 23: the draft only printed what appeal_under_review read as; it is asserted now. The appeal stages are
  // Stripe's own (stripe-node 23.1.0 Dispute.Status), a decision appealed and not settled again: nothing now, as any
  // open dispute, never "unreadable".
  part("appeal stages are Stripe's own: open, nothing now");
  for (const status of ["appeal_needs_response", "appeal_under_review"]) {
    const appeal = await shop();
    world.disputes.set(appeal.id, list([dispute(appeal.id, status, [move(-6_900)])]));
    is(`${status}: open, nothing now`, await appeal.read(), { kind: "none", reason: "dispute_open" });
  }
  done();
}

void main();
