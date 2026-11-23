/**
 * #5267 audit (coordinator ea4f 10): a sales file sends at most SALES_FILE_MAX_BYTES (lib/stats.ts salesCsv), so what
 * it sends is priced at a known most. Its sales come newest first; a sale whose line would take the file past the
 * most is left out with every older one, and the file is partial ("file-size"), never cut inside a line. Checked with a
 * small most, through the real salesCsv, on a Stripe stand-in with paid checkouts.
 */
import { salesCsv, SALES_FILE_MAX_BYTES } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.UTC(2026, 10, 20) / 1000);
const sessions = Array.from({ length: 10 }, (_, i) => ({
  id: `cs_size_${i}`, object: "checkout.session", created: NOW - i * 3600, status: "complete", payment_status: "paid", mode: "payment",
  amount_total: 1000, currency: "usd", metadata: { store: "sizeshop", product: "p1", title: "A synthetic product" },
  customer_details: { email: `buyer${i}@example.com`, name: "A synthetic buyer", address: { country: "US" } },
}));
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const data = url.pathname.endsWith("/checkout/sessions") ? sessions : [];
  return new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_sales_file_size_only";
  redis.clear();
  console.error = () => {};
  const OWNER = "sales-file-size@example.com";
  await claimHandle(OWNER, "sizeshop", "Size Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1SizeShop000001", true);
  const store = (await storeForEmail(OWNER))!;

  part("Under the most: every sale, not partial");
  const whole = await salesCsv(store, 0);
  is("10 sales, whole", [whole.rows, whole.partial, whole.gaps], [10, false, []]);
  is("the most is far above a usual file", Buffer.byteLength(whole.csv, "utf8") < SALES_FILE_MAX_BYTES / 1000, true);

  part("At a most that holds four lines: the newest four, partial, never a line cut");
  const lines = whole.csv.split("\r\n");
  const most = Buffer.byteLength(lines.slice(0, 5).join("\r\n") + "\r\n", "utf8");
  const cut = await salesCsv(store, 0, most);
  const kept = cut.csv.split("\r\n").filter(Boolean);
  is("four sales, partial for its size", [cut.rows, cut.partial, cut.gaps.includes("file-size")], [4, true, true]);
  is("within the most", Buffer.byteLength(cut.csv, "utf8") <= most, true);
  is("the newest four, whole lines", kept.slice(1), lines.slice(1, 5));
  done();
}

void main().catch((error) => {
  console.log(error);
  process.exit(1);
});
