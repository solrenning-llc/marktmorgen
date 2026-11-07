/**
 * 426 [BX2] unit 2: the year reading (docs/bx2-earnings-design.md, "Units", 2).
 *
 * lib/earnings-read.ts reads twelve months of a store's money from the
 * creator's own Stripe account and the PayPal sales kept here, with the same
 * page caps as the sales reading (within SALES_READ_SHAPE: 55 of its 58 Stripe
 * pages, 2,000 PayPal sales and PAYPAL_REFUNDS_READ refunds), as one of the store's two
 * heavy readings of the UTC day, counted before anything is read, and keeps
 * the months as a fourth kept reading ("earnings").
 *
 * What fails here:
 *   - a reading past SALES_READ_SHAPE (pages, commands, bytes);
 *   - Stripe or PayPal read before the day's heavy reading is taken, or read
 *     at all when the day's heavy readings are used;
 *   - a list that could not be read, or was capped, giving an amount (or a
 *     zero) for a month it did not reach: those months say "unknown";
 *   - a renewal dated by when its invoice was made rather than paid, or the
 *     oldest month's renewals said as known before Stripe's retry window is
 *     proved from dated documentation;
 *   - the base's decided rules (#2941, docs/bx2-earnings-design.md "Units" 2)
 *     not followed: every paid invoice of the store's memberships counted but
 *     subscription_create; disputes read from their own balance transactions
 *     or said not read (never DISPUTE_TAKES), with money given back
 *     (`reinstated`) said not read; every record with its provider's id; a
 *     paid-invoice list that stops knowing no month; the reading's time taken
 *     once every list was read;
 *   - the fourth kept copy missing from READING_KINDS, or its cost not in the
 *     store-readings line.
 * Synthetic only: a stand-in Stripe (fetch) and the in-memory Redis.
 */
process.env.STRIPE_SECRET_KEY = "sk_test_earnings_stand_in";

import { EARNINGS_PAYPAL_REFUNDS, EARNINGS_PAYPAL_SALES, EARNINGS_STRIPE_PAGES, RENEWAL_PAID_WITHIN_DAYS, readEarningsYear } from "@/lib/earnings-read";
import { type Earnings, type SourceMonth, earningsMonths, netWords, readingSince } from "@/lib/earnings-by-month";
import { SALES_READ_SHAPE } from "@/lib/read-ceilings";
import { PAYPAL_REFUNDS_READ } from "@/lib/paypal-sales";
import { HEAVY_READINGS_PER_DAY, READING_COPY_MAX_BYTES, READING_KEEP_SECONDS, READING_KINDS, ReadingsUsed } from "@/lib/store-readings";
import type { Store } from "@/lib/store";
import { COST_LINES, DB_BYTE_MONTH } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { readFileSync } from "node:fs";

const NOW = Date.UTC(2031, 5, 15, 12, 0); // 15 June 2031, 12:00 UTC
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sec = (ms: number) => Math.floor(ms / 1000);

// ---- The stand-in Stripe: five lists, newest first, with created[gte] and starting_after as Stripe reads them.
type Row = Record<string, unknown> & { id: string; created: number };
type ListPath = "/checkout/sessions" | "/payment_intents" | "/invoices" | "/refunds" | "/disputes";
let stripe: Record<ListPath, Row[]>;
let broken: Partial<Record<ListPath, "garbled" | "error" | "shuffled">> = {};
const log: string[] = [];
const pagesOf: Record<string, number> = {};
let versions = new Set<string>();
// The clock the reading sees: each Stripe page moves it on by `tick` ms (0 unless a check sets it).
const realNow = Date.now.bind(Date);
let clock: number | null = null;
let tick = 0;
Date.now = () => (clock === null ? realNow() : clock);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "") as ListPath;
  log.push(`stripe ${path}`);
  if (clock !== null) clock += tick;
  pagesOf[path] = (pagesOf[path] ?? 0) + 1;
  const version = (init?.headers as Record<string, string> | undefined)?.["Stripe-Version"];
  versions.add(version ?? "(none)");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (broken[path] === "garbled") return json({ object: "list", data: "nothing here", has_more: false });
  if (broken[path] === "error") return json({ error: { type: "api_error", message: "stand-in failure" } }, 500);
  const gte = Number(url.searchParams.get("created[gte]") ?? 0);
  const after = url.searchParams.get("starting_after");
  const limit = Number(url.searchParams.get("limit") ?? 10);
  const rows = (stripe[path] ?? []).filter((r) => r.created >= gte).sort((a, b) => b.created - a.created);
  if (broken[path] === "shuffled" && rows.length > 2) [rows[0], rows[rows.length - 1]] = [rows[rows.length - 1], rows[0]];
  const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
  return json({ object: "list", data: rows.slice(start, start + limit), has_more: start + limit < rows.length });
}) as typeof fetch;

// ---- The in-memory Redis, every command logged in order (and its reply's size), one reply garbled on demand.
const pipeline = redis.pipeline.bind(redis);
let commands = 0;
let replyBytes = 0;
let garbleZrange = false;
(redis as unknown as { pipeline: typeof pipeline }).pipeline = async (cmds: (string | number)[][]) => {
  for (const c of cmds) log.push(`redis ${c[0]} ${c[1]}`);
  commands += cmds.length;
  const replies = await pipeline(cmds);
  replyBytes += Buffer.byteLength(JSON.stringify(replies ?? null), "utf8");
  return garbleZrange && cmds.some((c) => c[0] === "ZREVRANGEBYSCORE" && String(c[1]).startsWith("nl:ppsell:")) ? (replies as unknown[]).map(() => "garbled") : replies;
};

function reset(): void {
  redis.clear();
  stripe = { "/checkout/sessions": [], "/payment_intents": [], "/invoices": [], "/refunds": [], "/disputes": [] };
  broken = {};
  log.length = 0;
  for (const key of Object.keys(pagesOf)) delete pagesOf[key];
  versions = new Set();
  commands = 0;
  replyBytes = 0;
  garbleZrange = false;
  clock = null;
  tick = 0;
}

let storeCount = 0;
function makeStore(paypal = true): Store {
  storeCount += 1;
  return {
    statsId: String(storeCount).padStart(32, "s"),
    handle: "shop",
    previousHandles: ["oldshop"],
    releasedHandles: [],
    stripeAccountId: "acct_1EarningsStandIn",
    paypalSeller: paypal ? "SELLERSTANDIN01" : null,
    currency: "usd",
  } as unknown as Store;
}

// Stripe rows, as the 2026-08-26.dahlia API gives them.
const checkout = (id: string, at: number, cents: number, extra: Record<string, unknown> = {}): Row => ({
  id: `cs_${id}`, object: "checkout.session", created: sec(at), status: "complete", payment_status: "paid", amount_total: cents, currency: "usd", metadata: { store: "shop", product: "p1" }, ...extra,
});
const extraPaid = (id: string, at: number, cents: number, extra: Record<string, unknown> = {}): Row => ({
  id: `pi_${id}`, object: "payment_intent", created: sec(at), status: "succeeded", amount: cents, currency: "usd", metadata: { kind: "upsell", store: "shop", product: "p2" }, ...extra,
});
const invoice = (id: string, made: number, paid: number, cents: number, extra: Record<string, unknown> = {}): Row => ({
  id: `in_${id}`, object: "invoice", created: sec(made), status: "paid", billing_reason: "subscription_cycle", amount_paid: cents, currency: "usd",
  status_transitions: { paid_at: sec(paid), finalized_at: sec(made) }, parent: { type: "subscription_details", subscription_details: { metadata: { store: "shop" } } }, ...extra,
});
const refund = (id: string, at: number, cents: number, extra: Record<string, unknown> = {}): Row => ({
  id: `re_${id}`, object: "refund", created: sec(at), status: "succeeded", amount: cents, currency: "usd", payment_intent: "pi_x", ...extra,
});
const dispute = (id: string, at: number, cents: number, status = "lost"): Row => ({
  id: `dp_${id}`, object: "dispute", created: sec(at), status, amount: cents, currency: "usd", payment_intent: "pi_x",
});

// PayPal sales and full refunds as lib/paypal-sales.ts keeps them.
async function paypalSale(shop: Store, order: string, at: number, cents: number, currency = "usd"): Promise<void> {
  const paid = { store: shop.statsId, order, capture: `CAP${order}`.slice(0, 30), email: "buyer@example.com", product: "p1", cents, currency, at: sec(at) };
  await pipeline([["SET", `nl:ppsell:paid:${order}`, JSON.stringify(paid)], ["ZADD", `nl:ppsell:sales:${shop.statsId}`, String(sec(at)), order]]);
}
async function paypalRefund(shop: Store, order: string, at: number): Promise<void> {
  await pipeline([["ZADD", `nl:ppsell:refunded:${shop.statsId}`, String(sec(at)), order]]);
}

const month = (earnings: Earnings | null | undefined, name: string) => earnings?.months.find((m) => m.month === name);
const of = (earnings: Earnings | null | undefined, name: string, source: string): SourceMonth | undefined => month(earnings, name)?.sources.find((s) => s.source === source);
const states = (earnings: Earnings | null | undefined, source: string) =>
  (earnings?.months ?? []).map((m) => {
    const s = m.sources.find((x) => x.source === source);
    return s ? (s.state === "read" ? "read" : s.why) : "absent";
  });
const months = earningsMonths(NOW, "UTC");

async function main(): Promise<void> {
  part("The reading's caps are the sales reading's, no more");
  const pages = Object.values(EARNINGS_STRIPE_PAGES).reduce((a, b) => a + b, 0);
  is("Stripe pages: checkouts 20, extras 20, invoices 10, refunds 5; disputes not read (their balance transactions' shape is not confirmed)", EARNINGS_STRIPE_PAGES, { checkouts: 20, extras: 20, invoices: 10, refunds: 5 });
  is("their sum, 55, is within SALES_READ_SHAPE's 58 pages", [pages, pages <= SALES_READ_SHAPE.stripePages], [55, true]);
  is("never DISPUTE_TAKES (it drops a dispute once won, so a month shown would be rewritten)", /import\s*\{[^}]*\bDISPUTE_TAKES\b|DISPUTE_TAKES\.has/.test(readFileSync("lib/earnings-read.ts", "utf8")), false);
  is("PayPal: 2,000 sales and PAYPAL_REFUNDS_READ refunds", [EARNINGS_PAYPAL_SALES, EARNINGS_PAYPAL_REFUNDS], [2000, PAYPAL_REFUNDS_READ]);
  is("the renewals' window before the oldest month is under four weeks, so only the oldest month is given up for it", RENEWAL_PAID_WITHIN_DAYS < 28 && RENEWAL_PAID_WITHIN_DAYS > 0, true);

  part("A small store: every month exact, by source and currency, renewals by when they were paid");
  reset();
  {
    const shop = makeStore();
    stripe["/checkout/sessions"] = [
      checkout("a0001", Date.UTC(2031, 5, 3), 5000),
      checkout("b0001", Date.UTC(2031, 5, 3, 1), 9900, { metadata: { store: "elsewhere" } }),
      checkout("c0001", Date.UTC(2031, 5, 3, 2), 9900, { payment_status: "unpaid" }),
      checkout("d0001", Date.UTC(2031, 4, 10), 3000, { currency: "eur", metadata: { store: "oldshop" } }),
    ];
    stripe["/payment_intents"] = [extraPaid("a0001", Date.UTC(2031, 5, 4), 1500), extraPaid("b0001", Date.UTC(2031, 5, 4, 1), 700, { metadata: { kind: "other", store: "shop" } })];
    stripe["/invoices"] = [
      invoice("late01", Date.UTC(2031, 4, 30), Date.UTC(2031, 5, 2), 2000),
      invoice("first1", Date.UTC(2031, 4, 30, 1), Date.UTC(2031, 4, 30, 1), 999, { billing_reason: "subscription_create" }),
      // A member's switch charged at once (lib/tier-switch.ts, lib/yearly-switch.ts): paid money of the membership.
      invoice("switch1", Date.UTC(2031, 5, 9), Date.UTC(2031, 5, 9), 64100, { billing_reason: "subscription_update" }),
      // Another store's switch on the same account: not this store's.
      invoice("switch2", Date.UTC(2031, 5, 9, 1), Date.UTC(2031, 5, 9, 1), 7000, { billing_reason: "subscription_update", parent: { type: "subscription_details", subscription_details: { metadata: { store: "elsewhere" } } } }),
      // A one-off invoice the creator sent from Stripe, of no subscription: not a membership's, and it stops nothing.
      invoice("manual1", Date.UTC(2031, 5, 9, 2), Date.UTC(2031, 5, 9, 2), 3000, { billing_reason: "manual", parent: null }),
    ];
    stripe["/refunds"] = [refund("a0001", Date.UTC(2031, 5, 5), 1000), refund("b0001", Date.UTC(2031, 5, 5, 1), 800, { status: "failed" })];
    stripe["/disputes"] = [dispute("a0001", Date.UTC(2031, 5, 6), 500), dispute("b0001", Date.UTC(2031, 5, 6, 1), 600, "won")];
    await paypalSale(shop, "PAYPALORDER0001", Date.UTC(2031, 5, 7), 4000);
    await paypalSale(shop, "PAYPALORDER0002", Date.UTC(2031, 3, 7), 2500, "eur");
    await paypalRefund(shop, "PAYPALORDER0001", Date.UTC(2031, 5, 8));
    const kept = await readEarningsYear(shop, "UTC", NOW);
    const e = kept?.value ?? null;
    is("read now, not stale, twelve months from June 2031", [kept?.stale, kept?.at, e?.months.length, e?.months[0].month, e?.months[11].month], [false, NOW, 12, "2031-06", "2030-07"]);
    is("the reading begins at the oldest month's floor", e?.since, readingSince(NOW, "UTC"));
    is("Stripe, June: the store's paid checkouts and extras, every paid invoice of its memberships but the first (the renewal paid in June and the switch), refunds; disputes and money given back said not read", of(e, "2031-06", "stripe"), {
      source: "stripe", state: "read",
      lines: [{ currency: "usd", salesCents: 6500, renewalCents: 66100, enteredCents: 0, refundCents: 1000, disputeCents: 0, reinstatedCents: 0, netCents: 71600 }], leftOut: ["dispute", "reinstated"], partly: [],
    });
    is("the disputes list is never read: no page of it is spent", pagesOf["/disputes"] ?? 0, 0);
    is("June's words say disputes are not taken off and money given back is not added", netWords(month(e, "2031-06")?.sources ?? []),
      "After refunds, before disputes: Stripe and PayPal disputes are not read, so they are not taken off. Money given back by Stripe is not read, so it is not added. Partial PayPal refunds are not recorded, so they are not taken off.");
    is("Stripe, May: the sale under an earlier address, in euros; the renewal made in May but paid in June is not in May", of(e, "2031-05", "stripe"), {
      source: "stripe", state: "read",
      lines: [{ currency: "eur", salesCents: 3000, renewalCents: 0, enteredCents: 0, refundCents: 0, disputeCents: 0, reinstatedCents: 0, netCents: 3000 }], leftOut: ["dispute", "reinstated"], partly: [],
    });
    is("PayPal, June: the sale and its full refund; disputes said as not read, refunds read in full only", of(e, "2031-06", "paypal"), {
      source: "paypal", state: "read",
      lines: [{ currency: "usd", salesCents: 4000, renewalCents: 0, enteredCents: 0, refundCents: 4000, disputeCents: 0, reinstatedCents: 0, netCents: 0 }], leftOut: ["dispute"], partly: ["refund"],
    });
    is("PayPal, April: euros on their own line", (of(e, "2031-04", "paypal") as { lines?: unknown })?.lines, [{ currency: "eur", salesCents: 2500, renewalCents: 0, enteredCents: 0, refundCents: 0, disputeCents: 0, reinstatedCents: 0, netCents: 2500 }]);
    is("a month with nothing, read in full: a confirmed zero, not unknown", [of(e, "2031-02", "stripe")?.state, (of(e, "2031-02", "stripe") as { lines?: unknown[] })?.lines?.length], ["read", 0]);
    is("the oldest month: Stripe's renewals there are not proved (a payment retried from before the window), so Stripe says unknown", of(e, "2030-07", "stripe"), { source: "stripe", state: "unknown", why: "not_reached" });
    is("the oldest month: PayPal is read", of(e, "2030-07", "paypal")?.state, "read");
    is("no total for the oldest month; June's total adds Stripe and PayPal in dollars", [month(e, "2030-07")?.totals, month(e, "2031-06")?.totals], [null, [{ currency: "usd", salesCents: 10500, renewalCents: 66100, enteredCents: 0, refundCents: 5000, disputeCents: 0, reinstatedCents: 0, netCents: 71600 }]]);
    is("every Stripe list read in the version its shapes are written for", [...versions], ["2026-08-26.dahlia"]);
    is("nothing ranks the creator by revenue (561 [NE1])", /best|growth|rank|status|level|badge/i.test(JSON.stringify(Object.keys(month(e, "2031-06") ?? {}))), false);

    part("The fourth kept reading: read once, shown again for ten minutes without reading");
    const before = log.filter((l) => l.startsWith("stripe")).length;
    const again = await readEarningsYear(shop, "UTC", NOW + 5 * 60_000);
    is("kept under nl:reading:earnings, and shown again with no Stripe page read", [typeof redis.run(["GET", `nl:reading:earnings:${shop.statsId}`]), log.filter((l) => l.startsWith("stripe")).length - before, again?.at], ["string", 0, NOW]);
    is("READING_KINDS has the fourth kind", [READING_KINDS.length, READING_KINDS.includes("earnings" as never)], [4, true]);
  }

  part("The day's heavy reading is taken before anything is read");
  reset();
  {
    const shop = makeStore();
    stripe["/checkout/sessions"] = [checkout("a0002", Date.UTC(2031, 5, 3), 5000)];
    await paypalSale(shop, "PAYPALORDER0003", Date.UTC(2031, 5, 7), 4000);
    log.length = 0;
    await readEarningsYear(shop, "UTC", NOW);
    const heavy = log.findIndex((l) => l === `redis INCRBY nl:reading:day:${shop.statsId}:2031-06-15:heavy`);
    const firstRead = log.findIndex((l) => l.startsWith("stripe") || l.startsWith("redis ZREVRANGEBYSCORE nl:ppsell") || l.startsWith("redis MGET"));
    is("the heavy count first, then Stripe and PayPal", [heavy >= 0, firstRead > heavy], [true, true]);

    const used = makeStore();
    redis.run(["SET", `nl:reading:day:${used.statsId}:2031-06-15:heavy`, String(HEAVY_READINGS_PER_DAY), "EX", 86_400]);
    log.length = 0;
    const outcome = await readEarningsYear(used, "UTC", NOW).then(() => "read", (error: unknown) => (error instanceof ReadingsUsed ? "used" : String(error)));
    is("the day's heavy readings used, none kept: said as used, and nothing read", [outcome, log.filter((l) => l.startsWith("stripe") || l.includes("nl:ppsell")).length], ["used", 0]);
  }

  part("A busy store: the reading stops at its caps, and months it did not reach say unknown, never less");
  reset();
  {
    const shop = makeStore();
    const rows = (n: number, every: number, make: (i: number, at: number) => Row) => Array.from({ length: n }, (_, i) => make(i, NOW - HOUR - i * every));
    stripe["/checkout/sessions"] = rows(2500, 3 * HOUR, (i, at) => checkout(`busy${i}`, at, 100));
    stripe["/payment_intents"] = rows(2500, 3 * HOUR, (i, at) => extraPaid(`busy${i}`, at, 100));
    stripe["/invoices"] = rows(1200, 6 * HOUR, (i, at) => invoice(`busy${i}`, at, at + HOUR, 100));
    stripe["/refunds"] = rows(600, 10 * HOUR, (i, at) => refund(`busy${i}`, at, 10));
    stripe["/disputes"] = rows(400, 15 * HOUR, (i, at) => dispute(`busy${i}`, at, 10));
    stripe["/invoices"] = rows(900, 6 * HOUR, (i, at) => invoice(`busy${i}`, at, at + HOUR, 100));
    for (let i = 0; i < 2500; i += 1) await paypalSale(shop, `PPBUSY${String(i).padStart(8, "0")}`, NOW - HOUR - i * 3 * HOUR, 100);
    for (let i = 0; i < 600; i += 1) {
      const order = `PPREFD${String(i).padStart(8, "0")}`;
      await pipeline([["SET", `nl:ppsell:paid:${order}`, JSON.stringify({ store: shop.statsId, order, capture: `C${i}`, email: "b@example.com", product: "p1", cents: 100, currency: "usd", at: sec(NOW - 400 * DAY) })]]);
      await paypalRefund(shop, order, NOW - HOUR - i * 10 * HOUR);
    }
    commands = 0;
    replyBytes = 0;
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is("Stripe pages per list never past their caps, and no dispute page", [pagesOf["/checkout/sessions"], pagesOf["/payment_intents"], pagesOf["/invoices"], pagesOf["/refunds"], pagesOf["/disputes"] ?? 0], [20, 20, 9, 5, 0]);
    is("all Stripe pages at most SALES_READ_SHAPE's", Object.values(pagesOf).reduce((a, b) => a + b, 0) <= SALES_READ_SHAPE.stripePages, true);
    const mget = log.filter((l) => l.startsWith("redis MGET")).length;
    is("Redis commands at most SALES_READ_SHAPE's, two ranges and two reads of the records", [commands <= SALES_READ_SHAPE.commands, log.filter((l) => l.startsWith("redis ZREVRANGEBYSCORE")).length, mget], [true, 2, 2]);
    is("bytes read from Redis at most SALES_READ_SHAPE's", replyBytes <= SALES_READ_SHAPE.dbBytes, true);
    // Refunds (500 read, one every 10 hours) reach back to 19 November 2030: December 2030 on is read, November before is not.
    // The 900 invoices end inside their ten pages, so they hold every month from the reading's start (but the oldest).
    is("Stripe: the months every list reached are read, the rest unknown", states(e, "stripe"), [...Array(7).fill("read"), ...Array(5).fill("not_reached")]);
    // PayPal refunds (500 read, one every 10 hours) reach back to 19 November 2030.
    is("PayPal: likewise, by its own lists", states(e, "paypal"), [...Array(7).fill("read"), ...Array(5).fill("not_reached")]);
    const june = (of(e, "2031-06", "stripe") as { lines?: { salesCents: number }[] }).lines?.[0];
    const expected = stripe["/checkout/sessions"].filter((r) => r.created * 1000 >= Date.UTC(2031, 5, 1)).length * 100 * 2;
    is("a month reached is exact: every June checkout and extra counted", june?.salesCents, expected);
  }

  reset();
  {
    const shop = makeStore(false);
    const rows = (n: number, every: number, make: (i: number, at: number) => Row) => Array.from({ length: n }, (_, i) => make(i, NOW - HOUR - i * every));
    stripe["/checkout/sessions"] = rows(5, DAY, (i, at) => checkout(`few${i}`, at, 100));
    stripe["/invoices"] = rows(1200, 6 * HOUR, (i, at) => invoice(`many${i}`, at, at + HOUR, 100));
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is("paid invoices past their ten pages: a list dated by payment knows no month when it stops, so every Stripe month is unknown", [pagesOf["/invoices"], states(e, "stripe")], [10, Array(12).fill("not_reached")]);
  }

  part("A list that cannot be read, or a record that cannot, makes its months unknown, never zero");
  for (const [path, how] of [["/refunds", "garbled"], ["/invoices", "error"], ["/checkout/sessions", "shuffled"]] as const) {
    reset();
    const shop = makeStore();
    stripe["/checkout/sessions"] = [checkout("a0003", Date.UTC(2031, 5, 3), 5000), checkout("b0003", Date.UTC(2031, 4, 3), 5000), checkout("c0003", Date.UTC(2031, 3, 3), 5000)];
    stripe["/refunds"] = [refund("a0003", Date.UTC(2031, 5, 5), 1000)];
    stripe["/disputes"] = [dispute("a0003", Date.UTC(2031, 5, 6), 500)];
    await paypalSale(shop, "PAYPALORDER0004", Date.UTC(2031, 5, 7), 4000);
    broken[path] = how;
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is(`${path} ${how}: every Stripe month unknown, with no amount`, states(e, "stripe"), Array(12).fill("unread"));
    is(`${path} ${how}: PayPal still read, no total for any month`, [states(e, "paypal")[0], (e?.months ?? []).every((m) => m.totals === null)], ["read", true]);
  }

  reset();
  {
    const shop = makeStore();
    stripe["/checkout/sessions"] = [
      checkout("a0004", Date.UTC(2031, 5, 3), 5000),
      checkout("b0004", Date.UTC(2031, 3, 20), 5000, { amount_total: "fifty" }),
      checkout("c0004", Date.UTC(2031, 1, 3), 5000),
    ];
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is("a checkout of the store whose amount cannot be read: months from it back unknown, the newer ones exact", [states(e, "stripe").slice(0, 3), (of(e, "2031-06", "stripe") as { lines?: { salesCents: number }[] }).lines?.[0]?.salesCents], [["read", "read", "not_reached"], 5000]);
    is("and every month before it unknown too", states(e, "stripe").slice(3), Array(9).fill("not_reached"));
  }

  reset();
  {
    const shop = makeStore();
    stripe["/invoices"] = [invoice("late02", Date.UTC(2031, 2, 1), Date.UTC(2031, 3, 15), 2000)];
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is(`a renewal paid more than ${RENEWAL_PAID_WITHIN_DAYS} days after its invoice: the window is not what was assumed, so Stripe is unknown`, states(e, "stripe"), Array(12).fill("unread"));
  }

  reset();
  {
    const shop = makeStore();
    stripe["/invoices"] = [invoice("nopaid", Date.UTC(2031, 5, 1), Date.UTC(2031, 5, 1), 2000, { status_transitions: { paid_at: null } })];
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is("a paid renewal with no time of payment: never dated by its invoice instead, and the list dated by payment knows no month, so every Stripe month is unknown", states(e, "stripe"), Array(12).fill("not_reached"));
  }

  reset();
  {
    const shop = makeStore();
    stripe["/checkout/sessions"] = [checkout("a0009", Date.UTC(2031, 5, 3), 5000)];
    stripe["/invoices"] = [invoice("switch9", Date.UTC(2031, 5, 3), Date.UTC(2031, 5, 3), 2000, { billing_reason: "subscription_update", parent: "in_garbled" })];
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is("a paid invoice whose subscription cannot be read: never skipped as not the store's, never dated by its invoice; every Stripe month unknown", states(e, "stripe"), Array(12).fill("not_reached"));
  }

  reset();
  {
    const shop = makeStore(false);
    // A sale made while the reading ran: Stripe lists it, and it is money so far, since the reading's time is taken
    // once every list was read (docs/bx2-earnings-design.md, "Exact, once, so far").
    clock = NOW;
    tick = 2_000;
    stripe["/checkout/sessions"] = [checkout("during", NOW + 1_000, 5000), checkout("a0010", Date.UTC(2031, 5, 3), 2500)];
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is("a sale made while the reading ran is counted, and the reading's time is after it", [(of(e, "2031-06", "stripe") as { lines?: { salesCents: number }[] })?.lines?.[0]?.salesCents, (e?.at ?? 0) >= NOW + 1_000], [7500, true]);
  }

  reset();
  {
    const shop = makeStore();
    await paypalSale(shop, "PAYPALORDER0005", Date.UTC(2031, 5, 7), 4000);
    await paypalSale(shop, "PAYPALORDER0006", Date.UTC(2031, 3, 7), 4000);
    await pipeline([["SET", "nl:ppsell:paid:PAYPALORDER0006", "{not json"]]);
    await paypalSale(shop, "PAYPALORDER0007", Date.UTC(2031, 1, 7), 4000);
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is("a PayPal sale whose record cannot be read: from it back unknown, the newer months exact", [states(e, "paypal").slice(0, 3), (of(e, "2031-06", "paypal") as { lines?: { salesCents: number }[] }).lines?.[0]?.salesCents], [["read", "read", "not_reached"], 4000]);
  }

  reset();
  {
    const shop = makeStore();
    await paypalSale(shop, "PAYPALORDER0008", Date.UTC(2031, 5, 7), 4000);
    garbleZrange = true;
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is("PayPal's list answered in another shape: every PayPal month unknown", states(e, "paypal"), Array(12).fill("unread"));
  }

  reset();
  {
    const shop = makeStore(false);
    const e = (await readEarningsYear(shop, "UTC", NOW))?.value ?? null;
    is("a store that never sold through PayPal and has no PayPal sale kept: no PayPal source", states(e, "paypal"), Array(12).fill("absent"));
  }

  part("The months in the store's time zone");
  reset();
  {
    const shop = makeStore();
    // 1 June 2031, 02:00 UTC is still 31 May in Fortaleza (UTC-3).
    stripe["/checkout/sessions"] = [checkout("a0005", Date.UTC(2031, 5, 1, 2), 5000)];
    const e = (await readEarningsYear(shop, "America/Fortaleza", NOW))?.value ?? null;
    is("a sale counted in the month of the store's own calendar", [(of(e, "2031-05", "stripe") as { lines?: { salesCents: number }[] }).lines?.[0]?.salesCents, (of(e, "2031-06", "stripe") as { lines?: unknown[] }).lines?.length], [5000, 0]);
    is("the months are those of the zone", e?.months.map((m) => m.month), months);
  }

  part("The fourth kept copy is priced in the store-readings line");
  {
    const line = COST_LINES.find((l) => l.id === "store-readings");
    const copy = READING_COPY_MAX_BYTES * DB_BYTE_MONTH * (READING_KEEP_SECONDS / (30 * 86_400));
    is("one kept copy a store is about US$0.0000011 a month", copy > 0.000001 && copy < 0.0000012, true);
    is("the line prices READING_KINDS.length copies, now four", [READING_KINDS.length, line?.sources.some((s) => s.file === "lib/store-readings.ts" && s.names.includes("READING_KINDS"))], [4, true]);
    const source = line?.sources.find((s) => s.file === "lib/earnings-read.ts");
    is("and names the reading that keeps it, a heavy reading of the day", [source?.names.includes("readEarningsYear"), source?.names.includes('keptReading(store, "earnings"')], [true, true]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
