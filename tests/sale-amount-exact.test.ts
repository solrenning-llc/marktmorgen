/**
 * The amount a sale notice states is the one Stripe charged, read exactly
 * (lib/sale-events.ts; rule 24): whole cents from zero up, in the currency
 * Stripe names for it. An amount Stripe's answer does not give that way is
 * unknown: the notice says a sale happened, without a figure, and never "$0"
 * or a number guessed in the store's currency.
 *
 * Checked on the team's chat line, which states the same figure as the phone
 * notice: for a paid checkout (noteSales) and a one-click offer (noteOfferSale).
 *
 * Synthetic only: a stand-in for Stripe and for the Slack hook, so no real
 * charge or message is made.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setChatAddress } from "@/lib/chat-summary";
import { noteOfferSale, noteSales } from "@/lib/sale-events";
import { claimHandle, ensureStatsId, setChatSales, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_sale_amount_stand_in";
process.env.RESEND_API_KEY = "re_test_sale_amount_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "owner@example.com";
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
const posted: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "hooks.slack.com") {
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("ok", { status: 200 });
  }
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function chatStore(): Promise<Store> {
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  await setChatAddress(store.statsId!, "Harbor Kitchen", SLACK);
  await setChatSales(OWNER, true);
  // The channel's own welcome line is not a sale.
  posted.length = 0;
  return (await storeForEmail(OWNER))!;
}

let n = 0;
const checkout = (shape: { amount_total?: unknown; currency?: unknown }) => ({
  id: `cs_test_saleamt${String((n += 1)).padStart(8, "0")}`,
  status: "complete",
  payment_status: "paid",
  created: Math.floor(Date.now() / 1000),
  customer_details: { email: "buyer@example.com", name: "Pat Buyer" },
  metadata: { store: "harbor", product: "nope", title: "Weeknight Club" },
  ...shape,
});
const offerPayment = (shape: { amount?: unknown; currency?: unknown }) => ({
  id: `pi_test_offeramt${String((n += 1)).padStart(8, "0")}`,
  created: Math.floor(Date.now() / 1000),
  ...shape,
});
const offered = { id: "p_pastry", title: "Pastry Guide" } as unknown as Listing;

/** Shapes Stripe's answer could carry that are not whole cents in a named currency. */
const UNKNOWN: [string, { amount?: unknown; currency?: unknown }][] = [
  ["no amount", { currency: "usd" }],
  ["an amount as text", { amount: "2900", currency: "usd" }],
  ["a fraction of a cent", { amount: 2900.5, currency: "usd" }],
  ["below zero", { amount: -2900, currency: "usd" }],
  ["not a number", { amount: Number.NaN, currency: "usd" }],
  ["past a safe whole number", { amount: Number.MAX_SAFE_INTEGER + 2, currency: "usd" }],
  ["null", { amount: null, currency: "usd" }],
  ["no currency named", { amount: 2900 }],
  ["an empty currency", { amount: 2900, currency: "" }],
  ["a currency that is not text", { amount: 2900, currency: 840 }],
  // Claude 6 on #3058: Stripe names a currency by three lowercase letters, nothing else.
  ["a currency that is not a code", { amount: 2900, currency: "not-a-code" }],
  ["a currency of four letters", { amount: 2900, currency: "usdx" }],
];

/**
 * Replies swapped for the told mark's commands (nl:sale:told:): `exists` answers every EXISTS, `claim` every SET … NX
 * (after running it when `landed`), `readBack` every GET. Undefined leaves the real reply.
 */
const swap: { exists?: unknown; claim?: unknown; landed?: boolean; readBack?: unknown } = {};
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const told = (c: (string | number)[]) => String(c[1] ?? "").startsWith("nl:sale:told:");
  if (!commands.some(told)) return realPipeline(commands);
  const isClaim = (c: (string | number)[]) => c[0] === "SET" && c.includes("NX");
  const run = commands.filter((c) => !(told(c) && isClaim(c) && swap.claim !== undefined && !swap.landed));
  const real = run.length ? await realPipeline(run) : [];
  let at = 0;
  return commands.map((c) => {
    const skipped = told(c) && isClaim(c) && swap.claim !== undefined && !swap.landed;
    const reply = skipped ? undefined : real[at++];
    if (!told(c)) return reply;
    if (c[0] === "EXISTS" && swap.exists !== undefined) return swap.exists;
    if (isClaim(c) && swap.claim !== undefined) return swap.claim;
    if (c[0] === "GET" && swap.readBack !== undefined) return swap.readBack;
    return reply;
  });
}) as typeof redis.pipeline;
const unswap = () => { for (const k of Object.keys(swap)) delete (swap as Record<string, unknown>)[k]; };

beforeEach(() => {
  redis.clear();
  posted.length = 0;
  unswap();
});

test("a paid checkout is told once: an exact claim of its mark, never EXISTS then SET (Claude 6 on #3058)", async () => {
  const store = await chatStore();
  const once = checkout({ amount_total: 2900, currency: "usd" });
  await Promise.all([noteSales(store, [once]), noteSales(store, [once])]);
  assert.equal(posted.length, 1, "the thanks page and the five-minute job at once: one line, not two");

  posted.length = 0;
  const again = checkout({ amount_total: 2900, currency: "usd" });
  await noteSales(store, [again]);
  swap.exists = "?";
  await noteSales(store, [again]);
  unswap();
  assert.equal(posted.length, 1, "a sale already told is not told again on an answer in another shape");

  posted.length = 0;
  const unknown = checkout({ amount_total: 2900, currency: "usd" });
  swap.claim = "?";
  swap.readBack = 7;
  assert.equal(await noteSales(store, [unknown]), 0, "a claim answered in no known shape, its read-back too: not told this run");
  unswap();
  assert.equal(posted.length, 0, "and nothing is posted on it");
  assert.equal(await noteSales(store, [unknown]), 1, "a later healthy run tells it");
  assert.equal(posted.length, 1, "once");

  posted.length = 0;
  const lost = checkout({ amount_total: 2900, currency: "usd" });
  swap.claim = "?";
  swap.landed = true;
  assert.equal(await noteSales(store, [lost]), 1, "a claim that landed with its answer lost is read back as ours: told");
  unswap();
  assert.equal(await noteSales(store, [lost]), 0, "and not told again");
  assert.equal(posted.length, 1, "one line in all");
});

test("a paid checkout: the amount Stripe charged, read exactly, or no figure at all", async () => {
  const store = await chatStore();
  await noteSales(store, [checkout({ amount_total: 2900, currency: "usd" })]);
  assert.deepEqual(posted, ["New sale on Harbor Kitchen: $29, Weeknight Club"], "a whole amount in a named currency is stated");
  posted.length = 0;
  await noteSales(store, [checkout({ amount_total: 0, currency: "usd" })]);
  assert.deepEqual(posted, ["New sale on Harbor Kitchen: $0, Weeknight Club"], "an exact zero (a free order) is a real amount");
  posted.length = 0;
  await noteSales(store, [checkout({ amount_total: 2900, currency: "eur" })]);
  assert.deepEqual(posted, ["New sale on Harbor Kitchen: €29, Weeknight Club"], "in the currency Stripe names");
  for (const [label, shape] of UNKNOWN) {
    posted.length = 0;
    await noteSales(store, [checkout({ amount_total: shape.amount, currency: shape.currency })]);
    assert.deepEqual(posted, ["New sale on Harbor Kitchen: Weeknight Club"], `${label}: the sale is told, without a figure`);
  }
});

test("a one-click offer: the amount Stripe charged, read exactly, or no figure at all", async () => {
  const store = await chatStore();
  await noteOfferSale(store, offered, offerPayment({ amount: 1500, currency: "usd" }));
  assert.deepEqual(posted, ["New sale on Harbor Kitchen: $15, Pastry Guide (one-click offer)"], "a whole amount in a named currency is stated");
  posted.length = 0;
  await noteOfferSale(store, offered, offerPayment({ amount: 0, currency: "usd" }));
  assert.deepEqual(posted, ["New sale on Harbor Kitchen: $0, Pastry Guide (one-click offer)"], "an exact zero is a real amount");
  for (const [label, shape] of UNKNOWN) {
    posted.length = 0;
    await noteOfferSale(store, offered, offerPayment(shape));
    assert.deepEqual(posted, ["New sale on Harbor Kitchen: Pastry Guide (one-click offer)"], `${label}: the sale is told, without a figure`);
  }
});
