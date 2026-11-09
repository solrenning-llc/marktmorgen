/**
 * Edge cases of the move to the monthly price (630 [HN6](14), unit 2a;
 * lib/yearly-fallback.ts), from the independent review of 4 November 2026,
 * against a STATEFUL stand-in Stripe (a paid move really makes the
 * subscription monthly and the year void), so double clicks and replays read
 * what Stripe would answer. Each "found by the review" case failed before its
 * fix: a failure between stopping the year's retries and the move left the
 * year frozen; a decline whose month could not be voided, or a pending update
 * whose payment was not known to have failed, turned the year back on beside
 * a payable month; a 409 was taken for a refusal; a list that could not be
 * written was only a log line; the lock was shorter than its calls; an
 * archived monthly price stayed cached; the monthly price had no tax
 * behavior; a bank debit was offered.
 */
import { FALLBACK_BOTH_KEY, FALLBACK_CHECK_KEY, FALLBACK_LOCK_SECONDS, FALLBACK_STRIPE_VERSION, FALLBACK_VOID_KEY, moveToMonthly } from "@/lib/yearly-fallback";
import { tierPriceBody } from "@/lib/tier-switch";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setProductYearly, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_fallback_edge_only";
const OWNER = "owner@example.com";
const ACCOUNT = "acct_1TestHarbor0001";
const SUB = "sub_Year00000001";
const YEAR = "in_Year00000001";
const MONTH = "in_Month0000001";

type Call = { method: string; path: string; body: URLSearchParams; key: string | null; version: string | null };
const calls: Call[] = [];
let product = "";

// ---- stateful Stripe -------------------------------------------------------
type State = {
  interval: "year" | "month";
  pendingUpdate: boolean;
  year: { status: string; auto_advance: boolean; amount_paid: number };
  month: { status: string } | null;
  schedule: string | null;
  method: string;
  /** The membership's own metadata, and what waits on a pending update until it applies. */
  meta: Record<string, string>;
  pendingMeta: Record<string, string>;
};
let st: State;
const fresh = (): State => ({ interval: "year", pendingUpdate: false, year: { status: "open", auto_advance: true, amount_paid: 0 }, month: null, schedule: null, method: "card", meta: {}, pendingMeta: {} });
/** How the next subscription update answers: "paid" applies it; others as named. */
let updateMode: "paid" | "declined" | "declined-paid-latest" | "declined-unexpanded" | "declined-latest-is-year" | "applied-open" | "timeout" | "timeout-applied" | "500" | "400" | "409" | "429" | "price-inactive" = "paid";
let failInvoiceReadAt = -1; // 1-based count of GET /invoices/YEAR to answer 500
let invoiceReadCount = 0;
let monthVoidFails = false;
let yearVoidFails = false;
let yearPaidOnVoid = false; // the year gets paid by the member right as we void
/**
 * Rule 30: undefined answers with the object's own id; a string answers with another object's id; null with no id;
 * NULL_BODY with an HTTP 200 whose JSON body is `null` itself.
 */
const NULL_BODY = "null body";
let subReplyId: string | null | undefined;
let yearReplyAt = -1; // 1-based count of GET /invoices/YEAR answered with yearReplyId
let yearReplyId: string | null | undefined;
let yearReplyStatus: string | undefined; // the status that reply carries, when not the year's own
const replyAs = (row: Record<string, unknown>, id: string | null | undefined, status?: string) => {
  if (id === undefined) return row;
  if (id === NULL_BODY) return null;
  const copy: Record<string, unknown> = status === undefined ? { ...row } : { ...row, status };
  if (id === null) delete copy.id;
  else copy.id = id;
  return copy;
};

const subJson = () => ({
  id: SUB,
  object: "subscription",
  status: st.interval === "year" && st.year.status === "open" ? "past_due" : "active",
  collection_method: "charge_automatically",
  customer: "cus_Dana000001",
  default_payment_method: { id: "pm_Dana00000001", type: st.method },
  discounts: [],
  pause_collection: null,
  cancel_at: null,
  cancel_at_period_end: false,
  schedule: st.schedule,
  metadata: { store: "harbor", product, ...st.meta },
  pending_update: st.pendingUpdate ? { expires_at: 1, metadata: st.pendingMeta } : null,
  // Each item lists its `discounts` as Stripe always sends them at FALLBACK_STRIPE_VERSION (an empty list): an item without
  // them is a discount not known and is never offered (lib/yearly-fallback-rules.ts, tests/yearly-discounts-unknown.test.ts).
  items: {
    data: [
      st.interval === "year"
        ? { id: "si_Year0000001", quantity: 1, discounts: [], price: { id: "price_Year0001", unit_amount: 20000, currency: "usd", metadata: { product }, recurring: { interval: "year", interval_count: 1 } } }
        : { id: "si_Year0000001", quantity: 1, discounts: [], price: { id: "price_Month00001", unit_amount: 2000, currency: "usd", metadata: { product }, recurring: { interval: "month", interval_count: 1 } } },
    ],
  },
});
const yearJson = () => ({ id: YEAR, status: st.year.status, auto_advance: st.year.auto_advance, amount_paid: st.year.amount_paid, billing_reason: "subscription_cycle", amount_due: 20000, currency: "usd", parent: { subscription_details: { subscription: SUB } } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const err = (status: number, type: string, code?: string) => json({ error: { type, code, message: type } }, status);
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  const headers = new Headers(init?.headers);
  calls.push({ method, path, body, key: headers.get("Idempotency-Key"), version: headers.get("Stripe-Version") });
  if (method === "GET" && path === `/subscriptions/${SUB}`) return json(replyAs(subJson(), subReplyId));
  if (method === "GET" && path === `/invoices/${YEAR}`) {
    invoiceReadCount += 1;
    if (invoiceReadCount === failInvoiceReadAt) return err(500, "api_error");
    return json(invoiceReadCount === yearReplyAt ? replyAs(yearJson(), yearReplyId, yearReplyStatus) : yearJson());
  }
  if (method === "POST" && path === "/prices") return json({ id: "price_Month00001" });
  if (method === "POST" && path === `/invoices/${YEAR}`) {
    if (st.year.status === "void") return err(400, "invalid_request_error");
    const a = body.get("auto_advance");
    if (a) st.year.auto_advance = a === "true";
    return json(yearJson());
  }
  if (method === "POST" && path === `/subscriptions/${SUB}`) {
    const metadata = Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
    // As Stripe (changelog 2026-05-27.dahlia, pending-subscription-update-metadata): metadata on a change made only if
    // paid is refused before that version; from it, kept on the pending update and merged only once the change applies.
    if (Object.keys(metadata).length && body.get("payment_behavior") === "pending_if_incomplete" && (headers.get("Stripe-Version") ?? "").slice(0, 10) < "2026-05-27") {
      return err(400, "invalid_request_error", "parameter_unknown");
    }
    const applied = () => Object.assign(st.meta, metadata);
    const mode = updateMode;
    if (mode === "timeout") throw new TypeError("fetch failed");
    if (mode === "timeout-applied") {
      applied();
      st.interval = "month";
      st.month = { status: "paid" };
      throw new TypeError("fetch failed");
    }
    if (mode === "500") return err(500, "api_error");
    if (mode === "400") return err(400, "invalid_request_error");
    if (mode === "price-inactive") return err(400, "invalid_request_error", "resource_missing");
    if (mode === "409") return err(409, "idempotency_error");
    if (mode === "429") return err(429, "invalid_request_error", "lock_timeout");
    if (mode.startsWith("declined")) {
      st.pendingUpdate = true;
      st.pendingMeta = metadata;
      st.month = { status: mode === "declined-paid-latest" ? "paid" : "open" };
      const latest =
        mode === "declined-unexpanded" ? MONTH : mode === "declined-latest-is-year" ? { id: YEAR, status: "open" } : { id: MONTH, status: st.month.status, amount_paid: 0, currency: "usd" };
      return json({ ...subJson(), latest_invoice: latest });
    }
    if (mode === "applied-open") {
      applied();
      st.interval = "month";
      st.month = { status: "open" };
      return json({ ...subJson(), latest_invoice: { id: MONTH, status: "open", amount_paid: 0, currency: "usd" } });
    }
    applied();
    st.interval = "month";
    st.pendingUpdate = false;
    st.month = { status: "paid" };
    return json({ ...subJson(), latest_invoice: { id: MONTH, status: "paid", amount_paid: 2000, currency: "usd" } });
  }
  if (method === "POST" && path === `/invoices/${MONTH}/pay`) {
    // The member pays the month's invoice later: the pending update applies, and its metadata with it.
    st.month = { status: "paid" };
    if (st.pendingUpdate) {
      Object.assign(st.meta, st.pendingMeta);
      st.pendingMeta = {};
      st.pendingUpdate = false;
      st.interval = "month";
    }
    return json({ id: MONTH, status: "paid" });
  }
  if (method === "POST" && path === `/invoices/${MONTH}/void`) {
    if (monthVoidFails) return err(500, "api_error");
    if (st.month) st.month.status = "void";
    st.pendingUpdate = false;
    st.pendingMeta = {};
    return json({ id: MONTH, status: "void" });
  }
  if (method === "POST" && path === `/invoices/${YEAR}/void`) {
    if (yearPaidOnVoid) {
      st.year.status = "paid";
      return err(400, "invalid_request_error");
    }
    if (yearVoidFails) return err(500, "api_error");
    if (st.year.status !== "open") return err(400, "invalid_request_error");
    st.year.status = "void";
    return json({ id: YEAR, status: "void" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The moves asked of Stripe, never the record written after one. */
const moves = () => calls.filter((c) => c.method === "POST" && c.path === `/subscriptions/${SUB}` && c.body.has("items[0][price]"));
const posts = () => calls.filter((c) => c.method === "POST" && c.path !== "/prices").map((c) => `${c.path}${c.body.get("auto_advance") ? `:auto_advance=${c.body.get("auto_advance")}` : ""}`);
const members = async (key: string) => ((await redisPipeline([["SMEMBERS", key]]))[0] as string[]) ?? [];
const reason = (r: Awaited<ReturnType<typeof moveToMonthly>>) => (r.ok ? (r.paid ? "moved-paid" : "moved-unpaid") : r.reason);
async function reset(): Promise<void> {
  st = fresh();
  calls.length = 0;
  updateMode = "paid";
  failInvoiceReadAt = -1;
  invoiceReadCount = 0;
  monthVoidFails = false;
  yearVoidFails = false;
  yearPaidOnVoid = false;
  subReplyId = undefined;
  yearReplyAt = -1;
  yearReplyId = undefined;
  yearReplyStatus = undefined;
  await redisPipeline([["DEL", FALLBACK_VOID_KEY, FALLBACK_CHECK_KEY, FALLBACK_BOTH_KEY, `nl:yearly:fallback:try:${YEAR}`]]);
}
/** The year is safe when it is either retried (auto_advance true and open) or recorded for the daily job. */
const yearRecovered = async () => (st.year.status === "open" && st.year.auto_advance) || (await members(FALLBACK_CHECK_KEY)).length > 0 || st.year.status !== "open";
const doubleCharged = () => st.year.status === "paid" && st.month?.status === "paid";

async function main(): Promise<void> {
  // ===================== moveToMonthly ======================================
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

  part("Move: cases that already hold");
  await reset();
  is("paid: moved, year voided, never both", [reason(await move()), st.year.status, st.month?.status, doubleCharged()], ["moved-paid", "void", "paid", false]);
  is("…and the membership now says monthly to everything that reads metadata.every", [st.meta.every, st.meta.monthly_from, st.meta.monthly_replaced], ["month", "year", YEAR]);
  is("double click AFTER a paid move: refused (sub is monthly now), nothing charged again", [reason(await move()), moves().length], ["fallback", 1]);

  await reset();
  const [a, b] = await Promise.all([move(), move()]);
  is("two clicks at the same instant: one moves, the other waits for the lock then reads monthly", [reason(a), reason(b)].sort(), ["fallback", "moved-paid"]);
  is("…and Stripe is asked to move exactly once", moves().length, 1);

  await reset();
  updateMode = "declined";
  await move();
  const k1 = calls.find((c) => c.method === "POST" && c.path === `/subscriptions/${SUB}`)?.key;
  calls.length = 0;
  updateMode = "paid";
  is("declined then another card: second try moves with a new key", [reason(await move()), calls.find((c) => c.method === "POST" && c.path === `/subscriptions/${SUB}`)?.key !== k1], ["moved-paid", true]);

  await reset();
  updateMode = "timeout-applied";
  const t1 = await move();
  updateMode = "paid";
  const t2 = await move();
  is("timeout where Stripe DID apply the move: unknown, then the replayed click is refused, no second month", [reason(t1), reason(t2), moves().length], ["unknown", "fallback", 1]);

  for (const code of ["429", "400"] as const) {
    await reset();
    updateMode = code;
    is(`Stripe ${code} on the move: nothing done, year retried as before`, [reason(await move()), st.year.auto_advance, st.interval], ["error", true, "year"]);
  }

  await reset();
  st.year.status = "void";
  is("year already voided (creator): refused before any write", [reason(await move()), posts()], ["fallback", []]);
  await reset();
  st.year.status = "uncollectible";
  is("year uncollectible: refused before any write", [reason(await move()), posts()], ["fallback", []]);

  await reset();
  yearPaidOnVoid = true;
  const both = await move();
  is("year paid by the member in the seconds of the move: month refunded via BOTH", [reason(both), await members(FALLBACK_BOTH_KEY)], ["moved-paid", [`${ACCOUNT}|${YEAR}|${MONTH}`]]);

  await reset();
  await move();
  is("every Stripe call pinned to the version", calls.filter((c) => c.path !== "/prices").every((c) => c.version === FALLBACK_STRIPE_VERSION), true);

  // L. Third review: the membership's record travels in the move itself, kept pending until the month is paid.
  await reset();
  is(
    "L. every move carries the record, at the pinned version (2026-05-27.dahlia or later, which takes it)",
    [reason(await move()), moves().map((c) => [c.body.get("metadata[every]"), c.version])],
    ["moved-paid", [["month", FALLBACK_STRIPE_VERSION]]],
  );
  await reset();
  updateMode = "applied-open";
  await move();
  is("L'. applied with the month not paid yet: the record applied with it", st.meta.every, "month");
  await reset();
  updateMode = "declined";
  monthVoidFails = true;
  const pending = await move();
  const record = (m: Record<string, unknown>) => [m.every, m.monthly_from, m.monthly_replaced];
  is(
    "L''. the month's payment still processing: the membership keeps its yearly price and none of the record, which waits only on the pending update",
    [reason(pending), subJson().items.data[0].price.recurring.interval, record(subJson().metadata), record(subJson().pending_update?.metadata ?? {})],
    ["unknown", "year", [undefined, undefined, undefined], ["month", "year", YEAR]],
  );
  await fetch(`https://api.stripe.com/v1/invoices/${MONTH}/pay`, { method: "POST" });
  is(
    "L'''. once the month is paid and the move applies: interval month and the record merged, monthly_replaced the yearly invoice, nothing pending",
    [subJson().items.data[0].price.recurring.interval, record(subJson().metadata), subJson().pending_update],
    ["month", ["month", "year", YEAR], null],
  );
  await reset();
  updateMode = "declined";
  await move();
  is("L''''. declined and the month voided: the record never reaches the membership", [st.meta.every, st.pendingUpdate], [undefined, false]);

  // ===================== suspected bugs =====================================
  part("Move: found by the review (each failed before its fix)");

  // A. A failure after auto_advance=false but before the move leaves the year frozen, unrecorded.
  await reset();
  failInvoiceReadAt = 2; // the re-read right after auto_advance=false answers 500
  const frozen = await move();
  is(
    "A. the re-read after auto_advance=false fails: the year is retried again or recorded for the daily job (never left with no retries and no record)",
    [reason(frozen), await yearRecovered(), st.year.auto_advance, await members(FALLBACK_CHECK_KEY)],
    ["error", true, true, []],
  );
  await reset();
  const origPipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (cmds: (string | number)[][]) => {
    if (cmds.some((c) => c[0] === "INCR")) throw new Error("redis down");
    return origPipeline(cmds);
  }) as typeof redis.pipeline;
  const frozen2 = await move();
  redis.pipeline = origPipeline;
  is("A'. Redis INCR fails after auto_advance=false: same, the year is not left frozen", [reason(frozen2), st.year.auto_advance], ["error", true]);

  // B. Declined, but voiding the month's invoice failed: the year is retried while the month stays payable.
  await reset();
  updateMode = "declined";
  monthVoidFails = true;
  const b1 = await move();
  is(
    "B. declined and the month's invoice could not be voided: the year is NOT turned back on (both payable for up to 23 h) and the case is recorded",
    [reason(b1), st.month?.status, st.year.auto_advance, (await members(FALLBACK_CHECK_KEY)).length > 0],
    ["unknown", "open", false, true],
  );

  // C. pending_update present but the month invoice is paid (Payment Records), or latest_invoice not expanded.
  await reset();
  updateMode = "declined-paid-latest";
  const c1 = await move();
  is(
    "C. pending_update with the month invoice PAID (Stripe: 'doesn't always mean that the payment failed'): the year is not retried, the case is recorded",
    [reason(c1), st.year.auto_advance, (await members(FALLBACK_CHECK_KEY)).length > 0],
    ["unknown", false, true],
  );
  await reset();
  updateMode = "declined-unexpanded";
  const c2 = await move();
  is(
    "C'. pending_update with latest_invoice as a bare id (no invoice read back): never taken for a decline, the year is not retried, the case is recorded",
    [reason(c2), st.year.auto_advance, (await members(FALLBACK_CHECK_KEY)).length > 0],
    ["unknown", false, true],
  );
  await reset();
  updateMode = "declined-latest-is-year";
  await move();
  is("C''. a latest_invoice that is the failed year itself is never voided as 'the month'", posts().includes(`/invoices/${YEAR}/void`), false);

  // D. retryYear forces auto_advance=true whatever it was before.
  await reset();
  st.year.auto_advance = false; // creator paused retries / dunning finished
  updateMode = "declined";
  is("D. not offered", reason(await move()), "fallback");
  is("D. a year whose retries were off before the member tried is not offered, and left off", [posts(), st.year.auto_advance], [[], false]);

  // E. Lock shorter than the calls it covers.
  await reset();
  await redisPipeline([["DEL", `nl:tier:price:${ACCOUNT}:${product}:2000:usd:month`]]);
  updateMode = "declined";
  await move();
  const stripeCalls = calls.length;
  is(
    "E. the lock outlasts every Stripe call of the longest path at STRIPE_TIMEOUT_MS each",
    [stripeCalls, stripeCalls * (STRIPE_TIMEOUT_MS / 1000) < FALLBACK_LOCK_SECONDS],
    [stripeCalls, true],
  );
  await reset();
  await redisPipeline([["DEL", `nl:tier:price:${ACCOUNT}:${product}:2000:usd:month`]]);
  yearVoidFails = true;
  failInvoiceReadAt = 3;
  await move();
  is("E'. and of the paid path whose void fails and is read again", calls.length * (STRIPE_TIMEOUT_MS / 1000) < FALLBACK_LOCK_SECONDS, true);

  // F. Redis down while recording a double charge: nothing anywhere says the month must be refunded.
  await reset();
  yearPaidOnVoid = true;
  redis.pipeline = (async (cmds: (string | number)[][]) => {
    if (cmds.some((c) => c[0] === "SADD")) throw new Error("redis down");
    return origPipeline(cmds);
  }) as typeof redis.pipeline;
  const f1 = await move();
  redis.pipeline = origPipeline;
  is(
    "F. year AND month paid, Redis down on SADD: the result tells the caller (or Stripe metadata records it), never only a log line",
    [reason(f1), f1.ok ? f1.unrecorded : null, doubleCharged(), await members(FALLBACK_BOTH_KEY)],
    ["moved-paid", "both", true, []],
  );

  // G. An archived monthly price stays cached for 400 days: every move fails forever.
  await reset();
  updateMode = "price-inactive";
  await move();
  const [cached] = await redisPipeline([["GET", `nl:tier:price:${ACCOUNT}:${product}:2000:usd:month`]]);
  is("G. a monthly price Stripe refuses (archived/deleted) is dropped from the cache so the next try makes a new one", cached, null);

  // H. The monthly price is made without tax_behavior (checkout always sets one from store.tax).
  const priceBody = tierPriceBody({ ...store, tax: { ...store.tax, enabled: true, included: true } } as Store, { ...made.product, priceCents: 2000 } as never);
  is("H. the monthly price carries the store's tax behavior, as checkout's price_data does", priceBody.get("tax_behavior"), "inclusive");
  const untaxed = tierPriceBody({ ...store, tax: { ...store.tax, enabled: false } } as Store, { ...made.product, priceCents: 2000 } as never);
  is("H'. and none with tax off, as checkout", untaxed.has("tax_behavior"), false);

  await reset();
  updateMode = "409";
  is(
    "I. a 409 (a request under the same key still in flight) is never taken for a refusal: the year is not retried, the case is recorded",
    [reason(await move()), st.year.auto_advance, (await members(FALLBACK_CHECK_KEY)).length > 0],
    ["unknown", false, true],
  );

  await reset();
  updateMode = "timeout";
  redis.pipeline = (async (cmds: (string | number)[][]) => {
    if (cmds.some((c) => c[0] === "SADD")) throw new Error("redis down");
    return origPipeline(cmds);
  }) as typeof redis.pipeline;
  const j1 = await move();
  redis.pipeline = origPipeline;
  is("J. no answer from Stripe and Redis down on SADD: the result says the case is not recorded", [reason(j1), st.year.auto_advance], ["unknown-unrecorded", false]);

  await reset();
  st.method = "sepa_debit";
  is("K. a membership paid by bank debit (no pending updates) is never offered, nothing sent", [reason(await move()), posts()], ["fallback", []]);

  // L. Rule 30 (from #2517): a Stripe reply decides only when it is the object asked for.
  for (const [label, other] of [["another object's id", "other"], ["no id", null], ["a null body", NULL_BODY]] as const) {
    const otherSub = other === "other" ? "sub_Somebody0001" : other;
    const otherInvoice = other === "other" ? "in_Somebody00001" : other;
    part(`L. replies with ${label}`);
    await reset();
    subReplyId = otherSub;
    is(`L1. the membership read with ${label}: nothing is decided and nothing sent`, [reason(await move()), posts(), st.year.auto_advance], ["error", [], true]);

    await reset();
    yearReplyAt = 1;
    yearReplyId = otherInvoice;
    is(`L2. the failed invoice read with ${label}: nothing is decided and nothing sent`, [reason(await move()), posts(), st.year.auto_advance], ["error", [], true]);

    await reset();
    yearReplyAt = 2;
    yearReplyId = otherInvoice;
    is(
      `L3. the year read again with ${label} after its retries stopped: never moved on it, and retried as before`,
      [reason(await move()), moves().length, st.year.status, st.year.auto_advance],
      ["error", 0, "open", true],
    );

    // A null body carries no status at all: one case for it (Claude 6 on #3098, the month already charged).
    for (const said of other === NULL_BODY ? ["void"] : ["void", "paid"]) {
      await reset();
      yearVoidFails = true;
      yearReplyAt = 3;
      yearReplyId = otherInvoice;
      yearReplyStatus = said;
      const l4 = await move();
      is(
        `L4. moved and paid, the void failed, and the year read back ${other === NULL_BODY ? "" : `${said} `}with ${label}: left to void again for the daily job, never taken as ${said === "void" ? "voided" : "paid twice"}`,
        [reason(l4), st.year.status, await members(FALLBACK_VOID_KEY), await members(FALLBACK_BOTH_KEY)],
        ["moved-paid", "open", [`${ACCOUNT}|${YEAR}|${MONTH}`], []],
      );
    }
  }
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
