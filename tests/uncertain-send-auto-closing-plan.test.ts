/**
 * The letter to a creator whose plan, paid on a closing day, was ended and
 * returned (lib/closing-plan-guard.ts, settleOne and tell) under a sender
 * whose answer is not known (rule 30, a sibling of 283 [HG2] unit 1's
 * sendEmailOutcome).
 *
 * Before, a send that may have gone (a server error, or a network error after
 * the request) left the plan in line as "the creator could not be told yet",
 * and the closing job wrote again on its next run: once the day of the
 * sender's idempotency key had passed, the creator had the letter twice. An
 * uncertain send now counts as told (marked, never written again); only a
 * certain refusal keeps the plan in line for the letter. Stripe and the
 * sender are played by a stand-in for `fetch`; no real email is sent.
 * Checked:
 *
 *   - a 500 from the sender: settled, marked told, and over two later runs,
 *     the second after a day, never asked again;
 *   - a thrown request (network error): the same;
 *   - a 422 (a certain refusal): kept in line, the next run asks again and,
 *     answered yes, settles (control: unchanged behavior);
 *   - a plain yes: one letter (control);
 *   - every payment refunded once, whatever the sender said.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { UNDO_KEY, markShut, refuseSession, retryPlanUndos } from "@/lib/closing-plan-guard";
import { redisPipeline } from "@/lib/redis";

const S = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;

type PlanSub = { id: string; status: string; customer: string; metadata: Record<string, string>; created: number };
type Invoice = { id: string; subscription: string; status: string; amount_paid: number; payment_intent: string; created: number; paid_at: number };
type Refund = { id: string; object: "refund"; charge: string; payment_intent: string; amount: number; status: string; currency: string };

const subs = new Map<string, PlanSub>();
const invoices: Invoice[] = [];
const charges = new Map<string, number>();
const refunds: Refund[] = [];
const sessions: Record<string, unknown>[] = [];
const customers = new Map<string, string>();
/** Every recipient the sender was asked for, taken or not. */
const asked: string[] = [];
/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    const to = [(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0] ?? "";
    asked.push(to);
    const special = senderAnswers.get(to);
    if (special) return special();
    return json({ id: `email_${asked.length}` });
  }
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  const form = new URLSearchParams(String(init?.body ?? ""));
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = subs.get(sub[1]);
    if (!row) return json({ error: { message: "No such subscription" } }, 404);
    if (method === "DELETE") {
      if (row.status === "canceled") return json({ error: { code: "resource_missing", message: "already canceled" } }, 400);
      row.status = "canceled";
    }
    return json({ ...row, items: { data: [] } });
  }
  if (path === "/subscriptions" && method === "GET") return json({ object: "list", data: [], has_more: false });
  if (path === "/subscriptions/search") return json({ object: "search_result", data: [], has_more: false, next_page: null });
  if (path === "/invoices" && method === "GET") {
    const data = invoices.filter((row) => row.subscription === url.searchParams.get("subscription")).map((row) => ({ ...row, status_transitions: { paid_at: row.paid_at || null } }));
    return json({ object: "list", data, has_more: false });
  }
  const intent = path.match(/^\/payment_intents\/(pi_\w+)$/);
  if (intent) {
    const amount = charges.get(intent[1]);
    if (amount === undefined) return json({ error: { message: "No such payment_intent" } }, 404);
    const refunded = refunds.filter((row) => row.payment_intent === intent[1] && row.status === "succeeded").reduce((sum, row) => sum + row.amount, 0);
    return json({ id: intent[1], latest_charge: { id: `ch_${intent[1].slice(3)}`, currency: "usd", amount, amount_refunded: refunded, disputed: false } });
  }
  if (path === "/refunds" && method === "GET") return json({ object: "list", data: refunds.filter((row) => row.charge === url.searchParams.get("charge")), has_more: false });
  if (path === "/refunds" && method === "POST") {
    const pi = String(form.get("payment_intent"));
    const refund: Refund = { id: `re_${String(refunds.length + 1).padStart(8, "0")}`, object: "refund", charge: `ch_${pi.slice(3)}`, payment_intent: pi, amount: Number(form.get("amount")), status: "succeeded", currency: "usd" };
    refunds.push(refund);
    return json(refund);
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) return json({ id: customer[1], email: customers.get(customer[1]) ?? null });
  if (path === "/checkout/sessions" && method === "GET") return json({ object: "list", data: [], has_more: false });
  const session = path.match(/^\/checkout\/sessions\/(cs_\w+)$/);
  if (session) {
    const row = sessions.find((one) => one.id === session[1]);
    return row ? json(row) : json({ error: { message: "No such checkout session" } }, 404);
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A store in its closing day since `day`, with a plan checkout finished on that day and paid; the way back is taken. */
async function closingStore(handle: string, day: number) {
  const email = `${handle}@example.com`;
  const customer = `cus_${handle}0001`;
  await claimHandle(email, handle, `${handle[0].toUpperCase()}${handle.slice(1)} Shop`, "");
  await setSubscription(email, { customerId: customer, subscriptionId: `sub_${handle}old001`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  customers.set(customer, email);
  await redisPipeline([["ZADD", FINAL_INDEX, day - 30 * DAY, storeRef((await storeForEmail(email))!)]]);
  await markShut((await storeForEmail(email))!, day);
  const id = `sub_${handle}late01`;
  subs.set(id, { id, status: "active", customer, metadata: { store: handle, tier: "creator" }, created: S(day) - 3_600 });
  const pi = `pi_${handle}late01`;
  invoices.push({ id: `in_${handle}late01`, subscription: id, status: "paid", amount_paid: 6_900, payment_intent: pi, created: S(day) - 3_600, paid_at: S(day) + 600 });
  charges.set(pi, 6_900);
  sessions.push({ id: `cs_test_${handle}late0001`, status: "complete", mode: "subscription", customer, subscription: id, metadata: { store: handle } });
  return { email, id, pi };
}

const askedOf = (email: string) => asked.filter((to) => to === email).length;
const answerOf = (status: number) => new Response(JSON.stringify({ message: "stand-in" }), { status });
const undo = async (id: string) => {
  const [raw] = await redisPipeline([["HGET", UNDO_KEY, id]]);
  return typeof raw === "string" ? (JSON.parse(raw) as { done?: number; t?: number }) : null;
};

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const day = Date.UTC(2026, 11, 2);
  const una = await closingStore("una", day);
  const tom = await closingStore("tom", day);
  const rex = await closingStore("rex", day);
  const ola = await closingStore("ola", day);
  senderAnswers.set(una.email, () => answerOf(500));
  senderAnswers.set(tom.email, () => {
    throw new TypeError("fetch failed: the connection was reset");
  });
  senderAnswers.set(rex.email, () => answerOf(422));

  part("The way back, with the letter");
  for (const one of [una, tom, rex, ola]) await refuseSession((await storeForEmail(one.email))!, `cs_test_${one.email.split("@")[0]}late0001`);
  is("each creator's sender was asked once", [askedOf(una.email), askedOf(tom.email), askedOf(rex.email), askedOf(ola.email)], [1, 1, 1, 1]);
  is("a 500 counts as told: settled, never written again", [Boolean((await undo(una.id))?.done), (await undo(una.id))?.t], [true, 1]);
  is("a thrown request counts as told: the same", [Boolean((await undo(tom.id))?.done), (await undo(tom.id))?.t], [true, 1]);
  is("a certain refusal stays in line for its letter", [Boolean((await undo(rex.id))?.done), (await undo(rex.id))?.t], [false, undefined]);
  is("a plain yes is settled (control)", [Boolean((await undo(ola.id))?.done), (await undo(ola.id))?.t], [true, 1]);

  part("The closing job, at once and after a day");
  senderAnswers.clear();
  await retryPlanUndos(Date.now() + 10_000);
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + 25 * 3_600_000;
  try {
    await retryPlanUndos(Date.now() + 10_000);
  } finally {
    Date.now = realNow;
  }
  is("the uncertain letters are not written a second time", [askedOf(una.email), askedOf(tom.email)], [1, 1]);
  is("the refused one is asked again once, and settled", [askedOf(rex.email), Boolean((await undo(rex.id))?.done)], [2, true]);
  is("the one that went is not asked again (control)", askedOf(ola.email), 1);
  is("every payment was refunded once", [una, tom, rex, ola].map((one) => refunds.filter((row) => row.payment_intent === one.pi).length), [1, 1, 1, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
