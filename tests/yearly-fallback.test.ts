/**
 * Keeping a yearly member whose renewal failed, at the monthly price
 * (630 [HN6](14), unit 2a; added 4 November 2026; lib/yearly-fallback.ts),
 * against a stand-in Stripe and the in-memory Redis double only. Checked:
 * the subscription and the failed invoice are read again from Stripe; the
 * year is never retried while the month is charged; the move is the
 * product's monthly price from now, no proration, made only if paid; paid,
 * the year is voided; declined, the month's invoice is voided and the year
 * retried as before; someone else's membership is refused.
 */
import { FALLBACK_VOID_KEY, fallbackBody, moveToMonthly } from "@/lib/yearly-fallback";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setProductYearly, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_fallback_only";

const OWNER = "owner@example.com";
const calls: { method: string; path: string; body: URLSearchParams; key: string | null }[] = [];
let product = "";
let outcome: "paid" | "declined" | "voidFails" | "applied-open" = "paid";
let invoiceStatus = "open";

const subscription = () => ({
  id: "sub_Year00000001",
  object: "subscription",
  status: "past_due",
  customer: "cus_Dana000001",
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
  const headers = new Headers(init?.headers);
  calls.push({ method, path, body, key: headers.get("Idempotency-Key") });
  if (method === "GET" && path === "/subscriptions/sub_Year00000001") return json(subscription());
  if (method === "GET" && path === "/invoices/in_Year00000001") {
    return json({ id: "in_Year00000001", status: invoiceStatus, billing_reason: "subscription_cycle", amount_due: 20000, currency: "usd", parent: { subscription_details: { subscription: "sub_Year00000001" } } });
  }
  if (method === "POST" && path === "/prices") return json({ id: "price_Month00001" });
  if (method === "POST" && path === "/invoices/in_Year00000001") return json({ id: "in_Year00000001" });
  if (method === "POST" && path === "/subscriptions/sub_Year00000001") {
    return json(
      outcome === "declined"
        ? { id: "sub_Year00000001", pending_update: { expires_at: 1 }, latest_invoice: { id: "in_Month0000001", status: "open" } }
        : outcome === "applied-open"
          ? { id: "sub_Year00000001", pending_update: null, latest_invoice: { id: "in_Month0000001", status: "open", amount_paid: 0, currency: "usd" } }
          : { id: "sub_Year00000001", pending_update: null, latest_invoice: { id: "in_Month0000001", status: "paid", amount_paid: 2000, currency: "usd" } },
    );
  }
  if (method === "POST" && path === "/invoices/in_Month0000001/void") return json({ id: "in_Month0000001", status: "void" });
  if (method === "POST" && path === "/invoices/in_Year00000001/void") {
    return outcome === "voidFails" ? json({ error: { type: "api_error", message: "down" } }, 500) : json({ id: "in_Year00000001", status: "void" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const steps = () => calls.filter((c) => c.method === "POST").map((c) => `${c.path}${c.body.get("auto_advance") ? `:auto_advance=${c.body.get("auto_advance")}` : ""}`);

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

  part("The move, as Stripe is sent it");
  const sent = fallbackBody("si_Year0000001", "price_Month00001", "in_Year00000001");
  is(
    "the product's monthly price from now, no proration (the year was never paid), made only if the month is paid",
    [sent.get("items[0][price]"), sent.get("billing_cycle_anchor"), sent.get("proration_behavior"), sent.get("payment_behavior"), sent.get("metadata[monthly_replaced]")],
    ["price_Month00001", "now", "none", "pending_if_incomplete", "in_Year00000001"],
  );

  part("Paid");
  calls.length = 0;
  const paid = await moveToMonthly(store, "cus_Dana000001", "sub_Year00000001", "in_Year00000001");
  is("moved: the month charged, from the member's own record", paid.ok ? [paid.paid, paid.charged, paid.offer.monthly, paid.offer.extraPerYear] : paid.reason, [true, 2000, 2000, 4000]);
  is(
    "in this order: the year stops retrying, the price is made, the move, then the year is voided",
    steps().filter((step) => step !== "/prices"),
    ["/invoices/in_Year00000001:auto_advance=false", "/subscriptions/sub_Year00000001", "/invoices/in_Year00000001/void"],
  );
  is("the move is sent once, under a key Stripe answers again rather than doing it twice", calls.find((c) => c.path === "/subscriptions/sub_Year00000001" && c.method === "POST")?.key, "fallback:in_Year00000001");
  is("read again from Stripe before anything: the subscription and the failed invoice", [calls[0].path, calls[1].path], ["/subscriptions/sub_Year00000001", "/invoices/in_Year00000001"]);

  part("Declined");
  outcome = "declined";
  calls.length = 0;
  const declined = await moveToMonthly(store, "cus_Dana000001", "sub_Year00000001", "in_Year00000001");
  is("nothing changed", declined.ok ? "moved" : declined.reason, "declined");
  is(
    "the month's invoice is voided and the year is retried again as before; the year is never voided",
    [steps().includes("/invoices/in_Month0000001/void"), steps().at(-1), steps().includes("/invoices/in_Year00000001/void")],
    [true, "/invoices/in_Year00000001:auto_advance=true", false],
  );

  part("Moved, the first month still being paid");
  outcome = "applied-open";
  calls.length = 0;
  const open = await moveToMonthly(store, "cus_Dana000001", "sub_Year00000001", "in_Year00000001");
  is(
    "Stripe applied the move: the year is voided all the same, the open month is left to Stripe's own retries, never voided",
    [open.ok && open.paid, open.ok && open.charged, steps().includes("/invoices/in_Year00000001/void"), steps().includes("/invoices/in_Month0000001/void"), steps().includes("/invoices/in_Year00000001:auto_advance=true")],
    [false, 0, true, false, false],
  );

  part("Paid, but voiding the year failed");
  outcome = "voidFails";
  calls.length = 0;
  await redisPipeline([["DEL", FALLBACK_VOID_KEY]]);
  const kept = await moveToMonthly(store, "cus_Dana000001", "sub_Year00000001", "in_Year00000001");
  const [left] = await redisPipeline([["SMEMBERS", FALLBACK_VOID_KEY]]);
  is(
    "moved; the year stays with no automatic retry and is kept for the daily job to void",
    [kept.ok, steps().includes("/invoices/in_Year00000001:auto_advance=true"), left],
    [true, false, ["acct_1TestHarbor0001|in_Year00000001"]],
  );

  part("Refused before anything is charged");
  outcome = "paid";
  calls.length = 0;
  const other = await moveToMonthly(store, "cus_Someone001", "sub_Year00000001", "in_Year00000001");
  is("someone else's membership: refused, nothing sent to Stripe but the reads", [other.ok ? "moved" : other.reason, calls.filter((c) => c.method === "POST").length], ["gone", 0]);
  invoiceStatus = "paid";
  calls.length = 0;
  const settled = await moveToMonthly(store, "cus_Dana000001", "sub_Year00000001", "in_Year00000001");
  is("a renewal paid meanwhile: refused, nothing changed", [settled.ok ? "moved" : settled.reason, calls.filter((c) => c.method === "POST").length], ["fallback", 0]);
  invoiceStatus = "open";
  is("a malformed id: refused without a call", [(await moveToMonthly(store, "cus_Dana000001", "sub_x", "in_Year00000001")).ok, (await moveToMonthly(store, "cus_Dana000001", "sub_Year00000001", "nope")).ok], [false, false]);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
