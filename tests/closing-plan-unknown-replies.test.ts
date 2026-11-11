/**
 * The closing guard's two single-object Stripe reads, the subscription it ends
 * and the customer it writes to, held to their exact shape (CX-123 rules 24 and
 * 30), against a stand-in for our own Stripe account and the email sender.
 * Nothing real is reached; every id is synthetic.
 *
 * What fails here:
 *   - a subscription reply for another id, or with a `created` that does not
 *     read, taken as "ended" and settled on (refunds made, a letter written,
 *     the plan's start guessed as 0, which turns the store's own plan into a
 *     plan for a closing store and gives back what it was rightly paid);
 *   - a customer reply for another customer whose address is written to, or one
 *     whose email does not read taken as "no address": the plan is then marked
 *     settled and its creator is never told the money was returned;
 *   - a customer with no email, or a deleted one, no longer settled as before
 *     (the money is back and there is no address to tell).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { UNDO_KEY, settleOne } from "@/lib/closing-plan-guard";
import { redisPipeline } from "@/lib/redis";

const S = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;
const day = Date.UTC(2026, 11, 2);

type Sub = { id: string; status: string; created: number };
const world = {
  subs: new Map<string, Sub>(),
  /** A subscription whose replies are replaced by this function's answer. */
  subReply: new Map<string, (row: Sub) => unknown>(),
  invoices: new Map<string, Record<string, unknown>>(),
  charges: new Map<string, number>(),
  refunds: [] as { id: string; charge: string; payment_intent: string; amount: number; status: string; key: string }[],
  customers: new Map<string, () => unknown>(),
  /** A payment intent whose reply is replaced by this function's answer (rule 30, Claude 6 on #3628). */
  piReply: new Map<string, (own: Record<string, unknown>) => unknown>(),
  /** Refund rows of other charges answered alongside, as a list read that is not this charge's alone. */
  strayRefunds: [] as Record<string, unknown>[],
};
const sent: { to: string; text: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text?: string };
    sent.push({ to: [body.to].flat()[0], text: body.text ?? "" });
    return json({ id: `email_${sent.length}` });
  }
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const key = new Headers(init?.headers).get("idempotency-key") ?? "";
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
    const odd = world.subReply.get(sub[1]);
    return json(odd ? odd(row) : { ...row, object: "subscription" });
  }
  if (path === "/invoices" && method === "GET") {
    const id = String(url.searchParams.get("subscription"));
    const row = world.invoices.get(id);
    return json({ object: "list", data: row ? [row] : [], has_more: false });
  }
  const intent = path.match(/^\/payment_intents\/(pi_\w+)$/);
  if (intent) {
    const amount = world.charges.get(intent[1]);
    if (!amount) return json({ error: { message: "No such payment_intent" } }, 404);
    const refunded = world.refunds.filter((row) => row.payment_intent === intent[1] && row.status === "succeeded").reduce((sum, row) => sum + row.amount, 0);
    const own = { id: intent[1], latest_charge: { id: `ch_${intent[1].slice(3)}`, payment_intent: intent[1], currency: "usd", amount, amount_refunded: refunded, disputed: false } };
    const odd = world.piReply.get(intent[1]);
    return json(odd ? odd(own) : own);
  }
  if (path === "/refunds" && method === "GET") return json({ object: "list", data: [...world.refunds.filter((row) => row.charge === url.searchParams.get("charge")), ...world.strayRefunds], has_more: false });
  if (path === "/refunds" && method === "POST") {
    const pi = String(form.get("payment_intent"));
    const kept = world.refunds.find((row) => row.key === key);
    if (kept) return json(kept);
    const refund = { id: `re_${String(world.refunds.length + 1).padStart(8, "0")}`, charge: `ch_${pi.slice(3)}`, payment_intent: pi, amount: Number(form.get("amount")), status: "succeeded", key };
    world.refunds.push(refund);
    return json(refund);
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) {
    const answer = world.customers.get(customer[1]);
    return answer ? json(answer()) : json({ error: { message: "No such customer" } }, 404);
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/**
 * A plan in line to be undone with one paid invoice of $69 paid on the closing day. `created` is the plan's start;
 * `to` is the address kept in line (empty: the guard asks Stripe for the customer's).
 */
async function inLine(name: string, created: number, to: string, customer = "") {
  const id = `sub_${name}`;
  world.subs.set(id, { id, status: "active", created });
  const pi = `pi_${name}`;
  world.invoices.set(id, { id: `in_${name}`, status: "paid", amount_paid: 6_900, created: S(day) + 60, payment_intent: pi, status_transitions: { paid_at: S(day) + 120 } });
  world.charges.set(pi, 6_900);
  await redisPipeline([["HSET", UNDO_KEY, id, JSON.stringify({ h: name, c: customer, to, name: "Odd Shop", since: day, ended: day - 30 * DAY, at: day, n: 0 })]]);
  return { id, pi };
}
const refundsOf = (pi: string) => world.refunds.filter((row) => row.payment_intent === pi).map((row) => row.amount);
const entryOf = async (id: string) => {
  const [raw] = await redisPipeline([["HGET", UNDO_KEY, id]]);
  return typeof raw === "string" ? (JSON.parse(raw) as { done?: number; t?: number; n: number }) : null;
};

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const quiet = console.error;
  console.error = () => {};

  part("The subscription it ends, read for its own id (rule 30)");
  {
    const one = await inLine("subother01", S(day) - 3_600, "subother01@example.com");
    world.subReply.set(one.id, (row) => ({ ...row, id: "sub_someoneelse01", object: "subscription" }));
    is("a reply for another subscription is not taken as this one ended", await settleOne(one.id), false);
    is("nothing is refunded on it", refundsOf(one.pi), []);
    is("no letter is written", sent.some((m) => m.to === "subother01@example.com"), false);
    is("the plan stays in line, tried again", [(await entryOf(one.id))?.done, (await entryOf(one.id))?.n], [undefined, 1]);
    world.subReply.delete(one.id);
    is("once Stripe answers for it, it settles as before", await settleOne(one.id), true);
    is("and the $69 is given back once", refundsOf(one.pi), [6_900]);
  }

  part("The subscription's start, read in its exact shape (rule 24)");
  for (const [label, odd] of [
    ["created missing", (row: Sub) => ({ id: row.id, status: row.status, object: "subscription" })],
    ["created a string", (row: Sub) => ({ ...row, created: String(row.created), object: "subscription" })],
    ["created zero", (row: Sub) => ({ ...row, created: 0, object: "subscription" })],
    ["status missing", (row: Sub) => ({ id: row.id, created: row.created, object: "subscription" })],
    ["not an object", () => ["canceled"]],
  ] as [string, (row: Sub) => unknown][]) {
    // The store's own plan, started long before its last plan ended: only what it was paid since the closing day
    // began is given back. A start that does not read must not turn it into a plan for a closing store.
    const name = `subodd${label.replace(/\W/g, "").slice(0, 8)}`;
    const one = await inLine(name, S(day) - 90 * 86_400, `${name}@example.com`);
    world.subReply.set(one.id, odd);
    is(`${label}: not settled`, await settleOne(one.id), false);
    is(`${label}: nothing refunded`, refundsOf(one.pi), []);
    is(`${label}: no letter`, sent.some((m) => m.to === `${name}@example.com`), false);
    is(`${label}: kept in line`, (await entryOf(one.id))?.done, undefined);
    world.subReply.delete(one.id);
  }

  part("The customer it writes to, read for its own id and its email in its exact shape");
  {
    const one = await inLine("cusother01", S(day) - 3_600, "", "cus_cusother01");
    world.customers.set("cus_cusother01", () => ({ id: "cus_someoneelse1", object: "customer", email: "someone-else@example.com" }));
    is("a customer reply for another customer is not written to", await settleOne(one.id), false);
    is("no letter goes to the other customer's address", sent.some((m) => m.to === "someone-else@example.com"), false);
    is("the plan is not marked told nor settled", [(await entryOf(one.id))?.t, (await entryOf(one.id))?.done], [undefined, undefined]);
    is("the refund itself is made, once (it never waits on the letter)", refundsOf(one.pi), [6_900]);
    world.customers.set("cus_cusother01", () => ({ id: "cus_cusother01", object: "customer", email: "cusother01@example.com" }));
    is("once Stripe answers for this customer, it settles", await settleOne(one.id), true);
    is("and its creator is told once", sent.filter((m) => m.to === "cusother01@example.com").length, 1);
    is("no second refund", refundsOf(one.pi), [6_900]);
  }
  for (const [label, name, odd] of [
    ["email a number", "cusoddmail1", (id: string) => ({ id, object: "customer", email: 42 })],
    ["email missing", "cusoddmail2", (id: string) => ({ id, object: "customer" })],
    ["not an object", "cusoddmail3", (id: string) => id],
  ] as [string, string, (id: string) => unknown][]) {
    const one = await inLine(name, S(day) - 3_600, "", `cus_${name}`);
    world.customers.set(`cus_${name}`, () => odd(`cus_${name}`));
    is(`${label}: never taken as "no address" and settled`, await settleOne(one.id), false);
    is(`${label}: not marked told`, (await entryOf(one.id))?.t, undefined);
  }
  for (const [label, answer] of [
    ["email null", (id: string) => ({ id, object: "customer", email: null })],
    ["a deleted customer", (id: string) => ({ id, object: "customer", deleted: true })],
  ] as [string, (id: string) => unknown][]) {
    const name = label === "email null" ? "cusnomail01" : "cusdeleted1";
    const one = await inLine(name, S(day) - 3_600, "", `cus_${name}`);
    world.customers.set(`cus_${name}`, () => answer(`cus_${name}`));
    is(`${label}: settled as before (the money is back; there is no address)`, await settleOne(one.id), true);
    is(`${label}: the $69 given back once`, refundsOf(one.pi), [6_900]);
  }

  part("The payment it gives back, read for its own intent and its own charge (rule 30, Claude 6 on #3628)");
  for (const [label, odd] of [
    ["an intent reply for another intent, refunded in full", (own: Record<string, unknown>) => ({ ...own, id: "pi_someoneelse01", latest_charge: { ...(own.latest_charge as object), id: "ch_someoneelse01", payment_intent: "pi_someoneelse01", amount_refunded: 6_900 } })],
    ["an intent reply with no id", (own: Record<string, unknown>) => ({ latest_charge: own.latest_charge })],
    ["a charge of another intent", (own: Record<string, unknown>) => ({ ...own, latest_charge: { ...(own.latest_charge as object), payment_intent: "pi_someoneelse02" } })],
  ] as [string, (own: Record<string, unknown>) => unknown][]) {
    const name = `pioth${String(label.length).padStart(3, "0")}${label.charCodeAt(label.length - 1)}`;
    const one = await inLine(name, S(day) - 3_600, `${name}@example.com`);
    world.piReply.set(one.pi, odd);
    is(`${label}: not settled`, await settleOne(one.id), false);
    is(`${label}: no letter says the payment was returned`, sent.some((m) => m.to === `${name}@example.com`), false);
    is(`${label}: kept in line`, (await entryOf(one.id))?.done, undefined);
    world.piReply.delete(one.pi);
    is(`${label}: once Stripe answers for it, the $69 is given back once`, [await settleOne(one.id), refundsOf(one.pi)], [true, [6_900]]);
  }
  {
    // A list answered with a succeeded refund of another charge: never counted as this charge's money back.
    const one = await inLine("refstray01", S(day) - 3_600, "refstray01@example.com");
    world.strayRefunds = [{ id: "re_stray000001", object: "refund", charge: "ch_someoneelse03", payment_intent: "pi_someoneelse03", amount: 6_900, status: "succeeded" }];
    is("a refund row of another charge: not settled on it", await settleOne(one.id), false);
    is("no letter says $69 was returned", sent.some((m) => m.to === "refstray01@example.com"), false);
    is("kept in line", (await entryOf(one.id))?.done, undefined);
    world.strayRefunds = [];
    is("once the list is this charge's alone, the $69 is given back once", [await settleOne(one.id), refundsOf(one.pi)], [true, [6_900]]);
  }

  console.error = quiet;
  done();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
