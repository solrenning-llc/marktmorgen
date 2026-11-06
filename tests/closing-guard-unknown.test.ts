/**
 * The closing day's line read in its exact shape (CX-123 rule 24; proof
 * a299bf95 on claude6/closing-guard-proof, tests/closing-guard-unknown.proof.ts).
 *
 * ZSCORE FINAL_INDEX answers Redis's text of the score (or a number, from a
 * client that parses it) or null when the store is not in the line. Anything
 * else is unknown: `closingSince` (lib/closing-plan-guard.ts) and
 * `inClosingDay` (lib/closing-holds.ts) must throw, so that
 *   - a store that IS in its closing day never has a late plan left running
 *     and unrefunded, nor written down as its plan by the daily sync
 *     (lib/billing-sync.ts, applyListed), because "not closing" was read from
 *     a reply that said nothing;
 *   - a store that is NOT in its closing day never has the plan it paid for
 *     ended and refunded because an empty text or an empty list was read as
 *     the score 0;
 * and the next run, with a readable line, does what the line says.
 *
 * Real code throughout: refuseSession (the way back from Stripe once
 * inClosingDay says yes), syncSubscriptions. Synthetic Stripe, email and
 * Redis stand-ins only; nothing real is reached.
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

/** How a call ended: what it answered, or the name of what it threw. */
async function outcome<T>(run: () => Promise<T>): Promise<{ threw: string } | { gave: T }> {
  try {
    return { gave: await run() };
  } catch (error) {
    return { threw: error instanceof Error ? error.name : String(error) };
  }
}

const SCORE = "1764633600000";
/** Replies that are not a confirmed score or a confirmed absence: each must be refused. */
const UNKNOWN: { name: string; reply: unknown[] }[] = [
  { name: "non-numeric string", reply: ["abc"] },
  { name: "list of one numeric string", reply: [[SCORE]] },
  { name: "list of two", reply: [[SCORE, "x"]] },
  { name: "empty list", reply: [[]] },
  { name: "object", reply: [{ score: SCORE }] },
  { name: "empty string", reply: [""] },
  { name: "score with spaces around it", reply: [` ${SCORE} `] },
  { name: "zero (text)", reply: ["0"] },
  { name: "zero (number)", reply: [0] },
  { name: "negative score", reply: ["-5"] },
  { name: "infinite score", reply: ["inf"] },
  { name: "hexadecimal text", reply: ["0x19c"] },
  { name: "boolean", reply: [true] },
  { name: "result missing from the item", reply: [undefined] },
  { name: "no reply at all", reply: [] },
  { name: "an extra reply after the score", reply: [SCORE, "extra"] },
];

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const day = Date.UTC(2026, 11, 2);
  const quiet = console.error;
  console.error = () => {};
  const adoptedAs = async (email: string, id: string) => {
    const after = (await storeForEmail(email))!;
    return after.subscriptionActive === true && after.subscriptionId === id;
  };

  part("Controls: a confirmed score and a confirmed absence are read as today");
  {
    const back = await planEndedStore("ctlback", day, true);
    const sync = await planEndedStore("ctlsync", day, true);
    is("real score: in its closing day", await inClosingDay(back.ref), true);
    is("real score: the closing times, from the line and the marked address", await closingSince((await storeForEmail(back.email))!), { since: day, ended: day - 30 * DAY });
    is("real score: the way back ends the late plan and returns its payment", [await refuseSession((await storeForEmail(back.email))!, back.session), world.subs.get(back.id)?.status, refundsOf(back.pi)], ["returned", "canceled", [6_900]]);
    await syncSubscriptions(Date.now() + 10_000);
    is("real score: the daily sync ends it, refunds it in full and never writes it down", [world.subs.get(sync.id)?.status, refundsOf(sync.pi), await adoptedAs(sync.email, sync.id)], ["canceled", [6_900], false]);

    const numeric = await planEndedStore("ctlnum", day, true);
    forced.set(numeric.ref, [Number(SCORE)]);
    is("a score given as a number (a client that parses it): read as that score", [await inClosingDay(numeric.ref), await closingSince((await storeForEmail(numeric.email))!)], [true, { since: day, ended: Number(SCORE) }]);
    forced.delete(numeric.ref);

    const open = await planEndedStore("ctlopen", day, false);
    forced.set(open.ref, [null]);
    is("null: not in its closing day", [await inClosingDay(open.ref), await closingSince((await storeForEmail(open.email))!)], [false, null]);
    const counts = await syncSubscriptions(Date.now() + 10_000);
    is("null: the plan that keeps the store runs, is not refunded, and is written down", [world.subs.get(open.id)?.status, refundsOf(open.pi), await adoptedAs(open.email, open.id), counts.failed], ["active", [], true, 0]);
    forced.delete(open.ref);
  }

  for (const [i, shape] of UNKNOWN.entries()) {
    part(`Store in its closing day, the line answers: ${shape.name}`);
    const back = await planEndedStore(`ub${i}x`, day, true);
    const sync = await planEndedStore(`us${i}x`, day, true);
    forced.set(back.ref, shape.reply);
    forced.set(sync.ref, shape.reply);
    is("inClosingDay throws (the checkout takes a throw as closing; the way back says unconfirmed)", await outcome(() => inClosingDay(back.ref)), { threw: "UnknownReplyError" });
    is("closingSince throws", await outcome(async () => closingSince((await storeForEmail(back.email))!)), { threw: "UnknownReplyError" });
    is("the way back throws rather than answering \"no\"", await outcome(async () => refuseSession((await storeForEmail(back.email))!, back.session)), { threw: "UnknownReplyError" });
    const counts = await syncSubscriptions(Date.now() + 10_000);
    is("the daily sync counts both as failed and writes neither down", [counts.failed, await adoptedAs(back.email, back.id), await adoptedAs(sync.email, sync.id)], [2, false, false]);
    is("nothing is refunded on a reply that said nothing", [refundsOf(back.pi), refundsOf(sync.pi)], [[], []]);
    forced.delete(back.ref);
    forced.delete(sync.ref);
    const again = await syncSubscriptions(Date.now() + 10_000);
    is("the next run, the line readable: both ended, refunded in full, never written down", [again.failed, world.subs.get(back.id)?.status, refundsOf(back.pi), world.subs.get(sync.id)?.status, refundsOf(sync.pi), await adoptedAs(sync.email, sync.id)], [0, "canceled", [6_900], "canceled", [6_900], false]);
  }

  for (const [i, shape] of UNKNOWN.entries()) {
    part(`Store NOT in its closing day, the line answers: ${shape.name}`);
    const open = await planEndedStore(`un${i}x`, day, false);
    forced.set(open.ref, shape.reply);
    is("inClosingDay throws", await outcome(() => inClosingDay(open.ref)), { threw: "UnknownReplyError" });
    is("closingSince throws", await outcome(async () => closingSince((await storeForEmail(open.email))!)), { threw: "UnknownReplyError" });
    const counts = await syncSubscriptions(Date.now() + 10_000);
    is("the daily sync counts it as failed: the plan is neither ended, refunded nor written down", [counts.failed, world.subs.get(open.id)?.status, refundsOf(open.pi), await adoptedAs(open.email, open.id)], [1, "active", [], false]);
    forced.delete(open.ref);
    const again = await syncSubscriptions(Date.now() + 10_000);
    is("the next run, the line readable (absent): the plan runs, unrefunded, written down", [again.failed, world.subs.get(open.id)?.status, refundsOf(open.pi), await adoptedAs(open.email, open.id)], [0, "active", [], true]);
  }

  console.error = quiet;
  done();
}

void main();
