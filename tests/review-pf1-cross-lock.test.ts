/**
 * Independent review of #1730 (head 0fba9e71) and #1732 (head 994ce30f), 5 November 2026.
 * A product bought on its own (withStockHold) and a cart (withCartStockHolds) share the
 * product's lock key. At #1730 the single-product path still holds a plain "1" lock while
 * Stripe opens its checkout and writes its hold only afterwards; once that lock runs out, a
 * cart counts the same last unit and opens a second checkout. #1732 makes withStockHold a
 * cart of one, which closes it. All accounts and sessions are synthetic.
 */
import { stockLeft, withCartStockHolds, withStockHold } from "@/lib/stock";
import { parseProduct } from "@/lib/catalog";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const shop = { statsId: "d".repeat(32), handle: "prints", stripeAccountId: "acct_test_crosslock1" } as unknown as Store;
const product = parseProduct({ id: "print1", title: "Print", summary: "", priceCents: 2000, stock: 1, link: "https://example.com/print" }) as Listing;
let sequence = 0;
const made = () => ({ id: `cs_test_crosslock${String(++sequence).padStart(8, "0")}` });

async function main() {
  part("A product bought on its own and a cart, racing for the last unit");
  redis.clear();
  let arrive!: () => void;
  let resume!: () => void;
  const arrived = new Promise<void>((r) => { arrive = r; });
  const resumed = new Promise<void>((r) => { resume = r; });
  // The single checkout's opening at Stripe is slow (up to 20 s a request, a retry loop besides).
  const single = withStockHold(shop, product, async () => { arrive(); await resumed; return made(); }).catch((error: Error) => ({ ok: false as const, reason: error.message }));
  await arrived;
  // Long enough for any lock taken before the opening to have run out (25 s at #1732).
  redis.advance(60_000);
  const cart = await withCartStockHolds(shop, [product], async () => made()).catch((error: Error) => ({ ok: false as const, reason: error.message }));
  resume();
  const alone = await single;
  is("at most one checkout gets the last unit", [alone.ok, cart.ok].filter(Boolean).length <= 1, true);
  is("and the count never goes below what was sold", await stockLeft(shop, product), 0);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
