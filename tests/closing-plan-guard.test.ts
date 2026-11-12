/**
 * A plan paid for a store whose closing day has begun (queue item 307
 * [EC1], held to item 569 [NC1]), against a stand-in for our own Stripe
 * account and the email sender. Nothing real is reached.
 *
 * What fails here:
 *   - a plan finished during the closing day that is written down as the
 *     store's, or left running, or not refunded in full;
 *   - a retry of the way back, of the daily sync or of the closing job that
 *     refunds twice or tells the creator twice;
 *   - a refund that failed (an error, or one the bank turned down) that is
 *     not tried again, or that is dropped from the line;
 *   - a payment made before the day began that is refunded;
 *   - an open plan checkout of the store left open when the day starts, or
 *     another store's expired with it;
 *   - a store whose records are gone that is no longer recognized.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { FINAL_INDEX, inClosingDay } from "@/lib/closing-holds";
import { prepareStore } from "@/lib/closed-store-data";
import { UNDO_KEY, expirePlanCheckouts, markShut, planReturnedLetter, refusePlanIfClosing, refuseSession, retryPlanUndos } from "@/lib/closing-plan-guard";
import { syncSubscriptions } from "@/lib/billing-sync";
import { closeOne, type Hands } from "@/lib/plan-closing";
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

/** A store whose plan ended, in its closing day since `day`, with a plan checkout finished on that day and paid. */
async function closingStore(handle: string, day: number, amount = 6_900) {
  const email = `${handle}@example.com`;
  const customer = `cus_${handle}0001`;
  await claimHandle(email, handle, `${handle[0].toUpperCase()}${handle.slice(1)} Shop`, "");
  await setSubscription(email, { customerId: customer, subscriptionId: `sub_${handle}old001`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  world.customers.set(customer, email);
  await redisPipeline([["ZADD", FINAL_INDEX, day - 30 * DAY, storeRef((await storeForEmail(email))!)]]);
  await markShut((await storeForEmail(email))!, day);
  const id = `sub_${handle}late01`;
  world.subs.set(id, { id, status: "active", customer, metadata: { store: handle, tier: "creator" }, created: S(day) - 3_600 });
  const pi = `pi_${handle}late01`;
  world.invoices.push({ id: `in_${handle}late01`, subscription: id, status: "paid", amount_paid: amount, payment_intent: pi, created: S(day) - 3_600, paid_at: S(day) + 600 });
  world.charges.set(pi, { amount, disputed: false });
  world.sessions.push({ id: `cs_test_${handle}late0001`, status: "complete", mode: "subscription", customer, subscription: id, metadata: { store: handle } });
  return { email, id, pi, customer };
}

const refundsOf = (pi: string) => world.refunds.filter((row) => row.payment_intent === pi);
const undo = async (id: string) => {
  const [raw] = await redisPipeline([["HGET", UNDO_KEY, id]]);
  return typeof raw === "string" ? (JSON.parse(raw) as { n: number; done?: number; to: string }) : null;
};

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const day = Date.UTC(2026, 11, 2);

  part("The race: a plan checkout opened before the closing day and finished on it");
  const rosa = await closingStore("rosa", day);
  const back = await refuseSession((await storeForEmail(rosa.email))!, "cs_test_rosalate0001");
  is("the way back ends it and returns the payment at once", back, "returned");
  is("the subscription is canceled at Stripe", world.subs.get(rosa.id)?.status, "canceled");
  is("the payment is refunded in full, once", refundsOf(rosa.pi).map((row) => [row.amount, row.status]), [[6_900, "succeeded"]]);
  is("the plan is never written down as the store's", [(await storeForEmail(rosa.email))?.subscriptionActive, (await storeForEmail(rosa.email))?.subscriptionId], [false, "sub_rosaold001"]);
  const told = sent.filter((m) => m.to === rosa.email);
  is("the creator is told once, honestly, that the store had closed and the payment was returned", [told.length, told[0]?.subject, told[0]?.text.includes("had already begun closing"), told[0]?.text.includes("$69 in full"), told[0]?.text.includes("Nothing else will be charged")], [1, "Rosa Shop: your plan payment was returned", true, true, true]);
  is("settled, it keeps only its dates", [(await undo(rosa.id))?.to, Boolean((await undo(rosa.id))?.done)], ["", true]);

  part("Retries: the way back twice, the daily sync and the closing job");
  is("the way back again changes nothing", await refuseSession((await storeForEmail(rosa.email))!, "cs_test_rosalate0001"), "returned");
  is("asked again directly, the same", await refusePlanIfClosing({ store: (await storeForEmail(rosa.email))!, handle: "rosa", subscriptionId: rosa.id, customerId: rosa.customer }), "returned");
  await retryPlanUndos(Date.now() + 10_000);
  is("still one refund and one letter", [refundsOf(rosa.pi).length, sent.filter((m) => m.to === rosa.email).length], [1, 1]);

  part("A refund the bank sends back after it was settled");
  refundsOf(rosa.pi)[0].status = "failed";
  await retryPlanUndos(Date.now() + 10_000);
  is("the next run makes it again, under a new key, and does not write again", [refundsOf(rosa.pi).map((row) => row.status), new Set(refundsOf(rosa.pi).map((row) => row.key)).size, sent.filter((m) => m.to === rosa.email).length], [["failed", "succeeded"], 2, 1]);
  await retryPlanUndos(Date.now() + 10_000);
  is("and once it went through, nothing more", refundsOf(rosa.pi).length, 2);

  part("Rechecks over the 40 days never refund twice, after Stripe has forgotten the keys or while its list lags");
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + 25 * 3_600_000;
  await retryPlanUndos(Date.now() + 10_000);
  world.listLags = true;
  Date.now = () => realNow() + 50 * 3_600_000;
  await retryPlanUndos(Date.now() + 10_000);
  world.listLags = false;
  Date.now = realNow;
  is("still the one refund that went through, and one letter", [refundsOf(rosa.pi).filter((row) => row.status === "succeeded").length, refundsOf(rosa.pi).length, sent.filter((m) => m.to === rosa.email).length], [1, 2, 1]);

  part("The store's own plan from before its closing day, still able to charge: ended, nothing refunded, no letter");
  const uma = await closingStore("uma", day);
  world.subs.set("sub_umaold0001", { id: "sub_umaold0001", status: "past_due", customer: uma.customer, metadata: { store: "uma", tier: "creator" }, created: S(day) - 60 * 86_400 });
  world.invoices.push({ id: "in_umaold0001", subscription: "sub_umaold0001", status: "paid", amount_paid: 6_900, payment_intent: "pi_umaold0001", created: S(day) - 60 * 86_400, paid_at: S(day) - 60 * 86_400 });
  world.charges.set("pi_umaold0001", { amount: 6_900, disputed: false });
  const umaBefore = sent.filter((m) => m.to === uma.email).length;
  await refusePlanIfClosing({ store: (await storeForEmail(uma.email))!, handle: "uma", subscriptionId: "sub_umaold0001", customerId: uma.customer });
  is("it can charge no more, its old payment stays, and the creator is not told of a payment that never was", [world.subs.get("sub_umaold0001")?.status, refundsOf("pi_umaold0001").length, sent.filter((m) => m.to === uma.email).length - umaBefore], ["canceled", 0, 0]);

  part("A plan paid by card three minutes before the day, found only once the day has begun: refunded, and the creator told");
  const dora = await closingStore("dora", day);
  world.subs.set("sub_doralate02", { id: "sub_doralate02", status: "active", customer: dora.customer, metadata: { store: "dora", tier: "creator" }, created: S(day) - 180 });
  world.invoices.push({ id: "in_doralate02", subscription: "sub_doralate02", status: "paid", amount_paid: 6_900, payment_intent: "pi_doralate02", created: S(day) - 180, paid_at: S(day) - 180 });
  world.charges.set("pi_doralate02", { amount: 6_900, disputed: false });
  const doraBefore = sent.filter((m) => m.to === dora.email).length;
  await refusePlanIfClosing({ store: (await storeForEmail(dora.email))!, handle: "dora", subscriptionId: "sub_doralate02", customerId: dora.customer });
  is("a plan started after the last one ended is refunded whatever minute it was paid, and its creator told", [world.subs.get("sub_doralate02")?.status, refundsOf("pi_doralate02").map((row) => row.amount), sent.filter((m) => m.to === dora.email).length - doraBefore], ["canceled", [6_900], 1]);
  const doraLetter = sent.filter((m) => m.to === dora.email).at(-1)?.text ?? "";
  is("its letter says truthfully it came too late to stop the closing, not that it was paid once the day had begun", [doraLetter.includes("too late to stop"), doraLetter.includes("could not be given"), doraLetter.includes("$69 in full")], [true, false, true]);
  const rosaLetter = sent.find((m) => m.to === rosa.email)?.text ?? "";
  is("a plan paid once the day had begun keeps its own words", [rosaLetter.includes("had already begun closing on Marktmorgen when this plan went through, so the plan could not be given"), rosaLetter.includes("too late to stop")], [true, false]);

  part("A store already deleted, its plan found by the daily sync: one started after its last plan ended is refunded, never taken for its old one");
  const goneTwo = { handle: "gone-two", previousHandles: [], releasedHandles: [] };
  await markShut(goneTwo, day, day - 30 * 86_400_000);
  world.customers.set("cus_gonetwo01", "gonetwo@example.com");
  world.subs.set("sub_gonetwo001", { id: "sub_gonetwo001", status: "active", customer: "cus_gonetwo01", metadata: { store: "gone-two" }, created: S(day) - 10 * 86_400 });
  world.invoices.push({ id: "in_gonetwo001", subscription: "sub_gonetwo001", status: "paid", amount_paid: 6_900, payment_intent: "pi_gonetwo001", created: S(day) - 10 * 86_400, paid_at: S(day) - 10 * 86_400 });
  world.charges.set("pi_gonetwo001", { amount: 6_900, disputed: false });
  await refusePlanIfClosing({ store: null, handle: "gone-two", subscriptionId: "sub_gonetwo001", customerId: "cus_gonetwo01" });
  is("refunded in full and its creator told, from the end of its last plan kept with the address's mark", [world.subs.get("sub_gonetwo001")?.status, refundsOf("pi_gonetwo001").map((row) => row.amount), sent.filter((m) => m.to === "gonetwo@example.com").length], ["canceled", [6_900], 1]);

  part("The letter is marked sent as soon as it goes: a write that fails after it, and a retry days later, never send a second");
  const ezra = await closingStore("ezra", day);
  const realPipeline = redis.pipeline.bind(redis);
  let failDone = true;
  redis.pipeline = ((commands: (string | number)[][]) => {
    if (failDone && commands.some((c) => c[0] === "HSET" && c[1] === UNDO_KEY && String(c[3]).includes('"done":'))) {
      failDone = false;
      return Promise.reject(new Error("a stand-in failure of the database"));
    }
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const quiet = console.error;
  console.error = () => {};
  await refusePlanIfClosing({ store: (await storeForEmail(ezra.email))!, handle: "ezra", subscriptionId: ezra.id, customerId: ezra.customer });
  const ezraFirst = sent.filter((m) => m.to === ezra.email).length;
  const nowWas = Date.now.bind(Date);
  Date.now = () => nowWas() + 30 * 3_600_000;
  await retryPlanUndos(Date.now() + 10_000);
  Date.now = nowWas;
  console.error = quiet;
  redis.pipeline = realPipeline;
  is("one letter, though the settled mark failed once and the retry came after Stripe and the sender forgot the keys", [ezraFirst, sent.filter((m) => m.to === ezra.email).length, refundsOf(ezra.pi).length], [1, 1, 1]);

  part("The daily sync finds a plan paid during the closing day before the way back did");
  const tina = await closingStore("tina", day);
  const synced = await syncSubscriptions(Date.now() + 10_000);
  is("it is not adopted", [synced.adopted, (await storeForEmail(tina.email))?.subscriptionActive], [0, false]);
  is("it is ended and refunded in full, and the creator told", [world.subs.get(tina.id)?.status, refundsOf(tina.pi).map((row) => row.amount), sent.filter((m) => m.to === tina.email).length], ["canceled", [6_900], 1]);
  await syncSubscriptions(Date.now() + 10_000);
  is("a second sync refunds nothing more", [refundsOf(tina.pi).length, sent.filter((m) => m.to === tina.email).length], [1, 1]);

  part("A refund that fails is tried again on every run, and never dropped");
  const sara = await closingStore("sara", day, 69_000);
  world.refundErrors = 2;
  is("Stripe failing to refund leaves it in line, not settled", await refuseSession((await storeForEmail(sara.email))!, "cs_test_saralate0001"), "returning");
  is("ended already, nothing refunded, nobody told yet", [world.subs.get(sara.id)?.status, refundsOf(sara.pi).length, sent.filter((m) => m.to === sara.email).length], ["canceled", 0, 0]);
  is("in line, with the failed run counted", (await undo(sara.id))?.n, 1);
  let run = await retryPlanUndos(Date.now() + 10_000);
  is("the next run fails too and keeps it", [run.left, (await undo(sara.id))?.n, Boolean((await undo(sara.id))?.done)], [1, 2, false]);
  run = await retryPlanUndos(Date.now() + 10_000);
  is("the run after refunds it in full, once, and tells the creator", [run.settled, refundsOf(sara.pi).map((row) => row.amount), sent.filter((m) => m.to === sara.email).length], [1, [69_000], 1]);

  const lena = await closingStore("lena", day);
  world.refundsTurnedDown = 1;
  is("a refund the bank turns down is not taken as returned", await refusePlanIfClosing({ store: (await storeForEmail(lena.email))!, handle: "lena", subscriptionId: lena.id, customerId: lena.customer }), "returning");
  run = await retryPlanUndos(Date.now() + 10_000);
  const lenaRefunds = refundsOf(lena.pi);
  is("the next run makes it again under a new key, and it goes through", [lenaRefunds.map((row) => row.status), new Set(lenaRefunds.map((row) => row.key)).size, run.settled], [["failed", "succeeded"], 2, 1]);
  is("the creator is told once, with the amount that came back", [sent.filter((m) => m.to === lena.email).length, sent.find((m) => m.to === lena.email)?.text.includes("$69 in full")], [1, true]);

  part("Only what was paid since the day began");
  const nora = await closingStore("nora", day);
  world.invoices.push({ id: "in_noraearly1", subscription: nora.id, status: "paid", amount_paid: 6_900, payment_intent: "pi_noraearly1", created: S(day) - 40 * 86_400, paid_at: S(day) - 40 * 86_400 });
  world.charges.set("pi_noraearly1", { amount: 6_900, disputed: false });
  world.invoices.push({ id: "in_noraopen01", subscription: nora.id, status: "open", amount_paid: 0, payment_intent: "", created: S(day) + 60, paid_at: 0 });
  await refusePlanIfClosing({ store: (await storeForEmail(nora.email))!, handle: "nora", subscriptionId: nora.id, customerId: nora.customer });
  is("a payment from before the day is not refunded; the one on it is", [refundsOf("pi_noraearly1").length, refundsOf(nora.pi).length], [0, 1]);
  is("an open invoice of it is voided, so it is never collected", world.invoices.find((row) => row.id === "in_noraopen01")?.status, "void");

  part("Not closing: nothing is touched");
  const owen = `owen@example.com`;
  await claimHandle(owen, "owen", "Owen Shop", "");
  world.subs.set("sub_owenplan01", { id: "sub_owenplan01", status: "active", customer: "cus_owen0001", metadata: { store: "owen" }, created: S(day) });
  is("a store with a running plan is not in a closing day", await refusePlanIfClosing({ store: (await storeForEmail(owen))!, handle: "owen", subscriptionId: "sub_owenplan01", customerId: "cus_owen0001" }), "no");
  is("and its plan runs", world.subs.get("sub_owenplan01")?.status, "active");

  part("A store whose records are gone is still known by its marked address");
  const gone = { handle: "gone-shop", previousHandles: [], releasedHandles: [] };
  await markShut(gone, day);
  world.customers.set("cus_gone0001", "gone@example.com");
  world.subs.set("sub_gonelate01", { id: "sub_gonelate01", status: "active", customer: "cus_gone0001", metadata: { store: "gone-shop" }, created: S(day) });
  world.invoices.push({ id: "in_gonelate01", subscription: "sub_gonelate01", status: "paid", amount_paid: 6_900, payment_intent: "pi_gonelate01", created: S(day) + 60, paid_at: S(day) + 60 });
  world.charges.set("pi_gonelate01", { amount: 6_900, disputed: false });
  is("ended and returned, the creator told at the customer's address", [await refusePlanIfClosing({ store: null, handle: "gone-shop", subscriptionId: "sub_gonelate01", customerId: "cus_gone0001" }), refundsOf("pi_gonelate01").length, sent.filter((m) => m.to === "gone@example.com").length], ["returned", 1, 1]);
  is("an address never marked is left alone", await refusePlanIfClosing({ store: null, handle: "never-closed", subscriptionId: "sub_neverclosed1", customerId: "cus_never0001" }), "no");

  part("Once a closing store's record goes, a new store its owner opens is never taken for it");
  const vera = await closingStore("vera", day);
  const veraOld = (await storeForEmail(vera.email))!;
  await prepareStore(veraOld);
  is("the closed store leaves the closing day's line with its record", await inClosingDay(storeRef(veraOld)), false);
  await claimHandle(vera.email, "vera-new", "Vera New", "");
  const veraNew = (await storeForEmail(vera.email))!;
  world.subs.set("sub_veranew001", { id: "sub_veranew001", status: "active", customer: vera.customer, metadata: { store: "vera-new" }, created: S(day) + 3_600 });
  const veraLetters = sent.filter((m) => m.to === vera.email).length;
  is("the new store's plan is its own: not refused, not ended, nobody written to", [veraNew.handle, await refusePlanIfClosing({ store: veraNew, handle: "vera-new", subscriptionId: "sub_veranew001", customerId: vera.customer }), world.subs.get("sub_veranew001")?.status, sent.filter((m) => m.to === vera.email).length - veraLetters], ["vera-new", "no", "active", 0]);
  is("a plan paid under the closed store's address is still found by its mark", await refusePlanIfClosing({ store: null, handle: "vera", subscriptionId: vera.id, customerId: vera.customer }), "returned");

  part("When the day starts, the store's open plan checkouts are expired");
  world.sessions.push(
    { id: "cs_test_rosaopen00001", status: "open", mode: "subscription", customer: rosa.customer, metadata: { store: "rosa" } },
    { id: "cs_test_rosaother0001", status: "open", mode: "subscription", customer: rosa.customer, metadata: { store: "rosa-two" } },
    { id: "cs_test_rosaaddon0001", status: "open", mode: "payment", customer: rosa.customer, metadata: { store: "rosa" } },
  );
  const expired = await expirePlanCheckouts((await storeForEmail(rosa.email))!, [rosa.customer]);
  is("only its own open plan checkout is expired", [expired, world.expired], [1, ["cs_test_rosaopen00001"]]);
  is("another store's checkout is not this store's to refuse or expire", [await refuseSession((await storeForEmail(rosa.email))!, "cs_test_rosaother0001"), world.expired.length], ["no", 1]);
  world.sessions.push({ id: "cs_test_rosaopen00002", status: "open", mode: "subscription", customer: rosa.customer, metadata: { store: "rosa" } });
  is("one of its own still open when met on the way back is expired there", [await refuseSession((await storeForEmail(rosa.email))!, "cs_test_rosaopen00002"), world.expired.at(-1)], ["no", "cs_test_rosaopen00002"]);

  part("A stopped late plan's queued refund outlives the closing store");
  const handoff = await closingStore("handoff", day);
  const handoffStore = (await storeForEmail(handoff.email))!;
  const originalFetch = globalThis.fetch;
  let refusedEnd = "", planReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/v1/subscriptions/search" || url.pathname === "/v1/subscriptions") planReads++;
    if (refusedEnd && url.pathname === `/v1/subscriptions/${refusedEnd}` && init?.method === "DELETE") return Response.json({ error: { message: "synthetic cancellation failure" } }, { status: 503 });
    const response = await originalFetch(input, init);
    if (url.pathname === "/v1/subscriptions" && (init?.method ?? "GET") === "GET") {
      const page = await response.json() as { data: Record<string, unknown>[]; has_more: boolean };
      return Response.json({ ...page, data: page.data.map(row => String((row.metadata as { store?: string })?.store).startsWith("handoff") ? {
        ...row, cancel_at: null, cancel_at_period_end: false, items: { data: [{ quantity: 1, current_period_start: S(day) - 86400, current_period_end: S(day) + 30 * 86400,
          price: { lookup_key: "nimbus_creator_month", currency: "usd", unit_amount: 6900, recurring: { interval: "month", interval_count: 1 } } }] },
      } : row) });
    }
    return response;
  };
  const noFiles: Hands = { measure: async () => 0, list: async () => [], remove: async () => {} };
  try {
    world.refundErrors = 1;
    const closed = await closeOne(storeRef(handoffStore), day + 60_000, noFiles, Number.POSITIVE_INFINITY);
    is("closing uses the same two observations without a third customer-list read", planReads, 2);
    is("a confirmed stopped plan and self-contained refund queue do not retain the store's files", [world.subs.get(handoff.id)?.status, closed.state], ["canceled", "removed"]);
    is("the failed refund keeps the creator and obligation in its independent queue", [(await undo(handoff.id))?.to, Boolean((await undo(handoff.id))?.done), refundsOf(handoff.pi).length], [handoff.email, false, 0]);
    await prepareStore(handoffStore);
    is("erasing the store does not erase its pending plan refund", (await undo(handoff.id))?.to, handoff.email);
    world.refundErrors = 0;
    await retryPlanUndos(Number.POSITIVE_INFINITY);
    is("the independent worker refunds once after the store is gone", [refundsOf(handoff.pi).map(row => [row.amount, row.status]), Boolean((await undo(handoff.id))?.done)], [[[6900, "succeeded"]], true]);
    await retryPlanUndos(Number.POSITIVE_INFINITY);
    is("a second worker pass never refunds twice", refundsOf(handoff.pi).length, 1);

    const corrupt = await closingStore("handoffbad", day);
    const corruptStore = (await storeForEmail(corrupt.email))!;
    await redisPipeline([["HSET", UNDO_KEY, corrupt.id, "not readable"]]);
    const keptCorrupt = await closeOne(storeRef(corruptStore), day + 60_000, noFiles, Number.POSITIVE_INFINITY);
    is("returning with an unreadable queue is not proof of a stopped plan or a recoverable refund", [keptCorrupt.state, world.subs.get(corrupt.id)?.status], ["held", "active"]);
    await redisPipeline([["HDEL", UNDO_KEY, corrupt.id]]);

    const uncertain = await closingStore("handoffhold", day);
    refusedEnd = uncertain.id;
    const keptActive = await closeOne(storeRef((await storeForEmail(uncertain.email))!), day + 60_000, noFiles, Number.POSITIVE_INFINITY);
    is("a readable queue without confirmed cancellation cannot release file retention", [keptActive.state, world.subs.get(uncertain.id)?.status, Boolean((await undo(uncertain.id))?.done)], ["held", "active", false]);
    refusedEnd = "";

    const lost = await closingStore("handofflost", day);
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = async commands => commands.some(command => command[0] === "HSETNX" && command[1] === UNDO_KEY && command[2] === lost.id) ? [undefined] : pipeline(commands);
    try {
      const outcome = await refusePlanIfClosing({ store: (await storeForEmail(lost.email))!, handle: "handofflost", subscriptionId: lost.id, customerId: lost.customer });
      is("a missing queue acknowledgement never reports an active plan as returned", [outcome, world.subs.get(lost.id)?.status, refundsOf(lost.pi).length], ["returning", "active", 0]);
    } finally { redis.pipeline = pipeline; }

    const unread = await closingStore("handoffcs", day);
    const unreadStore = (await storeForEmail(unread.email))!;
    world.sessions.push({ id: "cs_test_handoffcsopen1", status: "open", mode: "subscription", customer: unread.customer, metadata: { store: "handoffcs" } });
    // Its closing day entered and its renewals not stopped yet (lib/plan-closing.ts, stateKey): the step that expires its checkouts runs.
    await redisPipeline([["SET", `nl:plan:closing:${createHash("sha256").update(storeRef(unreadStore)).digest("hex").slice(0, 40)}`, JSON.stringify({ of: day - 30 * DAY, day })]]);
    const seen = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/v1/checkout/sessions" && (init?.method ?? "GET") === "GET") return Response.json({ object: "list", data: "garbled", has_more: false });
      return seen(input, init);
    };
    const quietClose = console.error;
    console.error = () => {};
    let unreadClose: Awaited<ReturnType<typeof closeOne>>;
    try { unreadClose = await closeOne(storeRef(unreadStore), day + 60_000, noFiles, Number.POSITIVE_INFINITY); } finally { globalThis.fetch = seen; console.error = quietClose; }
    is("open plan checkouts that cannot be read hold the closing day, to be tried again", [unreadClose.state, world.expired.includes("cs_test_handoffcsopen1")], ["held", false]);
    await closeOne(storeRef(unreadStore), day + 120_000, noFiles, Number.POSITIVE_INFINITY);
    is("the next run reads them and expires the store's open plan checkout", world.expired.includes("cs_test_handoffcsopen1"), true);

    // The platform's checkout list fails while the creator's own account answers: its members' renewals are still
    // stopped on that run (a day's renewal is a charge whose fee never comes back), and the day is held for the checkouts.
    const renew = await closingStore("handoffrn", day);
    await setStripeAccount(renew.email, "acct_handoffrn1");
    const renewStore = (await storeForEmail(renew.email))!;
    world.sessions.push({ id: "cs_test_handoffrnopen1", status: "open", mode: "subscription", customer: renew.customer, metadata: { store: "handoffrn" } });
    // Its members held and its buyers told already: its closing day is next, its renewals not stopped yet.
    await redisPipeline([["SET", `nl:plan:closing:${createHash("sha256").update(storeRef(renewStore)).digest("hex").slice(0, 40)}`, JSON.stringify({ of: day - 30 * DAY, day, holdFrom: day - 30 * DAY, hold: day - 30 * DAY, buyersDone: day - 29 * DAY })]]);
    const members = new Map([["sub_handoffrnmem1", "active"]]);
    let memberStops = 0;
    let checkoutsGarbled = true;
    const beforeRenew = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const method = init?.method ?? "GET";
      if (new Headers(init?.headers).get("stripe-account") === "acct_handoffrn1") {
        if (url.pathname === "/v1/subscriptions/search") return Response.json({ object: "search_result", data: [...members].map(([id, status]) => ({ id, status, metadata: { store: "handoffrn" } })), has_more: false, next_page: null });
        const member = url.pathname.match(/^\/v1\/subscriptions\/(sub_\w+)$/);
        if (member && method === "DELETE" && members.has(member[1])) {
          memberStops += 1;
          members.set(member[1], "canceled");
          return Response.json({ id: member[1], status: "canceled" });
        }
      }
      if (checkoutsGarbled && url.pathname === "/v1/checkout/sessions" && method === "GET") return Response.json({ object: "list", data: "garbled", has_more: false });
      return beforeRenew(input, init);
    };
    const quietRenew = console.error;
    console.error = () => {};
    try {
      const first = await closeOne(storeRef(renewStore), day + 60_000, noFiles, Number.POSITIVE_INFINITY);
      is("unreadable open checkouts still let the members' renewals be stopped on that run, and hold the day for the checkouts", [first.state, first.note, memberStops, members.get("sub_handoffrnmem1"), world.expired.includes("cs_test_handoffrnopen1")], ["held", "its open plan checkouts could not all be read", 1, "canceled", false]);
      checkoutsGarbled = false;
      await closeOne(storeRef(renewStore), day + 120_000, noFiles, Number.POSITIVE_INFINITY);
      is("the next run reads and expires the checkouts, and stops no renewal twice", [world.expired.includes("cs_test_handoffrnopen1"), memberStops], [true, 1]);
    } finally { globalThis.fetch = beforeRenew; console.error = quietRenew; }
  } finally { globalThis.fetch = originalFetch; world.refundErrors = 0; }

  part("Each Stripe list is read in its exact shape: an answer in another shape is never taken as none");
  {
    const listFetch = globalThis.fetch;
    let garble: ((path: string, url: URL, page: Record<string, unknown>) => unknown) | null = null;
    let refundPosts = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/v1/refunds" && method === "POST") refundPosts += 1;
      const response = await listFetch(input, init);
      if (!garble || method !== "GET" || url.hostname !== "api.stripe.com") return response;
      const page = (await response.json()) as Record<string, unknown>;
      const changed = garble(url.pathname.replace(/^\/v1/, ""), url, page);
      return Response.json(changed === undefined ? page : changed, { status: response.status });
    }) as typeof fetch;
    const quietList = console.error;
    console.error = () => {};
    try {
      const shapes: [string, unknown][] = [
        ["no list at all", {}],
        ["data that is not a list", { object: "list", data: "none", has_more: false }],
        ["has_more that is not true or false", { object: "list", data: [], has_more: "false" }],
        ["more pages and no row to read them from", { object: "list", data: [], has_more: true }],
        ["a row that cannot be read", { object: "list", data: [{ id: 42, status: "paid" }], has_more: false }],
      ];
      const invoiceStores: Awaited<ReturnType<typeof closingStore>>[] = [];
      for (const [index, [what, shape]] of shapes.entries()) {
        const one = await closingStore(`inv${"abcde"[index]}`, day);
        invoiceStores.push(one);
        const before = refundPosts;
        garble = (path, url) => (path === "/invoices" && url.searchParams.get("subscription") === one.id ? shape : undefined);
        const outcome = await refusePlanIfClosing({ store: (await storeForEmail(one.email))!, handle: one.email.split("@")[0], subscriptionId: one.id, customerId: one.customer });
        garble = null;
        is(`invoices answered with ${what}: kept in line, nothing settled, nobody told`, [outcome, world.subs.get(one.id)?.status, refundPosts - before, Boolean((await undo(one.id))?.done), sent.filter((m) => m.to === one.email).length], ["returning", "canceled", 0, false, 0]);
      }
      await retryPlanUndos(Number.POSITIVE_INFINITY);
      is("once the invoices read in full, each payment is refunded once and each creator told once", await Promise.all(invoiceStores.map(async (one) => [refundsOf(one.pi).map((row) => row.amount), sent.filter((m) => m.to === one.email).length, Boolean((await undo(one.id))?.done)])), invoiceStores.map(() => [[6_900], 1, true]));

      // Each field a paid invoice is read by (CX-123 rule 24): one that does not read is never taken as "no payment".
      const invoiceFields: [string, (row: Record<string, unknown>) => void][] = [
        ["amount_paid null", (row) => { row.amount_paid = null; }],
        ["amount_paid below zero", (row) => { row.amount_paid = -6_900; }],
        ["amount_paid as text", (row) => { row.amount_paid = "6900"; }],
        ["created null", (row) => { row.created = null; }],
        ["created null and status_transitions null", (row) => { row.created = null; row.status_transitions = null; }],
        ["status_transitions null", (row) => { row.status_transitions = null; }],
        ["paid_at as text", (row) => { row.status_transitions = { paid_at: "soon" }; }],
        ["payment_intent a number", (row) => { row.payment_intent = 42; }],
        // Its status outside the ones Stripe gives an invoice (draft, open, paid, uncollectible, void) is not known:
        // never skipped as "no payment", never settled with a letter saying none was taken.
        ["status transport_unknown", (row) => { row.status = "transport_unknown"; }],
        ["status an empty text", (row) => { row.status = ""; }],
      ];
      const fieldStores: Awaited<ReturnType<typeof closingStore>>[] = [];
      for (const [index, [what, change]] of invoiceFields.entries()) {
        const one = await closingStore(`invf${"abcdefghij"[index]}`, day);
        fieldStores.push(one);
        const before = refundPosts;
        garble = (path, url, page) => {
          if (path !== "/invoices" || url.searchParams.get("subscription") !== one.id) return undefined;
          for (const row of page.data as Record<string, unknown>[]) if (row.status === "paid") change(row);
          return page;
        };
        const outcome = await refusePlanIfClosing({ store: (await storeForEmail(one.email))!, handle: one.email.split("@")[0], subscriptionId: one.id, customerId: one.customer });
        garble = null;
        is(`a paid invoice with ${what}: kept in line, nothing settled, nobody told`, [outcome, refundPosts - before, Boolean((await undo(one.id))?.done), sent.filter((m) => m.to === one.email).length], ["returning", 0, false, 0]);
        is(`a paid invoice with ${what}: no letter says no payment was taken`, sent.some((m) => m.to === one.email && m.text.includes("No payment was taken")), false);
      }

      // Each field the paid charge is read by: one that does not read never settles it with no refund.
      const chargeFields: [string, (charge: Record<string, unknown>) => void][] = [
        ["amount null", (charge) => { charge.amount = null; }],
        ["amount zero", (charge) => { charge.amount = 0; }],
        ["amount_refunded null", (charge) => { charge.amount_refunded = null; }],
        ["amount_refunded below zero", (charge) => { charge.amount_refunded = -1; }],
        ["disputed as text", (charge) => { charge.disputed = "false"; }],
        ["currency a number", (charge) => { charge.currency = 7; }],
        ["currency not a code", (charge) => { charge.currency = "dollars"; }],
      ];
      for (const [index, [what, change]] of chargeFields.entries()) {
        const one = await closingStore(`chgf${"abcdefg"[index]}`, day);
        fieldStores.push(one);
        const before = refundPosts;
        garble = (path, _url, page) => {
          if (path !== `/payment_intents/${one.pi}`) return undefined;
          change(page.latest_charge as Record<string, unknown>);
          return page;
        };
        const outcome = await refusePlanIfClosing({ store: (await storeForEmail(one.email))!, handle: one.email.split("@")[0], subscriptionId: one.id, customerId: one.customer });
        garble = null;
        is(`a paid charge with ${what}: no refund on it, kept in line, nobody told`, [outcome, refundPosts - before, Boolean((await undo(one.id))?.done), sent.filter((m) => m.to === one.email).length], ["returning", 0, false, 0]);
      }
      await retryPlanUndos(Number.POSITIVE_INFINITY);
      is("once the invoices and charges read, each payment is refunded once and each creator told once", await Promise.all(fieldStores.map(async (one) => [refundsOf(one.pi).map((row) => row.amount), sent.filter((m) => m.to === one.email).length, Boolean((await undo(one.id))?.done)])), fieldStores.map(() => [[6_900], 1, true]));

      const paged = await closingStore("invpaged", day);
      garble = (path, url, page) => {
        if (path !== "/invoices" || url.searchParams.get("subscription") !== paged.id) return undefined;
        if (url.searchParams.get("starting_after") === "in_invpagedvoid1") return page;
        return { object: "list", data: [{ id: "in_invpagedvoid1", subscription: paged.id, status: "void", amount_paid: 0, created: S(day) + 900 }], has_more: true };
      };
      const pagedOutcome = await refusePlanIfClosing({ store: (await storeForEmail(paged.email))!, handle: "invpaged", subscriptionId: paged.id, customerId: paged.customer });
      garble = null;
      is("a payment on the invoices' second page is found and refunded", [pagedOutcome, refundsOf(paged.pi).map((row) => row.amount), sent.filter((m) => m.to === paged.email).length], ["returned", [6_900], 1]);

      const refundShapes = shapes.slice(0, 4);
      const refundStores: Awaited<ReturnType<typeof closingStore>>[] = [];
      for (const [index, [what, shape]] of refundShapes.entries()) {
        const one = await closingStore(`ref${"abcd"[index]}`, day);
        refundStores.push(one);
        const before = refundPosts;
        garble = (path, url) => (path === "/refunds" && url.searchParams.get("charge") === `ch_${one.pi.slice(3)}` ? shape : undefined);
        const outcome = await refusePlanIfClosing({ store: (await storeForEmail(one.email))!, handle: one.email.split("@")[0], subscriptionId: one.id, customerId: one.customer });
        garble = null;
        is(`refunds of a charge answered with ${what}: no refund is made on it, kept in line`, [outcome, refundPosts - before, refundsOf(one.pi).length, Boolean((await undo(one.id))?.done), sent.filter((m) => m.to === one.email).length], ["returning", 0, 0, false, 0]);
      }
      // Each refund row read in its exact domain (CX-123 rule 24): an amount Stripe never gives a refund (zero or
      // below) or a status outside its own (pending, requires_action, succeeded, failed, canceled) is not known, and
      // no refund is asked for on it: a negative one would ask for more than was paid, an unknown one for a second.
      const refundRows: [string, string, number][] = [
        ["succeeded with an amount below zero", "succeeded", -6_900],
        ["succeeded with an amount of zero", "succeeded", 0],
        ["status transport_unknown", "transport_unknown", 6_900],
        ["status an empty text", "", 6_900],
      ];
      for (const [index, [what, status, amount]] of refundRows.entries()) {
        const one = await closingStore(`refr${"abcd"[index]}`, day);
        refundStores.push(one);
        const before = refundPosts;
        garble = (path, url) => (path === "/refunds" && url.searchParams.get("charge") === `ch_${one.pi.slice(3)}` ? { object: "list", data: [{ id: `re_refr${"abcd"[index]}row001`, object: "refund", status, amount, currency: "usd" }], has_more: false } : undefined);
        const outcome = await refusePlanIfClosing({ store: (await storeForEmail(one.email))!, handle: one.email.split("@")[0], subscriptionId: one.id, customerId: one.customer });
        garble = null;
        is(`a refund row ${what}: no refund is asked for, kept in line, nobody told`, [outcome, refundPosts - before, refundsOf(one.pi).length, Boolean((await undo(one.id))?.done), sent.filter((m) => m.to === one.email).length], ["returning", 0, 0, false, 0]);
      }
      await retryPlanUndos(Number.POSITIVE_INFINITY);
      is("once the refunds read in full, each payment is refunded once", await Promise.all(refundStores.map(async (one) => [refundsOf(one.pi).map((row) => row.amount), sent.filter((m) => m.to === one.email).length, Boolean((await undo(one.id))?.done)])), refundStores.map(() => [[6_900], 1, true]));

      const twice = await closingStore("refpaged", day);
      world.refunds.push({ id: "re_refpagedok01", object: "refund", charge: `ch_${twice.pi.slice(3)}`, payment_intent: twice.pi, amount: 6_900, status: "succeeded", currency: "usd", key: "" });
      garble = (path, url, page) => {
        if (path !== "/refunds" || url.searchParams.get("charge") !== `ch_${twice.pi.slice(3)}`) return undefined;
        if (url.searchParams.get("starting_after") === "re_refpagedno01") return page;
        return { object: "list", data: [{ id: "re_refpagedno01", object: "refund", amount: 6_900, status: "failed", currency: "usd" }], has_more: true };
      };
      const beforeTwice = refundPosts;
      const twiceOutcome = await refusePlanIfClosing({ store: (await storeForEmail(twice.email))!, handle: "refpaged", subscriptionId: twice.id, customerId: twice.customer });
      garble = null;
      is("a refund that went through, on the refunds' second page, is found: no second refund is asked for", [twiceOutcome, refundPosts - beforeTwice, refundsOf(twice.pi).length], ["returned", 0, 1]);

      const shop = (await storeForEmail(rosa.email))!;
      for (const [what, shape] of [...shapes.slice(0, 4), ["a row that cannot be read", { object: "list", data: [{ id: "cs_test_rosaunread001", mode: 7 }], has_more: false }] as [string, unknown], ["more pages than are read", { object: "list", data: [{ id: "cs_test_rosamorepage1", status: "open", mode: "payment", metadata: {} }], has_more: true }] as [string, unknown]]) {
        garble = (path) => (path === "/checkout/sessions" ? shape : undefined);
        const read = await expirePlanCheckouts(shop, [rosa.customer]).then(() => "finished", () => "refused");
        garble = null;
        is(`open checkouts answered with ${what}: the step is refused, to be tried again`, read, "refused");
      }
      world.sessions.push({ id: "cs_test_rosapaged0001", status: "open", mode: "subscription", customer: rosa.customer, metadata: { store: "rosa" } });
      garble = (path, url, page) => {
        if (path !== "/checkout/sessions") return undefined;
        if (url.searchParams.get("starting_after") === "cs_test_rosapagedother") return page;
        return { object: "list", data: [{ id: "cs_test_rosapagedother", status: "open", mode: "payment", customer: rosa.customer, metadata: { store: "rosa" } }], has_more: true };
      };
      const pagedExpired = await expirePlanCheckouts(shop, [rosa.customer]);
      garble = null;
      is("an open plan checkout on the second page is expired", [pagedExpired, world.expired.at(-1)], [1, "cs_test_rosapaged0001"]);

      // Stripe failing to expire one (a server error, or no answer at all) is not taken as "it was not open": the step
      // is refused and the next run expires it. Only Stripe's refusal of a session that is no longer open passes.
      for (const [what, failure] of [["a server error", () => Response.json({ error: { type: "api_error", message: "a stand-in failure" } }, { status: 500 })], ["no answer", () => { throw new TypeError("fetch failed"); }]] as [string, () => Response][]) {
        const id = `cs_test_rosaexpire${what === "no answer" ? "net" : "500"}1`;
        world.sessions.push({ id, status: "open", mode: "subscription", customer: rosa.customer, metadata: { store: "rosa" } });
        const plain = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          if (new URL(String(input instanceof Request ? input.url : input)).pathname === `/v1/checkout/sessions/${id}/expire`) return failure();
          return plain(input, init);
        }) as typeof fetch;
        const failed = await expirePlanCheckouts(shop, [rosa.customer]).then(() => "finished", () => "refused").finally(() => { globalThis.fetch = plain; });
        is(`expiring an open plan checkout answered with ${what}: the step is refused, to be tried again`, [failed, world.expired.includes(id)], ["refused", false]);
        is(`(${what}) the next run expires it`, [await expirePlanCheckouts(shop, [rosa.customer]), world.expired.at(-1)], [1, id]);
      }
    } finally {
      globalThis.fetch = listFetch;
      console.error = quietList;
      garble = null;
    }
  }

  part("Where it is wired");
  const closing = readFileSync(join(process.cwd(), "lib/plan-closing.ts"), "utf8");
  is("the closing day expires the checkouts right after it is entered, and each later run looks for a late plan", [closing.indexOf("expirePlanCheckouts(store") > closing.indexOf('["ZADD", FINAL_INDEX, endedAt, key]'), closing.includes("await refuseLatePlans(closingStore)")], [true, true]);
  is("the closing job tries the line again on every run", readFileSync(join(process.cwd(), "app/api/cron/closing/route.ts"), "utf8").includes("retryPlanUndos("), true);
  is("the letter with nothing paid says so", planReturnedLetter("Kim Shop", 0, 0, "usd").text.includes("No payment was taken for it."), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
