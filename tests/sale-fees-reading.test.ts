/**
 * Reading fees and net from the creator's own Stripe account (282 [HG1],
 * unit 3; lib/sale-fees-reading.ts), against the in-memory Redis and a
 * synthetic Stripe. Checked:
 *
 *   - nothing is asked without a connected account or selling configured;
 *   - the day's reading is taken BEFORE Stripe is called; past the day's
 *     figure Stripe is never called, the last copy is shown as such, and
 *     with none the page says the readings are used, never zero;
 *   - one reading asks for the year's balance transactions with their
 *     sources, at most SALE_FEES_PAGES pages; when the pages run out the
 *     reading says how far back it reached, never further;
 *   - a page in any other shape, or a Stripe error, fails the reading: it
 *     stays counted, and the last copy is shown as failed, or nothing;
 *   - the copy keeps only the money fields of each line: never a buyer's
 *     name, address or card;
 *   - a fresh copy is shown without asking again.
 */
import { readingSince } from "@/lib/earnings-by-month";
import { saleFees } from "@/lib/sale-fees-rules";
import {
  SALE_FEES_FRESH_SECONDS,
  SALE_FEES_PAGES,
  SALE_FEES_READINGS_PER_DAY,
  keptSaleFees,
} from "@/lib/sale-fees-reading";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
const STORE = { statsId: "stats1", stripeAccountId: "acct_fixture1" };
const NOW = Date.UTC(2026, 10, 11, 15);
const HOUR = 3_600_000;

type Asked = { url: string; account: string | null; method: string };
let asked: Asked[] = [];
let pages: Array<() => { status: number; body: unknown }> = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  asked.push({ url: String(input), account: headers.get("Stripe-Account"), method: init?.method ?? "GET" });
  const next = pages.shift();
  if (!next) throw new Error("no page left in the synthetic Stripe");
  const { status, body } = next();
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

let n = 0;
function line(type: string, amount: number, created: number, source: unknown, fee = 0, category = type === "charge" ? "charge" : type) {
  n += 1;
  return {
    id: `txn_${n}`, object: "balance_transaction", amount, currency: "usd", fee,
    fee_details: fee ? [{ amount: fee, currency: "usd", type: "stripe_fee", description: "Stripe processing fees", application: null }] : [],
    net: amount - fee, type, reporting_category: category, created, status: "available", description: "Payment", exchange_rate: null,
    source,
  };
}
const charge = (id: string) => ({
  id, object: "charge", amount: 5000, billing_details: { email: "buyer@example.test", name: "Pat Buyer", address: { line1: "1 Main St" } },
  payment_method_details: { card: { last4: "4242" } }, receipt_email: "buyer@example.test",
});
const page = (data: unknown[], has_more: boolean) => () => ({ status: 200, body: { object: "list", data, has_more, url: "/v1/balance_transactions" } });

function reset(): void {
  redis.clear();
  asked = [];
  pages = [];
}

async function main(): Promise<void> {
  const created = Math.floor(NOW / 1000) - 86_400;
  const sale = line("charge", 5000, created, charge("ch_1"), 175);
  const refund = line("refund", -1000, created + 60, { id: "re_1", object: "refund", charge: "ch_1", metadata: { note: "buyer@example.test" } });

  part("Nothing asked without an account");
  reset();
  is("no connected account", await keptSaleFees({ statsId: "stats1", stripeAccountId: undefined }, NOW), { kind: "none" });
  is("no store id", await keptSaleFees({ statsId: undefined, stripeAccountId: "acct_fixture1" }, NOW), { kind: "none" });
  const key = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  is("selling not configured", await keptSaleFees(STORE, NOW), { kind: "not_configured" });
  process.env.STRIPE_SECRET_KEY = key;
  is("and nothing was asked of Stripe or counted", [asked.length, redis.keys()], [0, []]);

  part("One reading");
  reset();
  pages = [page([refund, sale], false)];
  const first = await keptSaleFees(STORE, NOW);
  is("read", first.kind, "read");
  const url = new URL(asked[0]?.url ?? "http://x");
  is("on the creator's own account", asked[0]?.account, "acct_fixture1");
  is("a GET of the balance transactions", [asked[0]?.method, url.pathname], ["GET", "/v1/balance_transactions"]);
  is("a hundred a page, with their sources, since the year's first month", [url.searchParams.get("limit"), url.searchParams.get("expand[]"), url.searchParams.get("created[gte]")], ["100", "data.source", String(Math.floor(readingSince(NOW, "UTC") / 1000))]);
  if (first.kind === "read") {
    is("reached as far as it asked", first.kept.since, readingSince(NOW, "UTC"));
    is("when it was read, not stale", [first.kept.at, first.kept.stale], [NOW, false]);
    const report = saleFees(first.kept.lines, { complete: true });
    is("the rule reads every kept line: one sale, its refund", report.available ? report.rows.map((r) => [r.sale, r.gross, r.refunds, r.net]) : report.why, [["ch_1", 5000, -1000, 3825]]);
  }
  is("the day's reading was taken", (await redis.pipeline([["GET", "nl:salefees:day:stats1:2026-11-11"]]))[0], "1");
  const copy = String((await redis.pipeline([["GET", "nl:salefees:copy:stats1"]]))[0]);
  is("the copy keeps no buyer's name, address or card", /example\.test|Pat Buyer|Main St|4242|billing_details|metadata/.test(copy), false);
  is("the copy keeps the money fields", /"fee_details"/.test(copy) && /"charge":"ch_1"/.test(copy), true);

  part("A fresh copy is shown without asking again");
  const again = await keptSaleFees(STORE, NOW + HOUR / 2);
  is("from the copy", [again.kind, asked.length], ["read", 1]);
  is("read again on purpose only when asked and the day allows", SALE_FEES_FRESH_SECONDS, 3_600);

  part("The day's figure, before Stripe is called");
  reset();
  for (let i = 0; i < SALE_FEES_READINGS_PER_DAY; i += 1) pages.push(page([sale], false));
  for (let i = 0; i < SALE_FEES_READINGS_PER_DAY; i += 1) await keptSaleFees(STORE, NOW + i * 2 * HOUR);
  is(`${SALE_FEES_READINGS_PER_DAY} readings a day`, asked.length, SALE_FEES_READINGS_PER_DAY);
  const past = await keptSaleFees(STORE, NOW + 10 * HOUR);
  is("past it, Stripe is not called", asked.length, SALE_FEES_READINGS_PER_DAY);
  is("and the last copy is shown as stale", past.kind === "read" ? [past.kept.stale, past.kept.at] : past.kind, [true, NOW + (SALE_FEES_READINGS_PER_DAY - 1) * 2 * HOUR]);
  is("the count is given back past the figure", (await redis.pipeline([["GET", "nl:salefees:day:stats1:2026-11-11"]]))[0], String(SALE_FEES_READINGS_PER_DAY));
  await redis.pipeline([["DEL", "nl:salefees:copy:stats1"]]);
  is("with no copy: used, with when they come back", await keptSaleFees(STORE, NOW + 11 * HOUR), { kind: "used", backAt: Date.UTC(2026, 10, 12) });
  reset();
  const realPipeline = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof realPipeline }).pipeline = async (commands) => (commands.some((c) => c[0] === "INCRBY") ? commands.map(() => "?") : realPipeline(commands));
  is("an unreadable count is a refusal: Stripe not called", [(await keptSaleFees(STORE, NOW)).kind, asked.length], ["used", 0]);
  (redis as unknown as { pipeline: typeof realPipeline }).pipeline = realPipeline;

  part("When the pages run out");
  reset();
  // Newest first, as Stripe lists them; the last page's oldest second may continue on the next page, so it is left out.
  const oldest = created - 5000;
  let firstPageLast = "";
  for (let p = 0; p < SALE_FEES_PAGES; p += 1) {
    const at = created - p * 1000;
    const data = p === SALE_FEES_PAGES - 1 ? [line("charge", 100, oldest + 1, "ch_k" + p, 3), line("charge", 100, oldest, "ch_j" + p, 3)] : [line("charge", 100, at, "ch_p" + p, 3)];
    if (p === 0) firstPageLast = (data[data.length - 1] as { id: string }).id;
    pages.push(page(data, true));
  }
  const capped = await keptSaleFees(STORE, NOW);
  is(`${SALE_FEES_PAGES} pages at the most`, asked.length, SALE_FEES_PAGES);
  is("each page starts after the last line of the one before", new URL(asked[1].url).searchParams.get("starting_after"), firstPageLast);
  if (capped.kind === "read") {
    is("it says it reached only to the second after its oldest line", capped.kept.since, (oldest + 1) * 1000);
    is("and keeps no line of that oldest second", capped.kept.lines.some((l) => (l as { created: number }).created === oldest), false);
  }

  part("A page in another shape, or a Stripe error, fails the reading");
  const shapes: Array<[string, () => { status: number; body: unknown }]> = [
    ["no list", () => ({ status: 200, body: { object: "balance_transaction" } })],
    ["data not a list", () => ({ status: 200, body: { object: "list", data: "x", has_more: false } })],
    ["has_more missing", () => ({ status: 200, body: { object: "list", data: [] } })],
    ["more said, nothing given", () => ({ status: 200, body: { object: "list", data: [], has_more: true } })],
    ["more than a hundred", () => ({ status: 200, body: { object: "list", data: Array.from({ length: 101 }, () => sale), has_more: false } })],
    ["a line with no id", () => ({ status: 200, body: { object: "list", data: [{ ...sale, id: 5 }], has_more: false } })],
    ["Stripe refused", () => ({ status: 500, body: { error: { type: "api_error", message: "down" } } })],
  ];
  for (const [what, reply] of shapes) {
    reset();
    pages = [reply];
    is(`${what}: failed, nothing shown`, await keptSaleFees(STORE, NOW), { kind: "failed" });
    is(`${what}: counted, since Stripe was called`, (await redis.pipeline([["GET", "nl:salefees:day:stats1:2026-11-11"]]))[0], "1");
  }
  reset();
  pages = [page([sale], false), () => ({ status: 500, body: { error: { type: "api_error" } } })];
  await keptSaleFees(STORE, NOW);
  const failedAfter = await keptSaleFees(STORE, NOW + 2 * HOUR);
  is("with a copy: the copy, said stale and failed", failedAfter.kind === "read" ? [failedAfter.kept.stale, failedAfter.kept.failed, failedAfter.kept.at] : failedAfter.kind, [true, true, NOW]);

  part("An unreadable copy is no copy");
  reset();
  await redis.pipeline([["SET", "nl:salefees:copy:stats1", "{not json", "EX", 60]]);
  pages = [page([sale], false)];
  is("it reads again", [(await keptSaleFees(STORE, NOW)).kind, asked.length], ["read", 1]);

  done();
}

void main();
