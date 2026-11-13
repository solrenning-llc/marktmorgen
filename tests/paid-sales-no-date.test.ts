/**
 * #4397 (Codex X8, money, the owner's figures): a paid sale or one-click extra that Stripe gives with no
 * `created` is never dated by the app's clock. The reading says it is partial and names why, the sale is
 * put on no day, and the sales file never writes the moment of the export as its paid_at_utc.
 * A valid provider date keeps today's reading. Synthetic Stripe only.
 */
import { readPaidSales, salesCsv } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_paid_sales_no_date";
const DATED = Date.parse("2026-10-13T12:00:00Z") / 1000;
type Mode = { session?: unknown; extra?: unknown };
let mode: Mode = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) {
    return list([{
      id: "cs_test_nodate0001", status: "complete", payment_status: "paid", amount_total: 6500, currency: "usd",
      ...("session" in mode ? (mode.session === undefined ? {} : { created: mode.session }) : { created: DATED }),
      payment_intent: "pi_nodate0001", customer_details: { email: "buyer@example.com" },
      metadata: { store: "nodate", product: "p1" },
    }]);
  }
  if (url.pathname.endsWith("/payment_intents")) {
    return list([{
      id: "pi_nodate_extra01", status: "succeeded", amount: 1200, currency: "usd",
      ...("extra" in mode ? (mode.extra === undefined ? {} : { created: mode.extra }) : { created: DATED }),
      metadata: { kind: "upsell", store: "nodate", product: "p2" },
    }]);
  }
  return list([]);
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "nodate-owner@example.com";
  await claimHandle(owner, "nodate", "No Date", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestNoDate0001", true);
  const store = (await storeForEmail(owner))!;

  part("control: both dated by Stripe");
  mode = {};
  const dated = await readPaidSales(store, 0, 1);
  is("a complete reading, each sale on Stripe's own date", [dated.partial, dated.gaps, dated.sales.map((s) => s.created).sort()], [false, [], [DATED * 1000, DATED * 1000]]);

  for (const [what, m] of [
    ["a checkout with no created", { session: undefined }],
    ["a one-click extra with no created", { extra: undefined }],
    ["a checkout whose created is not a number", { session: "2026-10-13" }],
    ["a one-click extra whose created is not a whole second", { extra: DATED + 0.5 }],
    ["a checkout whose created is zero", { session: 0 }],
  ] as [string, Mode][]) {
    part(what);
    mode = m;
    const before = Date.now();
    const read = await readPaidSales(store, 0, 1);
    const after = Date.now();
    is(`${what}: the reading is partial and says the date is missing`, [read.partial, read.gaps], [true, ["date"]]);
    is(`${what}: no sale is put on the moment of reading`, read.sales.some((s) => s.created >= before && s.created <= after), false);
    is(`${what}: no sale is put on a made-up day`, read.sales.every((s) => s.created === DATED * 1000), true);
  }

  part("the sales file");
  mode = { session: undefined };
  const before = new Date().toISOString().slice(0, 16);
  const csv = await salesCsv(store, 0);
  is("the file is partial and names the missing date", [csv.partial, csv.gaps], [true, ["date"]]);
  is("no paid_at_utc is the moment of the export", csv.csv.includes(before), false);
  is("the undated checkout is not a row; the dated extra is", [csv.csv.includes("cs_test_nodate0001"), csv.csv.includes("pi_nodate_extra01")], [false, true]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
