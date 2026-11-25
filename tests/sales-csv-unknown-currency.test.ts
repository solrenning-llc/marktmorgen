/**
 * #5285 row #3074, Claude 4's LEVE 1 (review 6717993013): a sale whose currency Stripe's answer does not name is in a
 * currency nobody knows (CX-123 rule 24), so the sales file never writes an amount for it. Its amount, discount and
 * tax are left blank, as an amount that is not whole cents already is, never written with a guessed number of decimals
 * (¥7000 is not "70.00"). The file still lists the row and still says it is incomplete. Rows in a named currency are
 * written exactly as before, a zero-decimal one included.
 *
 * Synthetic data and a stand-in for Stripe only: no real account, payment or buyer.
 */
import { salesCsv } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sales_csv_unknown_currency";
const NOW = Date.parse("2026-10-13T12:00:00Z");
const S = NOW / 1000;

/** The currency the odd checkout and the odd one-click extra carry: `undefined` leaves the field out. */
let odd: unknown = "usd";
const withCurrency = (row: Record<string, unknown>) => (odd === undefined ? row : { ...row, currency: odd });

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
  const meta = { store: "csvcur", product: "p1" };
  if (url.pathname.endsWith("/checkout/sessions")) return list([
    { id: "cs_test_csvcur0001", status: "complete", payment_status: "paid", amount_total: 5000, currency: "usd", created: S, payment_intent: "pi_csvcur0001", total_details: { amount_discount: 500, amount_tax: 250 }, metadata: meta },
    withCurrency({ id: "cs_test_csvcur0002", status: "complete", payment_status: "paid", amount_total: 7000, created: S, payment_intent: "pi_csvcur0002", total_details: { amount_discount: 300, amount_tax: 100 }, metadata: meta }),
  ]);
  if (url.pathname.endsWith("/payment_intents")) return list([
    withCurrency({ id: "pi_csvcur0003", status: "succeeded", amount: 900, created: S, metadata: { kind: "upsell", store: "csvcur", product: "p2" } }),
  ]);
  return list([]);
}) as typeof fetch;

/** The amount, discount, tax and currency cells of the row with this id. */
function money(csv: string, id: string): string[] | null {
  const line = csv.split("\n").find((l) => l.includes(id));
  if (!line) return null;
  const cells = line.split(",").map((cell) => cell.replace(/^"|"$/g, ""));
  return cells.slice(7, 11);
}

const UNKNOWN: [string, unknown][] = [
  ["no currency at all", undefined],
  ["a currency of null", null],
  ["an empty currency", ""],
  ["a currency that is a number", 840],
  ["a currency that is not a code", "dollars"],
];

async function main(): Promise<void> {
  redis.clear();
  const owner = "csvcur-owner@example.com";
  await claimHandle(owner, "csvcur", "Csv Currency", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCsvCur01", true);
  const store = (await storeForEmail(owner))!;
  const since = S - 86400;

  part("Control: rows in a named currency are written as before");
  odd = "usd";
  const usd = await salesCsv(store, since);
  is("control: complete, three rows", [usd.partial, usd.rows], [false, 3]);
  is("control: the dollar checkout's amount, discount, tax and currency", money(usd.csv, "cs_test_csvcur0002"), ["70.00", "3.00", "1.00", "USD"]);
  is("control: the dollar extra, with its known zero discount and tax", money(usd.csv, "pi_csvcur0003"), ["9.00", "0.00", "0.00", "USD"]);
  odd = "jpy";
  const yen = await salesCsv(store, since);
  is("control: a yen checkout keeps its zero decimals", money(yen.csv, "cs_test_csvcur0002"), ["7000", "300", "100", "JPY"]);
  is("control: a yen extra too", money(yen.csv, "pi_csvcur0003"), ["900", "0", "0", "JPY"]);

  for (const [label, currency] of UNKNOWN) {
    part(`Unknown currency: ${label}`);
    odd = currency;
    const read = await salesCsv(store, since);
    is(`${label}: the file still lists every row and says it is incomplete`, [read.partial, read.rows, read.gaps.includes("currency")], [true, 3, true]);
    is(`${label}: the checkout's amount, discount and tax are blank, never a guessed figure`, money(read.csv, "cs_test_csvcur0002"), ["", "", "", ""]);
    is(`${label}: the extra's amount, discount and tax are blank too`, money(read.csv, "pi_csvcur0003"), ["", "", "", ""]);
    is(`${label}: the dollar checkout beside them is written as before`, money(read.csv, "cs_test_csvcur0001"), ["50.00", "5.00", "2.50", "USD"]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
