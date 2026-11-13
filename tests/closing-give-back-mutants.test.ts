/**
 * Mutation testing of giveBackUnused (lib/closing-refunds.ts; Claude 7,
 * 13/11/2026): each case kills a mutant that survived every test importing the
 * module. The refund a closing store owes each member: what Stripe's refusals
 * mean (no balance is short, a dispute is disputed, already refunded is
 * nothing to give, anything else is tried again), each refund counted off the
 * balance before the next, never more than the charge still holds, what is
 * written back for each member, the members asked for, the run's deadline and
 * its budget of Stripe calls.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts.
 */
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const SEC = DAY / 1000;
const INV = "in_MutGiveBack01";
const PI = "pi_MutGiveBack01";
const SUB_A = "sub_MutGiveBackA";
const SUB_B = "sub_MutGiveBackB";

let balance = 100_000;
let charge: Record<string, unknown> = {};
let refuse: string | null = null;
let requests: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  requests.push(path);
  if (path === "/v1/balance") return Response.json({ object: "balance", available: [{ amount: balance, currency: "usd" }] });
  if (path === `/v1/invoices/${INV}`) return Response.json({ id: INV, payment_intent: PI });
  if (path === `/v1/payment_intents/${PI}`) return Response.json({ id: PI, latest_charge: charge });
  if (path === "/v1/refunds" && init?.method === "POST") {
    if (refuse) return Response.json({ error: { code: refuse, message: "synthetic refusal" } }, { status: 400 });
    const body = new URLSearchParams(String(init.body));
    return Response.json({ object: "refund", id: `re_MutGive${requests.length}`, amount: Number(body.get("amount")), currency: "usd", payment_intent: PI, status: "succeeded" });
  }
  if (path === "/v1/refunds") return Response.json({ object: "list", data: [], has_more: false });
  throw Error(`unexpected synthetic request ${path}`);
}) as typeof fetch;

type Seed = { subs?: string[]; tot?: number; calls?: number; rcalls?: number; account?: boolean };
let seeds = 0;
async function seed({ subs = [SUB_A], tot = 1000, calls = 30, rcalls = 30, account = true }: Seed = {}) {
  redis.clear();
  requests = [];
  balance = 100_000;
  refuse = null;
  charge = { id: "ch_MutGiveBack01", amount: 1000, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null };
  seeds += 1;
  const email = `mut-give-${seeds}@example.com`;
  await claimHandle(email, `mutgive${seeds}`, "Mutants", "");
  const found = (await storeForEmail(email))!;
  const store = (account ? { ...found, stripeAccountId: "acct_MutGiveBack1" } : { ...found, stripeAccountId: undefined }) as Store;
  const folder = await storeFolder(email);
  await redis.pipeline([
    ...subs.map((sub, i) => ["HSET", paidKey(folder), sub, JSON.stringify({ inv: INV, amt: 1000, tot, cur: "usd", ps: SEC - 15 * 86400, pe: SEC + 15 * 86400 - i, e: `member${i}@example.com` })]),
    ["HSET", workKey(folder), "calls", calls, "rcalls", rcalls],
  ]);
  return { store, folder };
}
const row = async (folder: string, sub = SUB_A) => {
  const r = JSON.parse(String((await redis.pipeline([["HGET", paidKey(folder), sub]]))[0])) as Record<string, unknown>;
  return { r: r.r, back: r.back, want: r.want };
};
const counts = (out: unknown) =>
  typeof out === "object" && out
    ? (({ done, short, unmade, pending, disputed, none, over, failed, left }) => ({ done: done.length, short: short.length, unmade: unmade.length, pending, disputed, none, over, failed, left }))(out as Exclude<Awaited<ReturnType<typeof giveBackUnused>>, string>)
    : out;
const zero = { done: 0, short: 0, unmade: 0, pending: 0, disputed: 0, none: 0, over: 0, failed: 0, left: 0 };

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_closing_give_back_mutants";

  part("What is written back for a member");
  {
    const { store, folder } = await seed();
    is("a refund made", counts(await giveBackUnused(store, DAY)), { ...zero, done: 1 });
    is("written as given back, with the amount", await row(folder), { r: "done", back: 500, want: undefined });
  }
  {
    const { store, folder } = await seed();
    balance = 100;
    is("a balance that does not cover it", counts(await giveBackUnused(store, DAY)), { ...zero, short: 1 });
    is("written as still wanted, with the amount", await row(folder), { r: "short", back: undefined, want: 500 });
  }

  part("Each refund is counted off the balance before the next");
  {
    const { store } = await seed({ subs: [SUB_A, SUB_B] });
    balance = 600;
    is("the first fits, the second is short", counts(await giveBackUnused(store, DAY)), { ...zero, done: 1, short: 1 });
  }

  part("What Stripe's refusals mean");
  for (const [code, want] of [
    ["balance_insufficient", { ...zero, short: 1 }],
    ["charge_disputed", { ...zero, disputed: 1 }],
    ["refund_disputed_payment", { ...zero, disputed: 1 }],
    ["charge_already_refunded", { ...zero, none: 1 }],
    ["rate_limit", { ...zero, failed: 1 }],
  ] as const) {
    const { store } = await seed();
    refuse = code;
    is(code, counts(await giveBackUnused(store, DAY)), want);
  }

  part("Never more than the charge still holds");
  {
    const { store } = await seed();
    charge = { ...charge, amount_refunded: 1000 };
    is("a charge refunded in full already: nothing to give", counts(await giveBackUnused(store, DAY)), { ...zero, none: 1 });
  }
  {
    const { store, folder } = await seed({ tot: 400 });
    charge = { ...charge, amount_refunded: 100 };
    await giveBackUnused(store, DAY);
    is("what the invoice took less what was refunded caps it", await row(folder), { r: "done", back: 300, want: undefined });
  }

  {
    const { store } = await seed({ tot: 0 });
    is("an invoice that took nothing gives nothing back", counts(await giveBackUnused(store, DAY)), { ...zero, none: 1 });
  }

  part("Which members, and when");
  {
    const { store } = await seed({ account: false });
    is("no Stripe account", await giveBackUnused(store, DAY), "unavailable");
    is("and nothing was asked", requests, []);
  }
  {
    const { store, folder } = await seed({ subs: [SUB_A, SUB_B] });
    is("only the member asked for", counts(await giveBackUnused(store, DAY, { subs: [SUB_B] })), { ...zero, done: 1 });
    is("the other is untouched", (await row(folder, SUB_A)).r, undefined);
  }
  {
    const { store } = await seed({ subs: [] });
    is("no member owed", counts(await giveBackUnused(store, DAY)), zero);
    is("and the balance was not read", requests, []);
  }
  {
    const { store } = await seed();
    const realNow = Date.now;
    Date.now = () => 7_000_000;
    const out = await giveBackUnused(store, DAY, { until: 7_000_000 });
    Date.now = realNow;
    is("a deadline at this very millisecond still gives back", counts(out), { ...zero, done: 1 });
  }

  part("The budget of Stripe calls");
  {
    const { store } = await seed({ calls: 0, rcalls: 5 });
    is("closing day: all five from the calls set aside", counts(await giveBackUnused(store, DAY, { final: true })), { ...zero, done: 1 });
  }
  {
    const { store } = await seed({ calls: 2, rcalls: 3 });
    is("closing day: three set aside and two from the budget", counts(await giveBackUnused(store, DAY, { final: true })), { ...zero, done: 1 });
  }
  {
    const { store } = await seed({ calls: 0, rcalls: 3 });
    is("closing day: not enough anywhere, told honestly", counts(await giveBackUnused(store, DAY, { final: true })), { ...zero, unmade: 1 });
  }
  {
    const { store } = await seed({ calls: 0, rcalls: 30 });
    is("before the closing day: never from the calls set aside", counts(await giveBackUnused(store, DAY)), { ...zero, over: 1 });
  }

  done();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
