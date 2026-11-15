/**
 * The store's public "recent purchases" (lib/recent-sales.ts):
 * - #4709 (Codex X8): a sale made and refunded on Stripe account A came back once the store connected account B,
 *   because the kept purchase did not say which account it was on and B's refunds were used to check it. A purchase is
 *   shown only while the account it was made on is the one connected, and the cached copy is bound to that account.
 * - #4743 (Codex X8): the three cards were cut in the order purchases were written, so recording them newest first
 *   dropped the newest. They are now cut newest first by the purchase's time.
 * Synthetic Redis and Stripe stand-in: each account lists its own refunds.
 */
import { recentSales, rememberSale } from "@/lib/recent-sales";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_recent_account_order";
const NOW = Math.floor(Date.now() / 1000);
const A = "acct_1RecentSalesA001";
const B = "acct_1RecentSalesB001";
/** The refunds each connected account lists. */
const refundsOf: Record<string, Record<string, unknown>[]> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const account = String(new Headers(init?.headers).get("Stripe-Account") ?? "");
  if (url.pathname === "/v1/refunds") return new Response(JSON.stringify({ object: "list", data: refundsOf[account] ?? [], has_more: false }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const checkout = (n: number, product: string) => ({
  id: `cs_live_${String(n).padStart(24, "a")}`,
  mode: "payment",
  created: NOW - n * 3600,
  amount_total: 2900,
  payment_intent: `pi_live${n}abcdef`,
  metadata: { store: "bakery", product },
  customer_details: { address: { country: "DE" } },
});

async function main(): Promise<void> {
  redis.clear();
  const owner = "recent.account@example.com";
  await claimHandle(owner, "bakery", "Bakery", "");
  await ensureStatsId(owner);
  const bread = await addProduct(owner, "Sourdough course", "", "29", null);
  if (!bread.ok) throw new Error("no product");
  const base = (await storeForEmail(owner))!;
  const onA = { ...base, recentSales: true, stripeAccountId: A };
  const onB = { ...base, recentSales: true, stripeAccountId: B };
  const feed = `nl:recent:feed:${base.statsId}`;
  const list = `nl:recent:${base.statsId}`;

  part("#4709: a sale on account A, refunded there");
  await rememberSale(onA, checkout(1, bread.product.id));
  refundsOf[A] = [{ status: "succeeded", payment_intent: "pi_live1abcdef" }];
  is("connected to A: the refunded sale is not shown", await recentSales(onA), []);
  await redis.pipeline([["DEL", feed]]);
  is("connected to B, the copy expired: A's refunded sale is not shown", await recentSales(onB), []);

  part("#4709: a sale on A that was not refunded is not shown as B's either");
  await redis.pipeline([["DEL", feed, list]]);
  refundsOf[A] = [];
  await rememberSale(onA, checkout(2, bread.product.id));
  is("(control) connected to A: shown", (await recentSales(onA)).map((s) => s.at), [NOW - 2 * 3600]);
  is("connected to B while A's copy is still kept: not shown", await recentSales(onB), []);
  await redis.pipeline([["DEL", feed]]);
  is("connected to B, the copy expired: not shown", await recentSales(onB), []);
  await rememberSale(onB, checkout(3, bread.product.id));
  is("(control) a sale on B is shown on B", (await recentSales(onB)).map((s) => s.at), [NOW - 3 * 3600]);

  part("#4743: purchases recorded newest first are still cut to the three newest");
  await redis.pipeline([["DEL", feed, list]]);
  for (const hours of [1, 2, 3, 4]) await rememberSale(onA, checkout(hours, bread.product.id));
  const newest = [NOW - 3600, NOW - 2 * 3600, NOW - 3 * 3600];
  is("only the three newest purchases by their time are shown", (await recentSales(onA)).map((s) => s.at), newest);
  is("the cached cards keep the same order", (await recentSales(onA)).map((s) => s.at), newest);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
