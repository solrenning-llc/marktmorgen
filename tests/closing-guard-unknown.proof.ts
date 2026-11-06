/**
 * Proof only (rule 24 candidate, outside the CI run): what lib/closing-plan-guard.ts
 * `closingSince` decides when the closing day's score read (ZSCORE FINAL_INDEX)
 * answers in a shape it does not expect, against `inClosingDay` (lib/closing-holds.ts)
 * reading the same answer. Real callers exercised: refuseSession (the billing return
 * route's call once inClosingDay says yes), refusePlanIfClosing and syncSubscriptions
 * (lib/billing-sync.ts applyListed). Synthetic Stripe and Redis stand-ins only.
 *
 * Run: node tests/g-proof-run.mjs closing-guard-unknown.proof.ts
 * Each `is` states what the code does TODAY; a "BAD:" line is the defect.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { FINAL_INDEX, inClosingDay } from "@/lib/closing-holds";
import { closingSince, markShut, refuseSession } from "@/lib/closing-plan-guard";
import { syncSubscriptions } from "@/lib/billing-sync";
import { redisPipeline } from "@/lib/redis";

const S = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;
type PlanSub = { id: string; status: string; customer: string; metadata: Record<string, string>; created: number };
type Invoice = { id: string; subscription: string; status: string; amount_paid: number; payment_intent: string; created: number; paid_at: number };
type Refund = { id: string; object: "refund"; charge: string; payment_intent: string; amount: number; status: string; currency: string; key: string };

const world = {
  subs: new Map<string, PlanSub>(),
  invoices: [] as Invoice[],
  charges: new Map<string, { amount: number; disputed: boolean }>(),
  refunds: [] as Refund[],
  sessions: [] as Record<string, unknown>[],
  customers: new Map<string, string>(),
  /** Refund requests answered with a server error. */
  refundErrors: 0,
  /** Refunds the bank turns down (status failed). */
  refundsTurnedDown: 0,
  /** What Stripe answered to each idempotency key, and when: Stripe replays it for 24 hours, then forgets it. */
  replies: new Map<string, { at: number; body: string }>(),
  /** The refunds list lags behind: it shows none (Stripe's lists are not always up to the moment). */
  listLags: false,
  expired: [] as string[],
};
const sent: { to: string; subject: string; text: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text?: string };
    sent.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text ?? "" });
    return json({ id: `email_${sent.length}` });
  }
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const headers = new Headers(init?.headers);
  if (headers.get("stripe-account")) return json({ error: { message: "only our own account here" } }, 400);
  const key = headers.get("idempotency-key");
  const kept = key && method === "POST" ? world.replies.get(key) : undefined;
  if (kept && Date.now() - kept.at < 24 * 3_600_000) return new Response(kept.body, { status: 200, headers: { "content-type": "application/json" } });
  const remember = (data: unknown) => {
    if (key && method === "POST") world.replies.set(key, { at: Date.now(), body: JSON.stringify(data) });
    return json(data);
  };
  const path = url.pathname.replace(/^\/v1/, "");
  const form = new URLSearchParams(String(init?.body ?? ""));

  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1]);
    if (!row) return json({ error: { message: "No such subscription" } }, 404);
    if (method === "DELETE") {
      if (row.status === "canceled") return json({ error: { code: "resource_missing", message: "already canceled" } }, 400);
      row.status = "canceled";
    }
    return json({ ...row, items: { data: [] } });
  }
  if (path === "/subscriptions" && method === "GET") {
    const data = [...world.subs.values()].map((row) => ({ ...row, customer: { id: row.customer, email: world.customers.get(row.customer) ?? "" }, items: { data: [] } }));
    return json({ object: "list", data, has_more: false });
  }
  if (path === "/subscriptions/search") return json({ object: "search_result", data: [], has_more: false, next_page: null });
  if (path === "/invoices" && method === "GET") {
    const data = world.invoices.filter((row) => row.subscription === url.searchParams.get("subscription")).map((row) => ({ ...row, status_transitions: { paid_at: row.paid_at || null } }));
    return json({ object: "list", data, has_more: false });
  }
  const voided = path.match(/^\/invoices\/(in_\w+)\/void$/);
  if (voided) {
    const row = world.invoices.find((invoice) => invoice.id === voided[1]);
    if (row) row.status = "void";
    return remember({ id: voided[1], status: "void" });
  }
  const intent = path.match(/^\/payment_intents\/(pi_\w+)$/);
  if (intent) {
    const charge = world.charges.get(intent[1]);
    if (!charge) return json({ error: { message: "No such payment_intent" } }, 404);
    // As Stripe keeps it: what refunds that have not failed took back.
    const refunded = world.refunds.filter((row) => row.payment_intent === intent[1] && (row.status === "succeeded" || row.status === "pending")).reduce((sum, row) => sum + row.amount, 0);
    return json({ id: intent[1], latest_charge: { id: `ch_${intent[1].slice(3)}`, currency: "usd", amount: charge.amount, amount_refunded: refunded, disputed: charge.disputed } });
  }
  if (path === "/refunds" && method === "GET") return json({ object: "list", data: world.listLags ? [] : world.refunds.filter((row) => row.charge === url.searchParams.get("charge")), has_more: false });
  if (path === "/refunds" && method === "POST") {
    if (world.refundErrors > 0) {
      world.refundErrors -= 1;
      return json({ error: { type: "api_error", message: "a stand-in failure" } }, 500);
    }
    const pi = String(form.get("payment_intent"));
    const status = world.refundsTurnedDown > 0 ? "failed" : "succeeded";
    if (status === "failed") world.refundsTurnedDown -= 1;
    const refund: Refund = { id: `re_${String(world.refunds.length + 1).padStart(8, "0")}`, object: "refund", charge: `ch_${pi.slice(3)}`, payment_intent: pi, amount: Number(form.get("amount")), status, currency: "usd", key: key ?? "" };
    world.refunds.push(refund);
    return remember(refund);
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) return json({ id: customer[1], email: world.customers.get(customer[1]) ?? null });
  if (path === "/checkout/sessions" && method === "GET") {
    const data = world.sessions.filter((row) => row.status === (url.searchParams.get("status") ?? row.status) && row.customer === url.searchParams.get("customer"));
    return json({ object: "list", data, has_more: false });
  }
  const session = path.match(/^\/checkout\/sessions\/(cs_\w+)(\/expire)?$/);
  if (session) {
    const row = world.sessions.find((one) => one.id === session[1]);
    if (!row) return json({ error: { message: "No such checkout session" } }, 404);
    if (session[2]) {
      if (row.status !== "open") return json({ error: { message: "Only Checkout Sessions with a status of open can be expired." } }, 400);
      row.status = "expired";
      world.expired.push(String(row.id));
      return remember(row);
    }
    return json(row);
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A store whose plan ended. `closing`: in its closing day since `day` (in FINAL_INDEX, address marked); otherwise in its closing period only. A plan finished on the day, paid. */
async function planEndedStore(handle: string, day: number, closing: boolean) {
  const email = `${handle}@example.com`;
  const customer = `cus_${handle}0001`;
  await claimHandle(email, handle, `${handle} Shop`, "");
  await setSubscription(email, { customerId: customer, subscriptionId: `sub_${handle}old001`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  world.customers.set(customer, email);
  const store = (await storeForEmail(email))!;
  if (closing) {
    await redisPipeline([["ZADD", FINAL_INDEX, day - 30 * DAY, storeRef(store)]]);
    await markShut(store, day);
  }
  const id = `sub_${handle}late01`;
  world.subs.set(id, { id, status: "active", customer, metadata: { store: handle, tier: "creator" }, created: S(day) - 3_600 });
  const pi = `pi_${handle}late01`;
  world.invoices.push({ id: `in_${handle}late01`, subscription: id, status: "paid", amount_paid: 6_900, payment_intent: pi, created: S(day) - 3_600, paid_at: S(day) + 600 });
  world.charges.set(pi, { amount: 6_900, disputed: false });
  const session = `cs_test_${handle}late0001`;
  world.sessions.push({ id: session, status: "complete", mode: "subscription", customer, subscription: id, metadata: { store: handle } });
  return { email, id, pi, ref: storeRef(store), session };
}

/** Answers the score read for these refs with `reply` (the whole pipeline answer); every other command as the stand-in does. */
const realPipeline = redis.pipeline.bind(redis);
const forced = new Map<string, unknown[]>();
redis.pipeline = ((commands: (string | number)[][]) => {
  const c = commands[0];
  if (commands.length === 1 && c[0] === "ZSCORE" && c[1] === FINAL_INDEX && forced.has(String(c[2]))) return Promise.resolve(forced.get(String(c[2]))!);
  return realPipeline(commands);
}) as typeof redis.pipeline;

const refundsOf = (pi: string) => world.refunds.filter((row) => row.payment_intent === pi).map((row) => row.amount);

type Shape = { name: string; reply: unknown[] | null };
const SHAPES: Shape[] = [
  { name: "real score (control: closing)", reply: null },
  { name: "non-numeric string 'abc'", reply: ["abc"] },
  { name: "number (as JSON number)", reply: [1_764_633_600_000] },
  { name: "list of one numeric string", reply: [["1764633600000"]] },
  { name: "list of two", reply: [["1764633600000", "x"]] },
  { name: "empty list", reply: [[]] },
  { name: "object", reply: [{ score: "1764633600000" }] },
  { name: "empty string", reply: [""] },
  { name: "missing reply (no result)", reply: [] },
  { name: "extra reply after the score", reply: ["1764633600000", "extra"] },
  { name: "null (store absent from the line)", reply: [null] },
];

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const day = Date.UTC(2026, 11, 2);
  const quiet = console.error;
  console.error = () => {};
  const rows: string[] = [];

  for (const [i, shape] of SHAPES.entries()) {
    part(`Closing store, score reply: ${shape.name}`);
    // Two stores in their closing day: one for the way back, one for the daily sync.
    const back = await planEndedStore(`cb${i}x`, day, true);
    const sync = await planEndedStore(`cs${i}x`, day, true);
    if (shape.reply) { forced.set(back.ref, shape.reply); forced.set(sync.ref, shape.reply); }
    const holds = await inClosingDay(back.ref);
    const since = await closingSince((await storeForEmail(back.email))!);
    // app/api/billing/return/route.ts: inClosingDay true -> refuseSession; never setSubscription.
    const returned = holds ? await refuseSession((await storeForEmail(back.email))!, back.session) : "(route would adopt via readStartedSubscription)";
    await syncSubscriptions(Date.now() + 10_000);
    const after = (await storeForEmail(sync.email))!;
    const r = {
      inClosingDay: holds,
      closingSince: since === null ? null : since,
      wayBack: returned,
      wayBackSub: world.subs.get(back.id)?.status,
      wayBackRefund: refundsOf(back.pi),
      syncSub: world.subs.get(sync.id)?.status,
      syncRefund: refundsOf(sync.pi),
      syncAdopted: after.subscriptionActive === true && after.subscriptionId === sync.id,
    };
    rows.push(`${shape.name}: ${JSON.stringify(r)}`);
    const safe = r.wayBackSub === "canceled" && r.wayBackRefund.join() === "6900" && r.syncSub === "canceled" && r.syncRefund.join() === "6900" && !r.syncAdopted;
    const isControl = shape.name.startsWith("real score");
    if (isControl) is("control: ended, refunded in full, never adopted", safe, true);
    else is(safe ? "fails safe: ended, refunded, not adopted" : "BAD: a plan paid on the closing day is left running and unrefunded" + (r.syncAdopted ? ", and the sync writes it down as the store's plan" : ""), r, r);
    (globalThis as { verdicts?: string[] }).verdicts = [...((globalThis as { verdicts?: string[] }).verdicts ?? []), `${safe ? "SAFE" : shape.reply?.length === 1 && shape.reply[0] === null ? "OPEN (control: the line itself says absent)" : "OPEN"} closing   ${shape.name}`];
  }

  for (const [i, shape] of SHAPES.entries()) {
    part(`Store NOT in its closing day (plan ended, closing period only), score reply: ${shape.name}`);
    const s = await planEndedStore(`nb${i}x`, day, false);
    if (shape.reply) forced.set(s.ref, shape.reply);
    const holds = await inClosingDay(s.ref);
    const since = await closingSince((await storeForEmail(s.email))!);
    await syncSubscriptions(Date.now() + 10_000);
    const after = (await storeForEmail(s.email))!;
    const r = { inClosingDay: holds, closingSince: since === null ? null : since, sub: world.subs.get(s.id)?.status, refund: refundsOf(s.pi), adopted: after.subscriptionActive === true && after.subscriptionId === s.id };
    rows.push(`not-closing ${shape.name}: ${JSON.stringify(r)}`);
    const kept = r.sub === "active" && r.refund.length === 0;
    const isControl = shape.name.startsWith("real score") || shape.name.startsWith("null");
    if (isControl) is("control: the plan that saves the store runs and is not refunded", kept, true);
    else is(kept ? "not refused" : "refused: a store that is not closing loses the plan it paid for (refunded)", r, r);
    (globalThis as { verdicts?: string[] }).verdicts = [...((globalThis as { verdicts?: string[] }).verdicts ?? []), `${kept ? "KEPT" : since && since.ended === 0 ? "DENIED (unreadable score read as ended=0)" : "DENIED (a numeric score is present: correct)"} not-closing ${shape.name}`];
  }

  console.error = quiet;
  part("Summary");
  for (const v of (globalThis as { verdicts?: string[] }).verdicts ?? []) console.log(`  ${v}`);
  part("Rows");
  for (const row of rows) console.log(`  ${row}`);
  done();
}

void main();
