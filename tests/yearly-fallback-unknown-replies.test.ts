/**
 * CX-123 rule 24 on the move of a yearly member to monthly (lib/yearly-fallback.ts): the Redis replies that decide
 * what is sent to Stripe, and what the member and the creator are told, are read in their exact shape. Synthetic
 * Stripe stand-in and the in-memory Redis double only.
 *
 *   - The try counter (INCR) names the idempotency key of the move. A reply of any other shape is not "try 1": the
 *     move is never sent under a key a declined try already used (Stripe would answer it with the saved decline, the
 *     new card never tried), and the year's own retries are turned back on, nothing having been sent.
 *   - A list for the daily job (SADD) is "recorded" only on a whole count. Any other reply says it could not be left
 *     ("unknown-unrecorded", `unrecorded`), never that the daily job will read it.
 *
 * Healthy and confirmed controls keep their outcomes.
 */
import { FALLBACK_BOTH_KEY, FALLBACK_CHECK_KEY, FALLBACK_VOID_KEY, moveToMonthly } from "@/lib/yearly-fallback";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setProductYearly, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_fallback_unknown_only";

const OWNER = "owner@example.com";
const calls: { method: string; path: string; body: URLSearchParams; key: string | null }[] = [];
let product = "";
type Outcome = "paid" | "declined" | "voidFails" | "timeout";
let outcome: Outcome = "paid";

const subscription = () => ({
  id: "sub_Year00000001",
  object: "subscription",
  status: "past_due",
  collection_method: "charge_automatically",
  customer: "cus_Dana000001",
  default_payment_method: { id: "pm_Card00000001", type: "card" },
  discount: null,
  discounts: [],
  pause_collection: null,
  cancel_at: null,
  cancel_at_period_end: false,
  metadata: { store: "harbor", product },
  latest_invoice: "in_Year00000001",
  items: { data: [{ id: "si_Year0000001", quantity: 1, price: { id: "price_Year0001", unit_amount: 20000, currency: "usd", metadata: { product }, recurring: { interval: "year", interval_count: 1 } } }] },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  calls.push({ method, path, body, key: new Headers(init?.headers).get("Idempotency-Key") });
  if (method === "GET" && path === "/subscriptions/sub_Year00000001") return json(subscription());
  if (method === "GET" && path === "/invoices/in_Year00000001") {
    return json({ id: "in_Year00000001", status: "open", billing_reason: "subscription_cycle", amount_due: 20000, currency: "usd", parent: { subscription_details: { subscription: "sub_Year00000001" } } });
  }
  if (method === "POST" && path === "/prices") return json({ id: "price_Month00001" });
  if (method === "POST" && path === "/invoices/in_Year00000001") return json({ id: "in_Year00000001" });
  if (method === "POST" && path === "/subscriptions/sub_Year00000001") {
    if (outcome === "timeout") throw new TypeError("fetch failed");
    if (outcome === "declined") return json({ id: "sub_Year00000001", pending_update: { expires_at: 1 }, latest_invoice: { id: "in_Month0000001", status: "open" } });
    return json({ id: "sub_Year00000001", pending_update: null, latest_invoice: { id: "in_Month0000001", status: "paid", amount_paid: 2000, currency: "usd" } });
  }
  if (method === "POST" && path === "/invoices/in_Month0000001/void") return json({ id: "in_Month0000001", status: "void" });
  if (method === "POST" && path === "/invoices/in_Year00000001/void") {
    return outcome === "voidFails" ? json({ error: { type: "api_error", message: "down" } }, 500) : json({ id: "in_Year00000001", status: "void" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const moves = () => calls.filter((c) => c.method === "POST" && c.path === "/subscriptions/sub_Year00000001");
const retries = () => calls.filter((c) => c.method === "POST" && c.path === "/invoices/in_Year00000001").map((c) => c.body.get("auto_advance"));
const members = async (key: string) => ((await redisPipeline([["SMEMBERS", key]]))[0] as string[]) ?? [];

/** The Redis double, answering one command (matched by name and key prefix) in another shape. */
const real = redis.pipeline;
function answer(command: string, prefix: string, shape: unknown): void {
  redis.pipeline = async (commands) => {
    const replies = await real(commands);
    return commands.map((one, i) => (String(one[0]).toUpperCase() === command && String(one[1]).startsWith(prefix) ? shape : replies[i]));
  };
}
const restore = () => {
  redis.pipeline = real;
};

/** Shapes that are not a whole count: missing, null, text, a fraction, a negative, a list, an object. */
const NOT_A_COUNT: [string, unknown][] = [
  ["missing", undefined],
  ["null", null],
  ["text", "OK"],
  ["a fraction", 1.5],
  ["a negative", -1],
  ["a list", [1]],
  ["an object", { result: 1 }],
];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  product = made.product.id;
  await setProductLink(OWNER, product, "https://example.com/club");
  await setProductYearly(OWNER, product, { cents: 20000 });
  const store = (await storeForEmail(OWNER)) as Store;
  const move = () => moveToMonthly(store, "cus_Dana000001", "sub_Year00000001", "in_Year00000001");
  const clear = async () => {
    calls.length = 0;
    await redisPipeline([["DEL", FALLBACK_VOID_KEY, FALLBACK_CHECK_KEY, FALLBACK_BOTH_KEY]]);
  };

  part("Control: a declined try, then another, each under a key of its own");
  outcome = "declined";
  await clear();
  is("declined", await move(), { ok: false, reason: "declined" });
  const first = moves()[0]?.key ?? null;
  is("the first try's key", first, "fallback:in_Year00000001:1");

  part("The try counter in an unknown shape: the move is never sent under a used key");
  for (const [label, shape] of NOT_A_COUNT) {
    outcome = "paid";
    await clear();
    answer("INCR", "nl:yearly:fallback:try:", shape);
    const result = await move();
    restore();
    is(`${label}: not moved, said as not done`, result, { ok: false, reason: "error" });
    is(`${label}: no move sent to Stripe, so none under the declined try's key`, moves().map((c) => c.key), []);
    is(`${label}: the year's own retries stopped, then turned back on, nothing having been sent`, retries(), ["false", "true"]);
  }
  part("Control: a whole count still names the next try");
  outcome = "paid";
  await clear();
  const paid = await move();
  is("moved and paid", paid.ok ? paid.paid : paid.reason, true);
  is("under a key of its own, never the declined try's", [moves().length, moves()[0]?.key !== first, Boolean(moves()[0]?.key?.startsWith("fallback:in_Year00000001:"))], [1, true, true]);

  part("A list for the daily job answered in an unknown shape: said as not left");
  for (const [label, shape] of NOT_A_COUNT) {
    outcome = "timeout";
    await clear();
    answer("SADD", FALLBACK_CHECK_KEY, shape);
    const unanswered = await move();
    restore();
    is(`${label}: Stripe gave no answer and the check could not be confirmed left: "unknown-unrecorded"`, unanswered, { ok: false, reason: "unknown-unrecorded" });

    outcome = "voidFails";
    await clear();
    answer("SADD", FALLBACK_VOID_KEY, shape);
    const unvoided = await move();
    restore();
    is(`${label}: the year's void left for the daily job, not confirmed: said so`, unvoided.ok ? unvoided.unrecorded : unvoided.reason, "void");
  }

  part("Controls: a confirmed list entry, new or already there");
  outcome = "timeout";
  await clear();
  is("left for the daily job", await move(), { ok: false, reason: "unknown" });
  is("on the list", await members(FALLBACK_CHECK_KEY), ["acct_1TestHarbor0001|sub_Year00000001|in_Year00000001"]);
  calls.length = 0;
  is("already on it (a count of 0): still left, said as left", await move(), { ok: false, reason: "unknown" });
  outcome = "voidFails";
  await clear();
  const voidLeft = await move();
  is("a void left for the daily job: nothing unrecorded", voidLeft.ok ? [voidLeft.paid, voidLeft.unrecorded ?? null] : voidLeft.reason, [true, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
