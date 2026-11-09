/**
 * A payment taken after a plan's own end is given back (lib/plans.ts and lib/plan-late-refunds.ts; the owner's
 * decision of 9 November 2026, item 12: "Parcela cobrada depois da data final: reembolso automático, idempotente, e
 * cancelar o que restar do agendamento. A data foi prometida ao comprador.").
 *
 * Checked against a stand-in for the creator's Stripe account:
 *
 *   - a plan past its end has what is left of its schedule ended (DELETE), and every payment Stripe took after the
 *     end (an invoice created at or after it) refunded in full, once, under an idempotency key and a mark of its
 *     own invoice; a second pass refunds nothing more;
 *   - a payment inside the plan's term is never refunded, even when Stripe's list holds it;
 *   - a disputed payment is never refunded (the buyer's bank already gives it back);
 *   - a refund already made under the invoice's mark is never made again, even when the charge does not show it yet;
 *   - an answer that cannot be read (the list of invoices, the refund's reply) refunds nothing more on a guess and
 *     does not settle the plan: it stays in its line, and the next pass finds the refund already made;
 *   - a balance that does not cover the refund: nothing is attempted, the plan stays in its line to be tried again;
 *   - a plan Stripe already canceled after its end still has its late payments refunded (a pass that ended it and
 *     could not refund);
 *   - a plan canceled at or before its own end reads no invoices at all;
 *   - a try stays within the registry's Stripe calls (PLAN_SETTLE_RUN in tests/plan-cost-registry.ts);
 *   - the reviews of #3367 at 9489992283 (Claude 3, MEDIUM 1 and 2; Claude 6, N1): a payment Stripe refuses to refund
 *     for good (a 4xx such as charge_expired_for_refund) is left owed and the others are still refunded in the same
 *     pass; a refund Stripe answers pending is not money given back: the plan stays in its line, is read again, and
 *     settles only once the refund reads succeeded; one that then fails is made again.
 */
import { addPeriods, finishPlan, rememberPlan, settlePlans } from "@/lib/plans";
import { LATE_REFUND_CALLS, LATE_REFUNDS_PER_TRY } from "@/lib/plan-late-refunds";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_late_refund";

const ACCOUNT = "acct_1TestPlansLate1";
const DAY = 86_400;
const realNow = Date.now;
const clock = Math.floor(realNow() / 1000);
Date.now = () => clock * 1000;

type Charge = { id: string; object: "charge"; payment_intent: string; amount: number; amount_refunded: number; disputed: boolean; currency: string; balance_transaction: { amount: number; currency: string }; invoice: string };
type Invoice = { id: string; object: "invoice"; subscription: string; status: string; created: number; amount_paid: number; paid_out_of_band: boolean; charge: Charge };
type Refund = { id: string; object: "refund"; payment_intent: string; amount: number; currency: string; status: string; metadata: Record<string, string> };

const sessions: Record<string, Record<string, unknown>> = {};
const subscriptions: Record<string, Record<string, unknown>> = {};
const invoices: Record<string, Invoice[]> = {};
/** Refunds Stripe made, by payment intent. */
const refunds: Record<string, Refund[]> = {};
/** Every POST /refunds sent, with its idempotency key and body. */
const posts: { key: string | null; body: URLSearchParams }[] = [];
/** Idempotency keys already answered: a repeat gets the same refund, never a second. */
const keyed = new Map<string, Refund>();
const cancels: string[] = [];
const invoiceQueries: URLSearchParams[] = [];
let balance = 1_000_000;
let stripeCalls = 0;
/** When set, the reply to the next POST /refunds (the refund is still made at Stripe, as on a reply lost on the way). */
let refundReply: unknown = null;
/** When set, what GET /invoices answers. */
let invoiceList: unknown = null;
/** While true, a refund made does not show on its charge's amount_refunded (Stripe's objects read at different times). */
let chargeLags = false;
/** The status Stripe gives a refund it makes. */
let refundStatus = "succeeded";
/** Payment intents whose refund Stripe refuses for good (a 400 with this code). */
const refusedFor = new Map<string, string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname !== "api.stripe.com") return answer({ object: "list", data: [], has_more: false });
  stripeCalls += 1;
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session) return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "No such checkout" } }, 404);
  const sub = /^\/subscriptions\/(sub_[A-Za-z0-9]+)$/.exec(path);
  if (sub && method === "GET") return answer(subscriptions[sub[1]] ?? {});
  if (sub && method === "DELETE") {
    cancels.push(sub[1]);
    subscriptions[sub[1]] = { ...subscriptions[sub[1]], status: "canceled", ended_at: clock };
    return answer(subscriptions[sub[1]]);
  }
  if (sub && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    subscriptions[sub[1]] = { ...subscriptions[sub[1]], cancel_at: Number(body.get("cancel_at")) };
    return answer(subscriptions[sub[1]]);
  }
  if (path === "/invoices" && method === "GET") {
    invoiceQueries.push(url.searchParams);
    if (invoiceList !== null) return answer(invoiceList);
    // Filtered by subscription only: the code must not trust the list to hold only payments after the end.
    const rows = (invoices[url.searchParams.get("subscription") ?? ""] ?? []).filter((row) => row.status === "paid");
    return answer({ object: "list", data: rows, has_more: false, url: "/v1/invoices" });
  }
  if (path === "/balance" && method === "GET") return answer({ object: "balance", available: [{ amount: balance, currency: "usd" }], pending: [] });
  if (path === "/refunds" && method === "GET") {
    const intent = url.searchParams.get("payment_intent") ?? "";
    return answer({ object: "list", data: refunds[intent] ?? [], has_more: false, url: "/v1/refunds" });
  }
  if (path === "/refunds" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const key = headers["Idempotency-Key"] ?? null;
    posts.push({ key, body });
    const again = key ? keyed.get(key) : undefined;
    if (again) return answer(again);
    const intent = body.get("payment_intent") ?? "";
    const charge = Object.values(invoices).flat().map((row) => row.charge).find((c) => c.payment_intent === intent);
    if (!charge) return answer({ error: { message: "No such payment_intent" } }, 404);
    if (charge.disputed) return answer({ error: { type: "invalid_request_error", code: "charge_disputed", message: "disputed" } }, 400);
    const refused = refusedFor.get(intent);
    if (refused) return answer({ error: { type: "invalid_request_error", code: refused, message: "This charge can no longer be refunded." } }, 400);
    const amount = Number(body.get("amount") ?? charge.amount - charge.amount_refunded);
    const made: Refund = { id: `re_${intent.slice(3)}${(refunds[intent]?.length ?? 0) + 1}`, object: "refund", payment_intent: intent, amount, currency: "usd", status: refundStatus, metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) };
    (refunds[intent] ??= []).push(made);
    if (!chargeLags) charge.amount_refunded += amount;
    balance -= amount;
    if (key) keyed.set(key, made);
    if (refundReply !== null) {
      const reply = refundReply;
      refundReply = null;
      return answer(reply);
    }
    return answer(made);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

let serial = 0;
/** A monthly plan of `payments`, its first payment `ago` days back, with one paid invoice per month Stripe charged. */
function plan(payments: number, ago: number, charged: number, over: Record<string, unknown> = {}): { session: string; sub: string; end: number; invoices: Invoice[] } {
  serial += 1;
  const tag = `late${String(serial).padStart(8, "0")}`;
  const session = `cs_test_${tag}`;
  const sub = `sub_${tag}`;
  const anchor = clock - ago * DAY;
  sessions[session] = { id: session, status: "complete", subscription: sub, metadata: { store: "harbor", kind: "plan", plan_payments: String(payments), plan_interval: "month" } };
  subscriptions[sub] = { id: sub, status: "active", billing_cycle_anchor: anchor, trial_end: null, ...over };
  invoices[sub] = Array.from({ length: charged }, (_, i) => {
    const id = `in_${tag}x${i}`;
    const intent = `pi_${tag}x${i}`;
    return {
      id,
      object: "invoice" as const,
      subscription: sub,
      status: "paid",
      created: addPeriods(anchor, "month", i),
      amount_paid: 5_000,
      paid_out_of_band: false,
      charge: { id: `ch_${tag}x${i}`, object: "charge" as const, payment_intent: intent, amount: 5_000, amount_refunded: 0, disputed: false, currency: "usd", balance_transaction: { amount: 5_000, currency: "usd" }, invoice: id },
    };
  });
  return { session, sub, end: addPeriods(anchor, "month", payments), invoices: invoices[sub] };
}
const madeFor = (row: Invoice) => refunds[row.charge.payment_intent] ?? [];
const inALine = async (session: string) => {
  const [pending, retry] = await redis.pipeline([["SMEMBERS", "nl:plans:pending"], ["ZRANGEBYSCORE", "nl:plans:retry", "-inf", "+inf"]]);
  return [...(pending as string[]), ...(retry as string[])].some((m) => m.startsWith(`${ACCOUNT}|${session}|`));
};
const reset = () => {
  posts.length = 0;
  cancels.length = 0;
  invoiceQueries.length = 0;
  refundReply = null;
  invoiceList = null;
  chargeLags = false;
  refundStatus = "succeeded";
  refusedFor.clear();
  balance = 1_000_000;
};

async function main(): Promise<void> {
  const realError = console.error;
  console.error = () => {};
  redis.clear();

  part("A payment taken after the plan's end is refunded once; the rest of the schedule is ended");
  reset();
  // Three monthly payments; Stripe kept charging: five taken, the fourth and fifth after the end.
  const a = plan(3, 130, 5);
  await rememberPlan(ACCOUNT, a.session);
  const first = await settlePlans();
  is("what is left of the schedule is ended (DELETE)", cancels, [a.sub]);
  is("the two payments after the end are refunded, each once and in full", a.invoices.map((row) => madeFor(row).map((r) => r.amount)), [[], [], [], [5_000], [5_000]]);
  is("each under its own invoice's idempotency key and mark", posts.map((p) => [p.key, p.body.get("metadata[plan_late_refund]")]), [a.invoices[3], a.invoices[4]].map((row) => [`plan-late-refund:${row.id}`, row.id]));
  is("the invoices asked for are the subscription's paid ones from its end on", invoiceQueries.map((q) => [q.get("subscription"), q.get("status"), q.get("created[gte]")]), [[a.sub, "paid", String(a.end)]]);
  is("the plan is settled and out of its lines", [first.done, await inALine(a.session)], [1, false]);
  posts.length = 0;
  is("a second pass, the subscription canceled, refunds nothing more", [await finishPlan(ACCOUNT, a.session), posts.length], ["done", 0]);

  part("A payment inside the plan's term is never refunded");
  reset();
  // Stopped at its third payment: nothing taken after the end, though the list holds every payment.
  const b = plan(3, 100, 3);
  is("ended, nothing refunded", [await finishPlan(ACCOUNT, b.session), cancels, posts.length], ["done", [b.sub], 0]);

  part("A disputed payment is never refunded");
  reset();
  const c = plan(2, 100, 4);
  c.invoices[2].charge.disputed = true;
  is("settled, only the undisputed late payment refunded", [await finishPlan(ACCOUNT, c.session), madeFor(c.invoices[2]).length, madeFor(c.invoices[3]).length], ["done", 0, 1]);
  is("no refund was even asked for the disputed one", posts.filter((p) => p.body.get("payment_intent") === c.invoices[2].charge.payment_intent).length, 0);

  part("A refund already made under the invoice's mark is never made again");
  reset();
  const d = plan(2, 70, 3);
  chargeLags = true;
  is("refunded once", [await finishPlan(ACCOUNT, d.session), madeFor(d.invoices[2]).length], ["done", 1]);
  posts.length = 0;
  // The charge does not show it yet; the refunds list does.
  is("a second pass reads the refund made and sends none", [await finishPlan(ACCOUNT, d.session), posts.length, madeFor(d.invoices[2]).length], ["done", 0, 1]);

  part("Unknown is never settled, and never refunded again on a guess");
  reset();
  const e = plan(2, 70, 3);
  refundReply = { id: "re_unreadable", object: "refund", status: "processing_maybe" };
  const unknown = await finishPlan(ACCOUNT, e.session).catch(() => "threw");
  is("a refund's reply that does not read does not settle the plan", unknown === "done", false);
  await rememberPlan(ACCOUNT, e.session);
  posts.length = 0;
  const after = await finishPlan(ACCOUNT, e.session);
  is("the next pass finds the refund made and sends no other", [after, posts.length, madeFor(e.invoices[2]).length], ["done", 0, 1]);
  reset();
  const f = plan(2, 70, 3);
  invoiceList = { object: "list", data: f.invoices, has_more: true };
  const partial = await finishPlan(ACCOUNT, f.session).catch(() => "threw");
  is("a list of invoices that is not whole refunds nothing and does not settle", [partial === "done", posts.length], [false, 0]);
  invoiceList = { object: "list", data: [{ id: f.invoices[2].id, object: "invoice" }], has_more: false };
  const shapeless = await finishPlan(ACCOUNT, f.session).catch(() => "threw");
  is("an invoice that does not read refunds nothing and does not settle", [shapeless === "done", posts.length], [false, 0]);

  part("A balance that does not cover the refund: nothing attempted, the plan kept");
  reset();
  const g = plan(2, 70, 3);
  balance = 1_000;
  await rememberPlan(ACCOUNT, g.session);
  await settlePlans();
  is("no refund asked, the plan still in its line", [posts.length, await inALine(g.session)], [0, true]);

  part("A plan Stripe already canceled after its end still has its late payments refunded");
  reset();
  const h = plan(2, 70, 3, { status: "canceled", ended_at: clock - 5 * DAY });
  is("refunded once, then settled", [await finishPlan(ACCOUNT, h.session), madeFor(h.invoices[2]).length, cancels.length], ["done", 1, 0]);
  reset();
  const k = plan(2, 70, 2);
  subscriptions[k.sub] = { ...subscriptions[k.sub], status: "canceled", ended_at: k.end };
  is("one canceled at its own end reads no invoices", [await finishPlan(ACCOUNT, k.session), invoiceQueries.length], ["done", 0]);

  part("A payment Stripe refuses to refund for good is left owed; the others are still refunded (Claude 3, MEDIUM 1)");
  reset();
  const r = plan(2, 130, 5);
  refusedFor.set(r.invoices[2].charge.payment_intent, "charge_expired_for_refund");
  await rememberPlan(ACCOUNT, r.session);
  const refusedRun = await settlePlans();
  is("the two refundable late payments are refunded in the same pass", [madeFor(r.invoices[3]).length, madeFor(r.invoices[4]).length], [1, 1]);
  is("the refused one is not, and the plan is kept as owed, not as a failure", [madeFor(r.invoices[2]).length, refusedRun.owed, refusedRun.failed, await inALine(r.session)], [0, 1, 0, true]);

  part("A refund Stripe answers pending is not given back yet (Claude 3, MEDIUM 2; Claude 6, N1)");
  reset();
  const p = plan(2, 70, 3);
  refundStatus = "pending";
  await rememberPlan(ACCOUNT, p.session);
  const pendingRun = await settlePlans();
  is("refunded once, pending: the plan is not settled and stays in its line", [madeFor(p.invoices[2]).length, pendingRun.done, await inALine(p.session)], [1, 0, true]);
  posts.length = 0;
  is("read again while pending: no second refund, still owed", [await finishPlan(ACCOUNT, p.session), posts.length], ["owed", 0]);
  // Stripe fails it later; its idempotency key is forgotten after a day.
  const pendingRefund = madeFor(p.invoices[2])[0];
  pendingRefund.status = "failed";
  p.invoices[2].charge.amount_refunded = 0;
  balance += pendingRefund.amount;
  keyed.clear();
  refundStatus = "succeeded";
  is("failed later: made again, and settled once it reads succeeded", [await finishPlan(ACCOUNT, p.session), madeFor(p.invoices[2]).map((one) => one.status)], ["done", ["failed", "succeeded"]]);

  part("A try stays within the registry's Stripe calls");
  reset();
  const declared = (registry as Record<string, unknown>).PLAN_SETTLE_RUN as Record<string, number>;
  const m = plan(2, 240, 8);
  stripeCalls = 0;
  await finishPlan(ACCOUNT, m.session).catch(() => "threw");
  is("calls within stripeCallsPerPlanTried", stripeCalls <= declared.stripeCallsPerPlanTried, true);
  is("the registry names the late refunds a try makes", typeof declared.lateRefundsPerTry, "number");
  is("and they are the code's: the plan's three calls and LATE_REFUND_CALLS", [declared.lateRefundsPerTry, declared.stripeCallsPerPlanTried], [LATE_REFUNDS_PER_TRY, 3 + LATE_REFUND_CALLS]);
  // Six late payments, LATE_REFUNDS_PER_TRY a try: every one refunded, once, after enough passes.
  for (let pass = 0; pass < 6; pass += 1) await finishPlan(ACCOUNT, m.session).catch(() => "threw");
  is("every late payment refunded once in the end", m.invoices.map((row) => madeFor(row).length), [0, 0, 1, 1, 1, 1, 1, 1]);

  console.error = realError;
  Date.now = realNow;
  done();
}
void main();
