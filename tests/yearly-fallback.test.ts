/**
 * Keeping a yearly member whose renewal failed, at the monthly price
 * (630 [HN6](14), unit 2a; added 4 November 2026; lib/yearly-fallback.ts),
 * against a stand-in Stripe and the in-memory Redis double only. Checked:
 * the subscription and the failed invoice are read again from Stripe, and the
 * invoice once more right before the move; the year is never retried while
 * the month is charged, nor turned back on when Stripe gave no answer; the
 * move is the product's monthly price from now, no proration, at a pinned
 * API version, made only if paid, under a key new for every try; paid, the
 * year is voided; declined, the month's invoice is voided and the year
 * retried as before; applied with the month not paid yet, the year waits;
 * a year paid meanwhile has the month refunded, never kept twice; someone
 * else's membership is refused. Third review (4 November 2026): the
 * membership's record travels in the move itself, which Stripe accepts only
 * from API version 2026-05-27.dahlia (the stand-in refuses it below that, and
 * keeps it pending until the month is paid, as Stripe does); another change
 * holding the lock answers "busy".
 */
import { FALLBACK_BOTH_KEY, FALLBACK_CHECK_KEY, FALLBACK_STRIPE_VERSION, FALLBACK_VOID_KEY, fallbackBody, fallbackLockKey, moveToMonthly } from "@/lib/yearly-fallback";
import { LockBusyError } from "@/lib/redis-lock";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setProductYearly, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_fallback_only";

const OWNER = "owner@example.com";
const calls: { method: string; path: string; body: URLSearchParams; key: string | null; version: string | null }[] = [];
let product = "";
type Outcome = "paid" | "declined" | "voidFails" | "voidFailsPaid" | "applied-open" | "timeout" | "stripe-500" | "refused-400";
let outcome: Outcome = "paid";
/** What each read of the yearly invoice says, in order; "open" once they run out. */
let invoiceReads: string[] = [];

/**
 * The first API version at which Stripe takes `metadata` with `payment_behavior=pending_if_incomplete`, keeps it in
 * `pending_update.metadata` and merges it into the subscription only when the pending update applies; before it, the
 * request was refused (docs.stripe.com/changelog/dahlia/2026-05-27/pending-subscription-update-metadata, read
 * 4 November 2026). Versions compare by their date.
 */
const PENDING_METADATA_FROM = "2026-05-27.dahlia";
const versionDate = (version: string | null) => (version ?? "").slice(0, 10);
const metadataOf = (body: URLSearchParams) => Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));

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
  const headers = new Headers(init?.headers);
  calls.push({ method, path, body, key: headers.get("Idempotency-Key"), version: headers.get("Stripe-Version") });
  if (method === "GET" && path === "/subscriptions/sub_Year00000001") return json(subscription());
  if (method === "GET" && path === "/invoices/in_Year00000001") {
    const status = invoiceReads.shift() ?? "open";
    return json({ id: "in_Year00000001", status, billing_reason: "subscription_cycle", amount_due: 20000, currency: "usd", parent: { subscription_details: { subscription: "sub_Year00000001" } } });
  }
  if (method === "POST" && path === "/prices") return json({ id: "price_Month00001" });
  if (method === "POST" && path === "/invoices/in_Year00000001") return json({ id: "in_Year00000001" });
  if (method === "POST" && path === "/subscriptions/sub_Year00000001") {
    const metadata = metadataOf(body);
    // As Stripe: metadata on a change made only if paid is refused before 2026-05-27.dahlia; from it, kept on the
    // pending update and merged into the subscription only once the change applies.
    if (Object.keys(metadata).length && body.get("payment_behavior") === "pending_if_incomplete" && versionDate(headers.get("Stripe-Version")) < versionDate(PENDING_METADATA_FROM)) {
      return json({ error: { type: "invalid_request_error", message: "Received unknown parameter: metadata" } }, 400);
    }
    if (outcome === "timeout") throw new TypeError("fetch failed");
    if (outcome === "stripe-500") return json({ error: { type: "api_error", message: "down" } }, 500);
    if (outcome === "refused-400") return json({ error: { type: "invalid_request_error", message: "no" } }, 400);
    const kept = subscription().metadata;
    if (outcome === "declined") return json({ id: "sub_Year00000001", metadata: kept, pending_update: { expires_at: 1, metadata }, latest_invoice: { id: "in_Month0000001", status: "open" } });
    if (outcome === "applied-open") return json({ id: "sub_Year00000001", metadata: { ...kept, ...metadata }, pending_update: null, latest_invoice: { id: "in_Month0000001", status: "open", amount_paid: 0, currency: "usd" } });
    return json({ id: "sub_Year00000001", metadata: { ...kept, ...metadata }, pending_update: null, latest_invoice: { id: "in_Month0000001", status: "paid", amount_paid: 2000, currency: "usd" } });
  }
  if (method === "POST" && path === "/invoices/in_Month0000001/void") return json({ id: "in_Month0000001", status: "void" });
  if (method === "POST" && path === "/invoices/in_Year00000001/void") {
    return outcome === "voidFails" || outcome === "voidFailsPaid" ? json({ error: { type: "api_error", message: "down" } }, 500) : json({ id: "in_Year00000001", status: "void" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const posts = () => calls.filter((c) => c.method === "POST" && c.path !== "/prices").map((c) => `${c.path}${c.body.get("auto_advance") ? `:auto_advance=${c.body.get("auto_advance")}` : ""}`);
const members = async (key: string) => ((await redisPipeline([["SMEMBERS", key]]))[0] as string[]) ?? [];
const clear = async () => {
  calls.length = 0;
  invoiceReads = [];
  await redisPipeline([["DEL", FALLBACK_VOID_KEY, FALLBACK_CHECK_KEY, FALLBACK_BOTH_KEY]]);
};

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
  const ACCOUNT = "acct_1TestHarbor0001";

  part("The move, as Stripe is sent it");
  const sent = fallbackBody("si_Year0000001", "price_Month00001", "in_Year00000001");
  is(
    "the product's monthly price from now, no proration (the year was never paid), made only if the month is paid, with the membership's record in the same call",
    [sent.get("items[0][price]"), sent.get("billing_cycle_anchor"), sent.get("proration_behavior"), sent.get("payment_behavior"), metadataOf(sent)],
    ["price_Month00001", "now", "none", "pending_if_incomplete", { every: "month", monthly_from: "year", monthly_replaced: "in_Year00000001" }],
  );
  is(
    "the pinned API version is one that takes metadata on a change made only if paid (2026-05-27.dahlia or later)",
    [/^\d{4}-\d{2}-\d{2}\.[a-z]+$/.test(FALLBACK_STRIPE_VERSION), versionDate(FALLBACK_STRIPE_VERSION) >= versionDate(PENDING_METADATA_FROM)],
    [true, true],
  );

  part("Paid");
  await clear();
  const paid = await move();
  is("moved: the month charged, from the member's own record", paid.ok ? [paid.paid, paid.charged, paid.offer.monthly, paid.offer.extraPerYear] : paid.reason, [true, 2000, 2000, 4000]);
  is("in this order: the year stops retrying, the move, then the year is voided", posts(), ["/invoices/in_Year00000001:auto_advance=false", "/subscriptions/sub_Year00000001", "/invoices/in_Year00000001/void"]);
  is(
    "read again from Stripe before anything, and the yearly invoice once more right before the move",
    calls.filter((c) => c.method === "GET").map((c) => c.path),
    ["/subscriptions/sub_Year00000001", "/invoices/in_Year00000001", "/invoices/in_Year00000001"],
  );
  const update = calls.find((c) => c.path === "/subscriptions/sub_Year00000001" && c.method === "POST");
  is(
    "every call of the move goes at the pinned version, the move itself with its record",
    [calls.filter((c) => c.path !== "/prices").map((c) => c.version), metadataOf(update!.body).every],
    [calls.filter((c) => c.path !== "/prices").map(() => FALLBACK_STRIPE_VERSION), "month"],
  );
  is("at a pinned API version, never the account's default, as every call here", [update?.version, calls.filter((c) => c.path !== "/prices").every((c) => c.version === FALLBACK_STRIPE_VERSION)], [FALLBACK_STRIPE_VERSION, true]);

  part("Declined, then tried again with another card");
  outcome = "declined";
  await clear();
  const declined = await move();
  is("nothing changed", declined.ok ? "moved" : declined.reason, "declined");
  is(
    "the month's invoice is voided and the year is retried again as before; the year is never voided",
    [posts().includes("/invoices/in_Month0000001/void"), posts().at(-1), posts().includes("/invoices/in_Year00000001/void")],
    [true, "/invoices/in_Year00000001:auto_advance=true", false],
  );
  const keys: (string | null)[] = [calls.find((c) => c.path === "/subscriptions/sub_Year00000001" && c.method === "POST")?.key ?? null];
  outcome = "paid";
  await clear();
  await move();
  keys.push(calls.find((c) => c.path === "/subscriptions/sub_Year00000001" && c.method === "POST")?.key ?? null);
  is("every try has a key of its own, so a second try is never Stripe's saved answer to the first", [keys[0] !== keys[1], keys.every((k) => Boolean(k?.startsWith("fallback:in_Year00000001:")))], [true, true]);

  part("No answer from Stripe");
  for (const failure of ["timeout", "stripe-500"] as const) {
    outcome = failure;
    await clear();
    const unknown = await move();
    is(
      `${failure === "timeout" ? "no answer in time" : "Stripe's own failure"}: the move may have been made, so the year is never turned back on; the daily job reads it again`,
      [unknown.ok ? "moved" : unknown.reason, posts().includes("/invoices/in_Year00000001:auto_advance=true"), await members(FALLBACK_CHECK_KEY)],
      ["unknown", false, [`${ACCOUNT}|sub_Year00000001|in_Year00000001`]],
    );
  }
  outcome = "refused-400";
  await clear();
  const refused = await move();
  is("refused for certain by Stripe: nothing was done, and the year is retried as before", [refused.ok ? "moved" : refused.reason, posts().at(-1), await members(FALLBACK_CHECK_KEY)], ["error", "/invoices/in_Year00000001:auto_advance=true", []]);

  part("Moved, the first month still being paid");
  outcome = "applied-open";
  await clear();
  const open = await move();
  is(
    "the year is not voided yet, nor retried by itself; the daily job voids it once the month is paid",
    [open.ok && open.paid, posts().includes("/invoices/in_Year00000001/void"), posts().includes("/invoices/in_Year00000001:auto_advance=true"), posts().includes("/invoices/in_Month0000001/void"), await members(FALLBACK_CHECK_KEY)],
    [false, false, false, false, [`${ACCOUNT}|sub_Year00000001|in_Year00000001`]],
  );

  part("Voiding the year failed after the month was paid");
  outcome = "voidFails";
  await clear();
  const kept = await move();
  is("still open: kept for the daily job to void, with the month that paid the move, and no automatic retry", [kept.ok, posts().includes("/invoices/in_Year00000001:auto_advance=true"), await members(FALLBACK_VOID_KEY)], [true, false, [`${ACCOUNT}|in_Year00000001|in_Month0000001`]]);
  outcome = "voidFailsPaid";
  await clear();
  invoiceReads = ["open", "open", "paid"];
  const both = await move();
  is(
    "paid in those seconds: never on the list to void (it cannot be), but on the one that refunds the month",
    [both.ok, await members(FALLBACK_VOID_KEY), await members(FALLBACK_BOTH_KEY)],
    [true, [], [`${ACCOUNT}|in_Year00000001|in_Month0000001`]],
  );

  part("Refused before anything is charged");
  outcome = "paid";
  await clear();
  const other = await moveToMonthly(store, "cus_Someone001", "sub_Year00000001", "in_Year00000001");
  is("someone else's membership: refused, nothing sent to Stripe but the reads", [other.ok ? "moved" : other.reason, calls.filter((c) => c.method === "POST").length], ["gone", 0]);
  await clear();
  invoiceReads = ["paid"];
  const settled = await move();
  is("a renewal paid already: refused, nothing changed", [settled.ok ? "moved" : settled.reason, calls.filter((c) => c.method === "POST").length], ["fallback", 0]);
  await clear();
  invoiceReads = ["open", "paid"];
  const meanwhile = await move();
  is(
    "paid between the first read and the move: refused right before it, nothing moved, and the paid year is left as it is",
    [meanwhile.ok ? "moved" : meanwhile.reason, posts()],
    ["fallback", ["/invoices/in_Year00000001:auto_advance=false"]],
  );
  await clear();
  await redisPipeline([["SET", fallbackLockKey("sub_Year00000001"), "another-change", "EX", 60]]);
  const held = await move();
  await redisPipeline([["DEL", fallbackLockKey("sub_Year00000001")]]);
  is("another change to the membership holding the lock: busy, never an error, and nothing sent", [held.ok ? "moved" : held.reason, calls.length], ["busy", 0]);
  is("the lock's error carries its own name as well", [new LockBusyError().name, new LockBusyError() instanceof Error], ["LockBusyError", true]);
  is("a malformed id: refused without a call", [(await moveToMonthly(store, "cus_Dana000001", "sub_x", "in_Year00000001")).ok, (await moveToMonthly(store, "cus_Dana000001", "sub_Year00000001", "nope")).ok], [false, false]);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
