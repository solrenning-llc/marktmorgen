/**
 * Who is told when a payment plan took a payment after its own end (lib/plans.ts, lib/plan-late-refunds.ts,
 * lib/plan-late-notice.ts, lib/plan-stuck-notice.ts; the owner's decision of 9 November 2026, item 12, and the
 * coordinator's follow-up on #3367):
 *
 *   - the buyer, once per payment given back: an email in the store's language, from the store's own transactional
 *     figure, saying the payment taken after the agreed end was refunded and that the plan has ended. A second pass,
 *     or a pass through the buyer's thanks page, never sends it again; an email that could not be sent (the provider
 *     down) is sent on the next day's pass, once;
 *   - the creator, once per plan, when a payment after the end has been owed for PLAN_OWED_TELL_DAYS (3) because
 *     their balance does not cover it or Stripe refused the refund: an email saying what is to be refunded and what
 *     to do. Never before those days, never twice; until then only the log knew;
 *   - a try stays within the registry's figures (PLAN_SETTLE_RUN in tests/plan-cost-registry.ts), and the buyer's
 *     email is a store email site (EMAIL_SITES).
 */
import { readFileSync } from "node:fs";
import * as plans from "@/lib/plans";
import { addPeriods, finishPlan, rememberPlan, settlePlans } from "@/lib/plans";
import { addProduct, claimHandle, ensureStatsId, setLanguage, setStripeAccount, storeForEmail } from "@/lib/store";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_late_notice";
// A synthetic credential the Resend fixture knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "plans-late-owner@example.com";
const ACCOUNT = "acct_1TestPlansNote1";
const DAY = 86_400;
const realNow = Date.now;
let clock = Math.floor(realNow() / 1000);
Date.now = () => clock * 1000;
const tick = (days: number) => {
  clock += days * DAY;
};

type Charge = { id: string; object: "charge"; payment_intent: string; amount: number; amount_refunded: number; disputed: boolean; currency: string; balance_transaction: { amount: number; currency: string }; invoice: string };
type Invoice = { id: string; object: "invoice"; subscription: string; status: string; created: number; amount_paid: number; paid_out_of_band: boolean; customer_email: string; charge: Charge };
type Refund = { id: string; object: "refund"; payment_intent: string; amount: number; currency: string; status: string; metadata: Record<string, string> };

const sessions: Record<string, Record<string, unknown>> = {};
const subscriptions: Record<string, Record<string, unknown>> = {};
const invoices: Record<string, Invoice[]> = {};
const refunds: Record<string, Refund[]> = {};
const keyed = new Map<string, Refund>();
const emails: { to: string; subject: string; text: string; key: string | null }[] = [];
/** Payment intents whose refund Stripe refuses for good (a 400 with this code). */
const refusedFor = new Map<string, string>();
let resendFails = false;
let balance = 1_000_000;
let stripeCalls = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    if (resendFails) return answer({ message: "down" }, 500);
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text, key: ((init?.headers ?? {}) as Record<string, string>)["Idempotency-Key"] ?? null });
    return answer({ id: `email_${emails.length}` });
  }
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
    subscriptions[sub[1]] = { ...subscriptions[sub[1]], status: "canceled", ended_at: clock };
    return answer(subscriptions[sub[1]]);
  }
  if (path === "/invoices" && method === "GET") {
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
    const again = key ? keyed.get(key) : undefined;
    if (again) return answer(again);
    const intent = body.get("payment_intent") ?? "";
    const charge = Object.values(invoices).flat().map((row) => row.charge).find((c) => c.payment_intent === intent);
    if (!charge) return answer({ error: { message: "No such payment_intent" } }, 404);
    const refused = refusedFor.get(intent);
    if (refused) return answer({ error: { type: "invalid_request_error", code: refused, message: "This charge can no longer be refunded." } }, 400);
    const amount = Number(body.get("amount") ?? charge.amount - charge.amount_refunded);
    const made: Refund = { id: `re_${intent.slice(3)}${(refunds[intent]?.length ?? 0) + 1}`, object: "refund", payment_intent: intent, amount, currency: "usd", status: "succeeded", metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) };
    (refunds[intent] ??= []).push(made);
    charge.amount_refunded += amount;
    balance -= amount;
    if (key) keyed.set(key, made);
    return answer(made);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

let serial = 0;
/** A monthly plan of `payments`, its first payment `ago` days back, with one paid invoice per month Stripe charged. */
function plan(payments: number, ago: number, charged: number, buyer: string): { session: string; sub: string; end: number; invoices: Invoice[] } {
  serial += 1;
  const tag = `note${String(serial).padStart(8, "0")}`;
  const session = `cs_test_${tag}`;
  const sub = `sub_${tag}`;
  const anchor = clock - ago * DAY;
  sessions[session] = { id: session, status: "complete", subscription: sub, metadata: { kind: "plan", plan_payments: String(payments), plan_interval: "month" } };
  subscriptions[sub] = { id: sub, status: "active", billing_cycle_anchor: anchor, trial_end: null };
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
      customer_email: buyer,
      charge: { id: `ch_${tag}x${i}`, object: "charge" as const, payment_intent: intent, amount: 5_000, amount_refunded: 0, disputed: false, currency: "usd", balance_transaction: { amount: 5_000, currency: "usd" }, invoice: id },
    };
  });
  return { session, sub, end: addPeriods(anchor, "month", payments), invoices: invoices[sub] };
}
type Remember = (account: string, session: string, about?: { sid: string; product: string }) => Promise<void>;
const remember = rememberPlan as unknown as Remember;
const inALine = async (session: string) => {
  const [pending, retry] = await redis.pipeline([["SMEMBERS", "nl:plans:pending"], ["ZRANGEBYSCORE", "nl:plans:retry", "-inf", "+inf"]]);
  return [...(pending as string[]), ...(retry as string[])].some((m) => m.startsWith(`${ACCOUNT}|${session}|`));
};
const to = (address: string) => emails.filter((e) => e.to === address);

async function main(): Promise<void> {
  const realError = console.error;
  console.error = () => {};
  redis.clear();
  await claimHandle(OWNER, "plansnote", "Harbor Notes", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Twelve-week coaching", "", "300", null);
  const store = (await storeForEmail(OWNER))!;
  const about = { sid: store.sid, product: made.ok ? made.product.id : "" };

  part("A payment after the plan's end refunded: its buyer is emailed once, in the store's language");
  const buyer = "late-buyer-one@example.com";
  // Three monthly payments; Stripe kept charging: four taken, the fourth after the end.
  const a = plan(3, 100, 4, buyer);
  await remember(ACCOUNT, a.session, about);
  await settlePlans();
  is("the late payment is refunded", (refunds[a.invoices[3].charge.payment_intent] ?? []).length, 1);
  const letter = to(buyer)[0];
  is("one email to the buyer", to(buyer).length, 1);
  is("from the store, saying the payment after the plan's end was refunded and the plan ended", [
    /Harbor Notes/.test(letter?.subject ?? ""),
    /refund/i.test(letter?.subject ?? ""),
    // Rule 23: the RED asked for "$50.00"; the store writes a whole amount without cents (lib/money.ts, formatMoney).
    / \$50 /.test(letter?.text ?? ""),
    (letter?.text ?? "").includes("Twelve-week coaching"),
    /refunded in full/i.test(letter?.text ?? ""),
    /plan has ended/i.test(letter?.text ?? ""),
  ], [true, true, true, true, true, true]);
  is("the plan is settled and out of its lines", await inALine(a.session), false);

  part("A second pass never emails the buyer again");
  await finishPlan(ACCOUNT, a.session);
  await remember(ACCOUNT, a.session, about);
  await settlePlans();
  tick(1);
  await remember(ACCOUNT, a.session, about);
  await settlePlans();
  is("still one email to the buyer", to(buyer).length, 1);

  part("In the store's language");
  await setLanguage(OWNER, "es");
  const spanish = "late-buyer-two@example.com";
  const b = plan(2, 80, 3, spanish);
  await remember(ACCOUNT, b.session, about);
  await settlePlans();
  is("one email, in Spanish", [to(spanish).length, /reembols/i.test(to(spanish)[0]?.text ?? ""), /refunded in full/i.test(to(spanish)[0]?.text ?? "")], [1, true, false]);
  await setLanguage(OWNER, "en");

  part("An email that could not be sent is sent on the next pass, once");
  const later = "late-buyer-three@example.com";
  const c = plan(2, 80, 3, later);
  await remember(ACCOUNT, c.session, about);
  resendFails = true;
  await settlePlans();
  is("refunded, nothing sent, the plan kept for the email", [(refunds[c.invoices[2].charge.payment_intent] ?? []).length, to(later).length, await inALine(c.session)], [1, 0, true]);
  resendFails = false;
  tick(1);
  await settlePlans();
  is("sent the next day, once, and the plan settled", [to(later).length, await inALine(c.session)], [1, false]);
  tick(1);
  await remember(ACCOUNT, c.session, about);
  await settlePlans();
  is("never again", to(later).length, 1);

  part("Owed for PLAN_OWED_TELL_DAYS: the creator is told once");
  const N = (plans as Record<string, unknown>).PLAN_OWED_TELL_DAYS;
  is("PLAN_OWED_TELL_DAYS is 3", N, 3);
  const owedBuyer = "late-buyer-four@example.com";
  const d = plan(2, 80, 3, owedBuyer);
  await remember(ACCOUNT, d.session, about);
  balance = 1_000;
  const toldOn: number[] = [];
  for (let day = 0; day <= 8; day += 1) {
    const before = to(OWNER).length;
    await settlePlans();
    if (to(OWNER).length > before) toldOn.push(day);
    tick(1);
  }
  is("told once, on the first pass PLAN_OWED_TELL_DAYS after the payment was first owed", toldOn, [3]);
  const owedNote = to(OWNER)[0];
  is("naming the store, the invoice to refund, the balance and what to do", [
    /Harbor Notes/.test(owedNote?.subject ?? ""),
    (owedNote?.text ?? "").includes(d.invoices[2].id),
    /balance/i.test(owedNote?.text ?? ""),
    /Stripe dashboard/i.test(owedNote?.text ?? ""),
  ], [true, true, true, true]);
  is("nothing about the buyer: no address in it", (owedNote?.text ?? "").includes(owedBuyer), false);
  // The reviews of #3367 at 9489992283 (Claude 6 A1 and LEVE 2): the purchase named, the email sent under its own key.
  is("naming the checkout that started the plan, under an idempotency key", [(owedNote?.text ?? "").includes(d.session), /plan-owed/.test(owedNote?.key ?? "")], [true, true]);
  is("the buyer not emailed while nothing was given back, the plan kept", [to(owedBuyer).length, await inALine(d.session)], [0, true]);
  balance = 1_000_000;
  await settlePlans();
  is("once the balance covers it: refunded, the buyer emailed once, the plan settled", [(refunds[d.invoices[2].charge.payment_intent] ?? []).length, to(owedBuyer).length, await inALine(d.session)], [1, 1, false]);
  is("and the creator was told only that once", to(OWNER).length, 1);

  part("A refund Stripe refuses for good: the creator is told once, the others still refunded (Claude 3, MEDIUM 1; Claude 6, N2)");
  const refusedBuyer = "late-buyer-six@example.com";
  const r = plan(2, 130, 5, refusedBuyer);
  refusedFor.set(r.invoices[2].charge.payment_intent, "charge_expired_for_refund");
  await remember(ACCOUNT, r.session, about);
  const ownerBefore = to(OWNER).length;
  const refusedOn: number[] = [];
  for (let day = 0; day <= 6; day += 1) {
    const before = to(OWNER).length;
    await settlePlans();
    if (to(OWNER).length > before) refusedOn.push(day);
    tick(1);
  }
  is("the refundable two refunded and their buyer told, once each", [(refunds[r.invoices[3].charge.payment_intent] ?? []).length, (refunds[r.invoices[4].charge.payment_intent] ?? []).length, to(refusedBuyer).length], [1, 1, 2]);
  is("the creator told once, PLAN_OWED_TELL_DAYS after, naming the refused invoice", [refusedOn, to(OWNER).length - ownerBefore, (to(OWNER).at(-1)?.text ?? "").includes(r.invoices[2].id)], [[3], 1, true]);
  is("the plan still in its line, never let go", await inALine(r.session), true);
  refusedFor.clear();
  // Taken out by hand so the measure below tries one plan only.
  const [lined] = await redis.pipeline([["ZRANGEBYSCORE", "nl:plans:retry", "-inf", "+inf"]]);
  for (const member of lined as string[]) if (member.startsWith(`${ACCOUNT}|${r.session}|`)) await redis.pipeline([["ZREM", "nl:plans:retry", member]]);

  part("The public pages say what the code does (rule 27; Claude 3 LOW 4 on #3367)");
  const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ").replace(/&rsquo;/g, "'");
  const terms = flat("app/terms/page.tsx");
  const refundsPage = flat("app/refunds/page.tsx");
  const termsPart = terms.slice(terms.indexOf('id="plan-past-end"'), terms.indexOf('id="plan-past-end"') + 1400);
  const refundsPart = refundsPage.slice(refundsPage.indexOf('id="plan-past-end"'), refundsPage.indexOf('id="plan-past-end"') + 1400);
  is("the Terms tell the creator: the plan ended, the payment refunded from their own Stripe balance, told after PLAN_OWED_TELL_DAYS", [
    terms.includes('id="plan-past-end"'),
    /end the subscription/.test(termsPart),
    /refund that payment in full/.test(termsPart),
    /your own Stripe account's balance/.test(termsPart),
    termsPart.includes(`after ${String(N)} days`),
  ], [true, true, true, true, true]);
  is("the Refund Policy tells the buyer: refunded in full, from the creator's account, and emailed", [
    refundsPage.includes('id="plan-past-end"'),
    /refund that payment in full/.test(refundsPart),
    /creator's own Stripe account/.test(refundsPart),
    /email you/.test(refundsPart),
  ], [true, true, true, true]);

  part("A try stays within the registry's figures");
  const declared = (registry as Record<string, unknown>).PLAN_SETTLE_RUN as Record<string, number>;
  const sites = (registry as Record<string, unknown>).EMAIL_SITES as Record<string, string[]>;
  is("the buyer's email is a store email site", sites["lib/plan-late-notice.ts"], ["store"]);
  is("the registry names the buyer emails a try sends and their commands", [typeof declared.lateTellsPerTry, typeof declared.lateTellCommandsPerPlan], ["number", "number"]);
  const many = "late-buyer-five@example.com";
  const e = plan(2, 240, 8, many);
  await remember(ACCOUNT, e.session, about);
  type Pipe = (commands: (string | number)[][]) => Promise<unknown[]>;
  const real: Pipe = redis.pipeline.bind(redis);
  let commands = 0;
  (redis as unknown as { pipeline: Pipe }).pipeline = async (sent) => {
    commands += sent.length;
    return real(sent);
  };
  stripeCalls = 0;
  const run = await settlePlans();
  (redis as unknown as { pipeline: Pipe }).pipeline = real;
  is("emails within lateTellsPerTry", to(many).length <= declared.lateTellsPerTry, true);
  is("Redis commands within readCommandsPerRun + ownCommandsPerPlanTried + lateTellCommandsPerPlan", commands <= declared.readCommandsPerRun + declared.ownCommandsPerPlanTried + declared.lateTellCommandsPerPlan, true);
  is("Stripe calls within stripeCallsPerPlanTried", stripeCalls <= declared.stripeCallsPerPlanTried, true);
  is("one plan tried", Object.values(run).reduce((sum, n) => sum + n, 0) >= 1, true);
  for (let pass = 0; pass < 6; pass += 1) {
    tick(1);
    await settlePlans();
  }
  is("in the end each late payment emailed once", to(many).length, 6);

  console.error = realError;
  Date.now = realNow;
  done();
}
void main();
