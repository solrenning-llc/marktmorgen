/**
 * The move to the monthly price (lib/yearly-fallback.ts) when Stripe applies it and its HTTP 200 reply is not the
 * subscription asked for: a JSON `null` body, a body for another membership, one with no id, or not an object at all
 * (rules 24 and 30; found by Claude 6 on #3098). Stripe may have made the move and charged the month, so nothing is
 * decided on that reply: the result is "unknown", the case is left for the daily job (FALLBACK_CHECK_KEY), the year
 * is not retried beside a month that may be paid, and Stripe is never asked to move a second time. Before the fix
 * the null body threw on `updated.latest_invoice` and the move ended as "error" with nothing recorded.
 *
 * The stand-in Stripe is stateful, as in tests/yearly-fallback-edge.test.ts: an applied move really makes the
 * membership monthly and the month paid, so a replayed click reads what Stripe would answer.
 */
import { FALLBACK_BOTH_KEY, FALLBACK_CHECK_KEY, FALLBACK_VOID_KEY, moveToMonthly } from "@/lib/yearly-fallback";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setProductYearly, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_fallback_post_null_only";
const OWNER = "owner@example.com";
const ACCOUNT = "acct_1TestHarbor0001";
const SUB = "sub_Year00000001";
const YEAR = "in_Year00000001";
const MONTH = "in_Month0000001";

type Call = { method: string; path: string; body: URLSearchParams; key: string | null };
const calls: Call[] = [];
let product = "";

type State = { interval: "year" | "month"; year: { status: string; auto_advance: boolean }; month: { status: string } | null; meta: Record<string, string> };
let st: State;
const fresh = (): State => ({ interval: "year", year: { status: "open", auto_advance: true }, month: null, meta: {} });
/** What the applied move answers with: the subscription itself, or one of the replies that is not it. */
let replyMode: "own" | "null" | "other-id" | "no-id" | "string" | "array" = "own";

const subJson = () => ({
  id: SUB,
  object: "subscription",
  status: st.interval === "year" && st.year.status === "open" ? "past_due" : "active",
  collection_method: "charge_automatically",
  customer: "cus_Dana000001",
  default_payment_method: { id: "pm_Dana00000001", type: "card" },
  discounts: [],
  pause_collection: null,
  cancel_at: null,
  cancel_at_period_end: false,
  schedule: null,
  metadata: { store: "harbor", product, ...st.meta },
  pending_update: null,
  items: {
    data: [
      st.interval === "year"
        ? { id: "si_Year0000001", quantity: 1, price: { id: "price_Year0001", unit_amount: 20000, currency: "usd", metadata: { product }, recurring: { interval: "year", interval_count: 1 } } }
        : { id: "si_Year0000001", quantity: 1, price: { id: "price_Month00001", unit_amount: 2000, currency: "usd", metadata: { product }, recurring: { interval: "month", interval_count: 1 } } },
    ],
  },
});
const yearJson = () => ({ id: YEAR, status: st.year.status, auto_advance: st.year.auto_advance, amount_paid: 0, billing_reason: "subscription_cycle", amount_due: 20000, currency: "usd", parent: { subscription_details: { subscription: SUB } } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const err = (status: number, type: string) => json({ error: { type, message: type } }, status);
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  calls.push({ method, path, body, key: new Headers(init?.headers).get("Idempotency-Key") });
  if (method === "GET" && path === `/subscriptions/${SUB}`) return json(subJson());
  if (method === "GET" && path === `/invoices/${YEAR}`) return json(yearJson());
  if (method === "POST" && path === "/prices") return json({ id: "price_Month00001" });
  if (method === "POST" && path === `/invoices/${YEAR}`) {
    if (st.year.status === "void") return err(400, "invalid_request_error");
    const a = body.get("auto_advance");
    if (a) st.year.auto_advance = a === "true";
    return json(yearJson());
  }
  if (method === "POST" && path === `/subscriptions/${SUB}`) {
    // Stripe applies the move and charges the month, whatever its reply's body then says.
    Object.assign(st.meta, Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])));
    st.interval = "month";
    st.month = { status: "paid" };
    const own = { ...subJson(), latest_invoice: { id: MONTH, status: "paid", amount_paid: 2000, currency: "usd" } };
    if (replyMode === "null") return json(null);
    if (replyMode === "other-id") return json({ ...own, id: "sub_Somebody0001" });
    if (replyMode === "no-id") {
      const copy: Record<string, unknown> = { ...own };
      delete copy.id;
      return json(copy);
    }
    if (replyMode === "string") return json("ok");
    if (replyMode === "array") return json([own]);
    return json(own);
  }
  if (method === "POST" && path === `/invoices/${YEAR}/void`) {
    if (st.year.status !== "open") return err(400, "invalid_request_error");
    st.year.status = "void";
    return json({ id: YEAR, status: "void" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The moves asked of Stripe. */
const moves = () => calls.filter((c) => c.method === "POST" && c.path === `/subscriptions/${SUB}` && c.body.has("items[0][price]"));
const members = async (key: string) => ((await redisPipeline([["SMEMBERS", key]]))[0] as string[]) ?? [];
const reason = (r: Awaited<ReturnType<typeof moveToMonthly>>) => (r.ok ? (r.paid ? "moved-paid" : "moved-unpaid") : r.reason);
async function reset(): Promise<void> {
  st = fresh();
  calls.length = 0;
  replyMode = "own";
  await redisPipeline([["DEL", FALLBACK_VOID_KEY, FALLBACK_CHECK_KEY, FALLBACK_BOTH_KEY, `nl:yearly:fallback:try:${YEAR}`]]);
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  product = made.product.id;
  await setProductLink(OWNER, product, "https://example.com/club");
  await setProductYearly(OWNER, product, { cents: 20000 });
  const store = (await storeForEmail(OWNER)) as Store;
  const move = () => moveToMonthly(store, "cus_Dana000001", SUB, YEAR);
  const check = `${ACCOUNT}|${SUB}|${YEAR}`;

  part("The move's own reply still decides");
  await reset();
  is("the subscription itself answers: moved and paid, the year voided", [reason(await move()), st.year.status, await members(FALLBACK_CHECK_KEY)], ["moved-paid", "void", []]);

  part("An applied move whose reply is not the subscription asked for");
  for (const mode of ["null", "other-id", "no-id", "string", "array"] as const) {
    await reset();
    replyMode = mode;
    const r = await move();
    is(
      `${mode}: "unknown", kept for the daily job, the year neither voided nor retried beside the paid month, nothing else sent`,
      [reason(r), st.month?.status, st.year.status, st.year.auto_advance, await members(FALLBACK_CHECK_KEY), await members(FALLBACK_VOID_KEY), await members(FALLBACK_BOTH_KEY), moves().length],
      ["unknown", "paid", "open", false, [check], [], [], 1],
    );
    is(
      `${mode}: no call after the move (no void, no second move, no retry of the year)`,
      calls.slice(calls.indexOf(moves()[0]) + 1).map((c) => `${c.method} ${c.path}`),
      [],
    );
  }

  part("A replayed click after the null reply");
  await reset();
  replyMode = "null";
  await move();
  replyMode = "own";
  is("the membership now reads monthly: refused, Stripe asked to move only once", [reason(await move()), moves().length], ["fallback", 1]);

  part("The null reply with the daily job's list unwritable");
  await reset();
  replyMode = "null";
  const origPipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (cmds: (string | number)[][]) => {
    if (cmds.some((c) => c[0] === "SADD")) throw new Error("redis down");
    return origPipeline(cmds);
  }) as typeof redis.pipeline;
  const unrecorded = await move();
  redis.pipeline = origPipeline;
  is("the result says the case is not recorded, never \"error\"", [reason(unrecorded), st.year.auto_advance], ["unknown-unrecorded", false]);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
