/**
 * 426 [BX2] unit 4: the twelve months of earnings as a CSV file
 * (lib/earnings-csv.ts, app/api/store/earnings/route.ts; docs/bx2-earnings-design.md,
 * "Units", 5).
 *
 * The file is made from the copy the earnings page last read and kept
 * (lib/store-readings.ts, keptCopy): it never reads Stripe or PayPal and never
 * takes one of the day's readings. The rule, the reading, the kept copy, the
 * route and the page are real, against a stand-in Stripe (fetch) and the
 * in-memory Redis; only who is signed in, the studio's count of requests and
 * the Next request context are stand-ins (tests/bx2-u4-csv-world.tsx).
 *
 * What fails here:
 *   - an amount that could not be read written as 0 or as any number;
 *   - amounts in two currencies added together, or an amount not exact to the
 *     smallest unit (cents, yen, the three-decimal dinar);
 *   - a cell a spreadsheet would run as a formula, or one not quoted;
 *   - a buyer's name, address or a Stripe or PayPal record id in the file;
 *   - "Entered by you" in the file before it exists (VR);
 *   - PayPal rows without saying PayPal disputes are not in them;
 *   - a copy that is not exactly what the rule makes (a tampered sum, a
 *     currency twice, a month out of place) turned into a file;
 *   - the download reading Stripe, taking a reading, costing less than a
 *     studio page, or asking for more than the "stats" permission;
 *   - a file larger than the page that shows the same months;
 *   - the page without the download, or with it when there is nothing to download;
 *   - the page offering the download when the reading was too large to keep a
 *     copy of (READING_COPY_MAX_BYTES), so the file could never be made;
 *   - a refusal answered as bare text on a whole-page navigation, instead of
 *     back on the earnings page (or the studio's paused page) with the reason;
 *   - a month cell a spreadsheet turns into a date ("2026-11"), and no word on
 *     what to do when a spreadsheet puts the file in one column.
 */
process.env.STRIPE_SECRET_KEY = "sk_test_earnings_file_stand_in";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import EarningsPage from "../app/studio/earnings/page";
import { GET } from "../app/api/store/earnings/route";
import { EARNINGS_CSV_HEADER, earningsCsv, earningsCsvMonth, earningsFileName, earningsFromCopy } from "@/lib/earnings-csv";
import { type Earnings, type ListReading, type MoneyEvent, type MoneyKind, type ProviderReading, earningsByMonth, readingSince } from "@/lib/earnings-by-month";
import { readEarningsYear } from "@/lib/earnings-read";
import { parseCsv } from "@/lib/csv";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { READING_COPY_MAX_BYTES, keptCopy, readingsLeft } from "@/lib/store-readings";
import type { Store } from "@/lib/store";
import { who } from "./bx2-u4-csv-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.UTC(2031, 5, 15, 12, 0); // 15 June 2031, 12:00 UTC
let clock = NOW;
Date.now = () => clock;
const sec = (ms: number) => Math.floor(ms / 1000);

// ---------------------------------------------------------------------------
// The pure file, from the rule's own output
// ---------------------------------------------------------------------------

const SINCE = readingSince(NOW, "UTC");
const ev = (id: string, at: number, cents: number, currency = "usd"): MoneyEvent => ({ id, at, cents, currency });
const list = (kind: MoneyKind, events: MoneyEvent[]): ListReading => ({ kind, events, since: SINCE, complete: true, reachedBack: null });
const stripeOf = (by: Partial<Record<MoneyKind, MoneyEvent[]>>): ProviderReading => ({
  source: "stripe",
  lists: (["sale", "renewal", "refund", "dispute"] as const).map((kind) => list(kind, by[kind] ?? [])),
});
const payPalOf = (sales: MoneyEvent[]): ProviderReading => ({ source: "paypal", lists: [list("sale", sales), list("refund", [])], notRead: ["dispute"] });
const unreadStripe: ProviderReading = { source: "stripe", lists: [{ kind: "sale", unread: true }] };
const make = (providers: ProviderReading[]): Earnings => earningsByMonth({ at: NOW, timeZone: "UTC", providers, manual: [] }) as Earnings;

const COLUMNS = ["month", "so_far", "source", "state", "currency", "sales", "renewals", "refunds", "disputes", "left_after_refunds_and_disputes", "not_included", "time_zone", "read_at_utc"];
type Row = Record<string, string>;
function rowsOf(csv: string): { header: string[]; rows: Row[] } {
  const parsed = parseCsv(csv);
  return { header: parsed.header, rows: parsed.rows.map((cells) => Object.fromEntries(parsed.header.map((name, i) => [name, cells[i] ?? ""]))) };
}
/** A month's cell as the file writes it, from the rule's "2031-06". */
const M = (month: string) => earningsCsvMonth(month, "UTC");
const pick = (rows: Row[], month: string, source: string) => rows.filter((r) => r.month === M(month) && r.source === source);
const AMOUNTS = ["sales", "renewals", "refunds", "disputes", "left_after_refunds_and_disputes"];
const NUMBER = /^-?\d+(\.\d+)?$/;

function pure(): void {
  part("Two sources and three currencies: a row for each source and currency, never added across currencies");
  const both = make([
    stripeOf({
      sale: [ev("cs_secret_a", Date.UTC(2031, 5, 3), 7000), ev("cs_secret_b", Date.UTC(2031, 5, 4), 3000, "eur"), ev("pi_secret_c", Date.UTC(2031, 3, 9), 2700, "jpy"), ev("pi_secret_d", Date.UTC(2031, 3, 9), 1234, "kwd")],
      refund: [ev("re_secret_a", Date.UTC(2031, 5, 5), 500)],
      dispute: [ev("dp_secret_a", Date.UTC(2031, 5, 6), 9000)],
    }),
    payPalOf([ev("PAYPALORDER01", Date.UTC(2031, 5, 7), 4000)]),
  ]);
  const csv = earningsCsv(both);
  const { header, rows } = rowsOf(csv);
  is("the columns, in order, in plain names", header, COLUMNS);
  is("the header is EARNINGS_CSV_HEADER", EARNINGS_CSV_HEADER, COLUMNS);
  is("every line ends with CRLF, and the file with one", [csv.endsWith("\r\n"), csv.split("\r\n").every((line, i, all) => i === all.length - 1 || !line.includes("\n"))], [true, true]);
  is("twelve months, newest first, the current one marked so far", [rows[0].month, rows[0].so_far, rows[rows.length - 1].month, [...new Set(rows.map((r) => r.month))].length], ["June 2031 (UTC)", "yes", "July 2030 (UTC)", 12]);
  is("no month cell a spreadsheet reads as a date: the month in words with its time zone, never 2031-06", rows.every((r) => /^[A-Z][a-z]+ \d{4} \(UTC\)$/.test(r.month)) && !/"\d{4}-\d{2}"/.test(csv), true);
  is("only the current month is so far", rows.filter((r) => r.so_far === "yes").every((r) => r.month === M("2031-06")) && rows.filter((r) => r.month !== M("2031-06")).every((r) => r.so_far === "no"), true);
  const juneStripe = pick(rows, "2031-06", "Stripe");
  is("June, Stripe: euros and dollars on their own rows, alphabetical", juneStripe.map((r) => r.currency), ["EUR", "USD"]);
  is("June, Stripe dollars: sales 70.00, refunds 5.00, disputes 90.00, left -25.00", [juneStripe[1].sales, juneStripe[1].renewals, juneStripe[1].refunds, juneStripe[1].disputes, juneStripe[1].left_after_refunds_and_disputes], ["70.00", "0.00", "5.00", "90.00", "-25.00"]);
  is("June, Stripe euros: 30.00 on their own, never added to dollars", [juneStripe[0].sales, juneStripe[0].left_after_refunds_and_disputes], ["30.00", "30.00"]);
  is("June, all sources in dollars: Stripe -25.00 plus PayPal 40.00 is 15.00; euros alone 30.00", pick(rows, "2031-06", "All sources").map((r) => [r.currency, r.left_after_refunds_and_disputes]), [["EUR", "30.00"], ["USD", "15.00"]]);
  is("no row adds dollars and euros (70 + 30 is never 100)", rows.some((r) => AMOUNTS.some((a) => r[a] === "100.00")), false);
  const april = pick(rows, "2031-04", "Stripe");
  is("yen have no decimals and the Kuwaiti dinar three", april.map((r) => [r.currency, r.sales]), [["JPY", "2700"], ["KWD", "1.234"]]);
  is("each PayPal row says its disputes are not in it", pick(rows, "2031-06", "PayPal").map((r) => [r.state, r.currency, r.sales, r.not_included]), [["Read", "USD", "40.00", "PayPal disputes"]]);
  is("a month's all-sources rows say PayPal disputes are not in them", pick(rows, "2031-06", "All sources").every((r) => r.not_included === "PayPal disputes"), true);
  is("Stripe rows leave nothing out", juneStripe.every((r) => r.not_included === ""), true);
  const may = rows.filter((r) => r.month === M("2031-05"));
  is("a month read in full with nothing in it: Nothing recorded, with no currency and no amount", may.map((r) => [r.source, r.state, r.currency, ...AMOUNTS.map((a) => r[a])]), [
    ["Stripe", "Nothing recorded", "", "", "", "", "", ""],
    ["PayPal", "Nothing recorded", "", "", "", "", "", ""],
    ["All sources", "Nothing recorded", "", "", "", "", "", ""],
  ]);
  is("each row says the time zone and when the months were read", rows.every((r) => r.time_zone === "UTC" && r.read_at_utc === "2031-06-15T12:00:00.000Z"), true);
  is("nothing typed by the creator: Entered by you does not exist yet", /entered by you|manual/i.test(csv), false);
  is("no buyer, address or record id in the file", [csv.includes("@"), /secret|PAYPALORDER|cs_|re_|pi_|dp_/.test(csv)], [false, false]);
  is("no best month, growth, projection, rank or status (561 [NE1])", /best|worst|growth|projection|forecast|rank|status|badge|level/i.test(csv), false);

  part("Every cell is quoted text or an exact number: nothing a spreadsheet would run");
  const cells = csv.trimEnd().split("\r\n").flatMap((line) => line.split(","));
  is("each cell is quoted or a plain number", cells.filter((c) => !/^"[^"]*"$/.test(c) && !NUMBER.test(c)), []);
  is("no quoted cell starts with = + - @ or a tab", cells.filter((c) => /^"[=+\-@\t\r]/.test(c)), []);
  is("amounts are numbers, never quoted text", rows.flatMap((r) => AMOUNTS.map((a) => r[a])).filter((v) => v !== "").every((v) => NUMBER.test(v)), true);

  part("A source that could not be read: words, never 0 and never a lower number");
  const half = make([unreadStripe, payPalOf([ev("PAYPALORDER02", Date.UTC(2031, 5, 7), 4000)])]);
  const halfRows = rowsOf(earningsCsv(half)).rows;
  const stripeRows = halfRows.filter((r) => r.source === "Stripe");
  is("twelve Stripe rows say Could not be read, with no currency and no amount", [stripeRows.length, stripeRows.every((r) => r.state === "Could not be read" && r.currency === "" && AMOUNTS.every((a) => r[a] === ""))], [12, true]);
  is("PayPal still on its own row", pick(halfRows, "2031-06", "PayPal").map((r) => r.sales), ["40.00"]);
  is("no total for a month with a source not read", pick(halfRows, "2031-06", "All sources").map((r) => [r.state, r.currency, ...AMOUNTS.map((a) => r[a])]), [["No total: a source could not be read", "", "", "", "", "", ""]]);
  is("no zero anywhere in a month that could not be read in full", halfRows.filter((r) => r.state !== "Read").some((r) => AMOUNTS.some((a) => r[a] !== "")), false);

  part("One source only: no all-sources rows, as on the page");
  const only = rowsOf(earningsCsv(make([stripeOf({ sale: [ev("cs_only", Date.UTC(2031, 5, 3), 1200)] })]))).rows;
  is("Stripe rows only", [...new Set(only.map((r) => r.source))], ["Stripe"]);

  part("Exact to the smallest unit, at the largest exact amount");
  const big = make([stripeOf({ sale: [ev("cs_big", Date.UTC(2031, 5, 3), Number.MAX_SAFE_INTEGER)] })]);
  is("9,007,199,254,740,991 cents is 90071992547409.91, not rounded", pick(rowsOf(earningsCsv(big)).rows, "2031-06", "Stripe")[0].sales, "90071992547409.91");
  const small = make([stripeOf({ sale: [ev("cs_cent", Date.UTC(2031, 5, 3), 7)], refund: [ev("re_cent", Date.UTC(2031, 5, 4), 9)] })]);
  is("7 cents in, 9 out: 0.07, 0.09 and -0.02", (() => {
    const r = pick(rowsOf(earningsCsv(small)).rows, "2031-06", "Stripe")[0];
    return [r.sales, r.refunds, r.left_after_refunds_and_disputes];
  })(), ["0.07", "0.09", "-0.02"]);

  part("The kept copy is read only in the exact shape the rule makes");
  const copy = (e: Earnings) => JSON.parse(JSON.stringify(e)) as Earnings;
  is("the rule's output, kept and read back, is the same", earningsFromCopy(copy(both)), both);
  is("one source unread, kept and read back, is the same", earningsFromCopy(copy(half)), half);
  const tampered: [string, (e: Earnings) => unknown][] = [
    ["a sum that does not add up", (e) => (((e.months[0].sources[0] as { lines: { netCents: number }[] }).lines[0].netCents += 1), e)],
    ["an amount that is not a whole number", (e) => (((e.months[0].sources[0] as { lines: { salesCents: number }[] }).lines[0].salesCents = 0.5), e)],
    ["an amount written as text", (e) => (((e.months[0].sources[0] as { lines: { salesCents: unknown }[] }).lines[0].salesCents = "7000"), e)],
    ["a negative refund", (e) => (((e.months[0].sources[0] as { lines: { refundCents: number; netCents: number }[] }).lines[0].refundCents = -1), e)],
    ["a currency in capitals", (e) => (((e.months[0].sources[0] as { lines: { currency: string }[] }).lines[0].currency = "EUR"), e)],
    ["the same currency twice in a source", (e) => {
      const lines = (e.months[0].sources[0] as { lines: unknown[] }).lines;
      lines.push(lines[0]);
      return e;
    }],
    ["a source not known", (e) => (((e.months[0].sources[0] as { source: string }).source = "bank"), e)],
    ["a state not known", (e) => (((e.months[0].sources[0] as { state: string }).state = "estimated"), e)],
    ["an unknown source with no reason", (e) => ((e.months[0].sources[0] = { source: "stripe", state: "unknown" } as unknown as Earnings["months"][number]["sources"][number]), e)],
    ["eleven months", (e) => (e.months.pop(), e)],
    ["a month out of place", (e) => ((e.months[3].month = "2029-01"), e)],
    ["two current months", (e) => ((e.months[1].current = true), e)],
    ["a time zone that is not one", (e) => ((e.timeZone = "=HYPERLINK(1)"), e)],
    ["a reading time that is not a time", (e) => (((e as { at: unknown }).at = "today"), e)],
    ["totals that are not the sources together", (e) => ((e.months[0].totals![0].salesCents += 100, e.months[0].totals![0].netCents += 100), e)],
    ["totals where a source could not be read", () => {
      const e = copy(half);
      e.months[0].totals = [];
      return e;
    }],
    ["a list instead of the months", () => []],
    ["nothing", () => null],
  ];
  for (const [what, change] of tampered) is(`refused: ${what}`, earningsFromCopy(change(copy(both))), null);

  part("The file's name");
  is("the store's handle, earnings and the day it was read", earningsFileName("shop", both), "shop-earnings-2031-06-15.csv");
}

// ---------------------------------------------------------------------------
// The route and the page, with the real reading and the kept copy
// ---------------------------------------------------------------------------

type StripeRow = Record<string, unknown> & { id: string; created: number };
type ListPath = "/checkout/sessions" | "/payment_intents" | "/invoices" | "/refunds" | "/disputes";
let stripe: Record<ListPath, StripeRow[]>;
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "") as ListPath;
  stripeCalls += 1;
  const gte = Number(url.searchParams.get("created[gte]") ?? 0);
  const after = url.searchParams.get("starting_after");
  const limit = Number(url.searchParams.get("limit") ?? 10);
  const rows = (stripe[path] ?? []).filter((r) => r.created >= gte).sort((a, b) => b.created - a.created);
  const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
  return new Response(JSON.stringify({ object: "list", data: rows.slice(start, start + limit), has_more: start + limit < rows.length }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const checkout = (id: string, at: number, cents: number, currency = "usd"): StripeRow => ({
  id: `cs_${id}`, object: "checkout.session", created: sec(at), status: "complete", payment_status: "paid", amount_total: cents, currency, metadata: { store: "shop", product: "p1" },
  customer_details: { email: "buyer@example.com", name: "A Buyer" },
});

let count = 0;
function makeStore(stripeAccount: boolean): Store {
  count += 1;
  return {
    sid: `cv${count}`,
    statsId: String(count).padStart(32, "f"),
    handle: "shop",
    previousHandles: [],
    releasedHandles: [],
    stripeAccountId: stripeAccount ? "acct_1EarningsFileStandIn" : null,
    paypalSeller: null,
    currency: "usd",
  } as unknown as Store;
}

function reset(): void {
  redis.clear();
  stripe = { "/checkout/sessions": [], "/payment_intents": [], "/invoices": [], "/refunds": [], "/disputes": [] };
  stripeCalls = 0;
  clock = NOW;
  who.allowed = true;
  who.needs = [];
  who.units = [];
  who.used = false;
}

const request = (sid: string) => new Request(`https://marktmorgen.test/api/store/earnings?store=${sid}`) as unknown as NextRequest;
async function download(shop: Store): Promise<Response> {
  who.store = shop;
  return GET(request(shop.sid));
}
async function draw(shop: Store): Promise<string> {
  who.store = shop;
  return renderToStaticMarkup(await EarningsPage({ searchParams: Promise.resolve({ store: shop.sid }) }));
}
const noAmount = (text: string) => !/\d+\.\d{2}/.test(text);

async function route(): Promise<void> {
  part("The page read the months: the file is that copy, without reading again");
  reset();
  {
    const shop = makeStore(true);
    stripe["/checkout/sessions"] = [checkout("a0001", Date.UTC(2031, 5, 3), 7000), checkout("b0001", Date.UTC(2031, 5, 4), 3000, "eur")];
    const html = await draw(shop);
    is("the page offers the download as a plain GET form for this store", [html.includes('action="/api/store/earnings"'), /method="get"/.test(html), html.includes(`name="store" value="${shop.sid}"`)], [true, true, true]);
    is("its button says what it gives, in plain words", /<button[^>]*type="submit"[^>]*>Download these 12 months \(CSV\)<\/button>/.test(html), true);
    is("and says the file has no buyer's name or email and reads nothing again", [/no buyer('|&#x27;)s name or email/i.test(html), /does not read Stripe or PayPal again/i.test(html)], [true, true]);
    is("and what to do when a spreadsheet puts each row in one column: choose comma", /one column[^<]*comma/i.test(html), true);
    const kept = await keptCopy(shop, "earnings");
    const calls = stripeCalls;
    const before = await readingsLeft(shop, clock);
    who.needs = [];
    who.units = [];
    const res = await download(shop);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Read as the file's bytes: Response.text() would drop the byte-order mark it checks.
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    is("answered with a file", [res.status, res.headers.get("content-type")], [200, "text/csv; charset=utf-8"]);
    is("named for the store and the day it was read, as an attachment", res.headers.get("content-disposition"), 'attachment; filename="shop-earnings-2031-06-15.csv"');
    is("never cached, never indexed, never sniffed", [res.headers.get("cache-control"), res.headers.get("x-robots-tag"), res.headers.get("x-content-type-options")], ["private, no-store", "noindex", "nosniff"]);
    is("starts with the byte-order mark Excel needs for UTF-8", [...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    is("the file is exactly the kept copy written out", body.slice(1), kept && typeof kept === "object" ? earningsCsv(earningsFromCopy(kept.value) as Earnings) : "no copy");
    is("no Stripe page read and no reading taken", [stripeCalls - calls, (await readingsLeft(shop, clock)).heavyLeft], [0, before.heavyLeft]);
    is("asks only for the permission to see the numbers", who.needs, ["stats"]);
    is("costs what a studio page costs: one request taken on the way in, the rest here", [1 + who.units.reduce((a, b) => a + b, 0), who.units], [STUDIO_PAGE_UNITS, [STUDIO_PAGE_UNITS - 1]]);
    is("no buyer's email or name in the file", [body.includes("buyer@example.com"), body.includes("A Buyer")], [false, false]);
    is("the file is no larger than the page that shows the same months", Buffer.byteLength(body, "utf8") <= Buffer.byteLength(html, "utf8"), true);

    part("Later the same day, with the copy no longer fresh: still the copy, still no reading");
    clock = NOW + 3 * 3600_000;
    const later = await download(shop);
    is("the same file, the same name (the day it was read), nothing read", [later.status, new TextDecoder("utf-8", { ignoreBOM: true }).decode(await later.arrayBuffer()) === body, later.headers.get("content-disposition"), stripeCalls - calls], [200, true, 'attachment; filename="shop-earnings-2031-06-15.csv"', 0]);
  }

  part("Nothing kept: said, with nothing read and no reading taken");
  reset();
  {
    const shop = makeStore(true);
    const res = await download(shop);
    is("back to the earnings page with its own notice, never a bare text page", [res.status, res.headers.get("location"), res.headers.get("cache-control")], [303, `/studio/earnings?store=${shop.sid}&file=none`, "no-store"]);
    is("no Stripe page read, no reading taken", [stripeCalls, (await readingsLeft(shop, NOW)).heavyLeft], [0, 2]);
    who.store = shop;
    const told = renderToStaticMarkup(await EarningsPage({ searchParams: Promise.resolve({ store: shop.sid, file: "none" }) }));
    is("the page says no file was made and why, as an alert", [/role="alert"[^>]*>[^<]*No file was made/.test(told), /none of your earnings were kept/i.test(told)], [true, true]);
    const plain = await draw(shop);
    is("without the notice's key, no notice", /No file was made/.test(plain), false);
  }

  part("A kept copy that is not what the rule makes: no file, never a guess");
  reset();
  {
    const shop = makeStore(true);
    stripe["/checkout/sessions"] = [checkout("a0002", Date.UTC(2031, 5, 3), 7000)];
    await readEarningsYear(shop, "UTC", NOW);
    const key = `nl:reading:earnings:${shop.statsId}`;
    const [raw] = (await redis.pipeline([["GET", key]])) as [string];
    const copy = JSON.parse(raw) as { at: number; value: Earnings };
    (copy.value.months[0].sources[0] as { lines: { netCents: number }[] }).lines[0].netCents = 999_999;
    await redis.pipeline([["SET", key, JSON.stringify(copy)]]);
    const tampered = await download(shop);
    const unread = `/studio/earnings?store=${shop.sid}&file=unread`;
    is("back to the earnings page, said as could not be read", [tampered.status, tampered.headers.get("location"), noAmount(await tampered.text())], [303, unread, true]);
    await redis.pipeline([["SET", key, "{not json"]]);
    const broken = await download(shop);
    is("a copy that is not JSON: the same", [broken.status, broken.headers.get("location")], [303, unread]);
    await redis.pipeline([["SET", key, JSON.stringify({ at: NOW + 1, value: JSON.parse(raw).value })]]);
    const moved = await download(shop);
    is("a copy whose time is not its months' time: the same", [moved.status, moved.headers.get("location")], [303, unread]);
    who.store = shop;
    const told = renderToStaticMarkup(await EarningsPage({ searchParams: Promise.resolve({ store: shop.sid, file: "unread" }) }));
    is("the page says the file could not be made, as an alert", /role="alert"[^>]*>[^<]*No file was made: your earnings could not be read/.test(told), true);
    is("none of the downloads read Stripe again", stripeCalls, 5);
  }

  part("The studio figure used: no file");
  reset();
  {
    const shop = makeStore(true);
    await draw(shop);
    who.used = true;
    const res = await download(shop);
    is("to the studio's own page for a used figure, as every studio page goes", [res.status, res.headers.get("location")], [303, `/studio/paused?store=${shop.sid}&why=used`]);
  }

  part("A role that may not see the numbers: refused before anything is read");
  reset();
  {
    const shop = makeStore(true);
    await draw(shop);
    who.allowed = false;
    const res = await download(shop);
    is("the refusal of the studio's guard, no file", [res.status, res.headers.get("content-type")?.includes("text/csv") ?? false], [403, false]);
  }

  part("A store that sells through neither: the page offers no download");
  reset();
  {
    const shop = makeStore(false);
    const html = await draw(shop);
    is("no download form", html.includes('action="/api/store/earnings"'), false);
  }

  part("Many currencies at once: the file stays smaller than the page and the kept copy's ceiling");
  reset();
  {
    const shop = makeStore(true);
    const codes = ["usd", "eur", "gbp", "cad", "aud", "jpy", "chf", "sek", "nok", "dkk", "pln", "czk", "huf", "brl", "mxn", "sgd", "hkd", "nzd", "kwd", "bhd"];
    stripe["/checkout/sessions"] = Array.from({ length: 12 }, (_, m) => codes.map((c, i) => checkout(`m${m}c${i}`, Date.UTC(2030, 6 + m, 2), 1000 + i, c))).flat();
    const html = await draw(shop);
    const res = await download(shop);
    const body = await res.text();
    const manyRows = rowsOf(body).rows.filter((r) => r.source === "Stripe");
    is("a file", res.status, 200);
    // The oldest month's renewals are not proved (lib/earnings-read.ts, RENEWAL_PAID_WITHIN_DAYS), so it is words, never an amount.
    is("eleven months of twenty currencies each, one row each, and the oldest month Could not be read", [manyRows.filter((r) => r.state === "Read").length, manyRows.filter((r) => r.month === M("2030-07")).map((r) => r.state)], [11 * 20, ["Could not be read"]]);
    is("no larger than the page", Buffer.byteLength(body, "utf8") <= Buffer.byteLength(html, "utf8"), true);
    is("no larger than twice the largest copy kept", Buffer.byteLength(body, "utf8") <= 2 * READING_COPY_MAX_BYTES, true);
  }

  part("A reading too large to keep a copy of: no download offered, and why");
  reset();
  {
    const shop = makeStore(true);
    const codes = ["usd", "eur", "gbp", "cad", "aud", "jpy", "chf", "sek", "nok", "dkk", "pln", "czk", "huf", "brl", "mxn", "sgd", "hkd", "nzd", "kwd", "bhd", "ron", "bgn", "isk", "try", "zar", "inr", "idr", "myr", "php", "thb", "krw", "twd", "ils", "aed", "sar", "qar", "omr", "jod", "egp", "mad", "ngn", "kes", "ghs", "cop", "clp", "pen", "ars", "uyu", "pyg", "bob", "vnd", "pkr", "bdt", "lkr", "npr", "uah", "kzt", "gel", "amd", "azn"];
    stripe["/checkout/sessions"] = Array.from({ length: 12 }, (_, m) => codes.map((c, i) => checkout(`t${m}c${i}`, Date.UTC(2030, 6 + m, 2), 1000 + i, c))).flat();
    const kept = await readEarningsYear(shop, "UTC", NOW);
    is("the reading is larger than the copy's ceiling, so none is kept, and it says so", [Buffer.byteLength(JSON.stringify({ at: NOW, value: kept?.value }), "utf8") > READING_COPY_MAX_BYTES, await keptCopy(shop, "earnings"), kept?.unkept], [true, undefined, true]);
    const html = await draw(shop);
    is("the months are shown", html.includes("Kuwaiti dinars"), true);
    is("no download form, never a button that can only fail", html.includes('action="/api/store/earnings"'), false);
    is("a sentence says why: too large to keep a copy of, with many currencies", /too large to keep a copy of[^<]*many currencies/i.test(html), true);
  }

  part("The route's guard takes one studio request, as the world above says");
  const guard = readFileSync(join(process.cwd(), "lib/studio-route.ts"), "utf8");
  is("studioAccess counts one unit (countStudio's default)", [guard.includes("const counted = await countStudio(access.store, need);"), /export async function countStudio\(store: Store, need: Need \| null, units = 1\)/.test(guard)], [true, true]);
}

async function main(): Promise<void> {
  pure();
  await route();
  done();
}

void main();
