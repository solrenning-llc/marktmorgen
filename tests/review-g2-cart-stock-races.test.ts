/** Independent review of #1730 at 54b2d00b. All accounts and sessions are synthetic. */
import { withCartStockHolds, stockLeft } from "@/lib/stock";
import { createCartCheckout } from "@/lib/cart-checkout";
import { parseProduct } from "@/lib/catalog";
import { NO_DEAL } from "@/lib/cart-rules";
import { NO_RECOVERY } from "@/lib/recovery-setting";
import { NO_SALE } from "@/lib/store-sale";
import type { Listing, Product, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { done, is, part } from "./check";

const shop = { statsId: "c".repeat(32), handle: "prints", name: "Prints", email: "prints@example.com", language: "en", currency: "usd", stripeAccountId: "acct_test_cartstock1", sale: { ...NO_SALE }, cartDeal: { ...NO_DEAL }, recovery: { ...NO_RECOVERY }, hasDiscounts: false, tax: { enabled: false, included: false, ids: false, invoices: false }, affiliates: { enabled: false, percent: 0, days: 30, rates: {}, payday: 0, hold: 0 }, catalog: { id: null, items: [], head: [], inline: null } } as unknown as Store;
// Opening admission is tested elsewhere. This fixture isolates the stock helper and the real checkout request.
const checkoutShop = { ...shop, statsId: null } as unknown as Store;
const product = parseProduct({ id: "print1", title: "Print", summary: "", priceCents: 2000, stock: 1, link: "https://example.com/print" }) as Listing;
const other = parseProduct({ id: "guide1", title: "Guide", summary: "", priceCents: 900, link: "https://example.com/guide" }) as Listing;
const active = new Set<string>();
let loseReply = false;
let refuseExpire = false;
let sequence = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
  if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    const id = `cs_test_g2stock${String(++sequence).padStart(8, "0")}`;
    active.add(id);
    if (loseReply) { loseReply = false; throw new TypeError("Connection lost after checkout creation"); }
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }));
  }
  const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
  if (expire && init?.method === "POST") {
    if (refuseExpire) throw new TypeError("Expiration unavailable");
    active.delete(expire[1]);
    return new Response(JSON.stringify({ id: expire[1], status: "expired" }));
  }
  throw new Error(`Unexpected Stripe request ${init?.method} ${url.pathname}`);
}) as typeof fetch;
const open = () => createCartCheckout(checkoutShop, [product as Product, other as Product], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, held: true });
const reserve = () => withCartStockHolds(shop, [product, other], open);
const reset = () => { redis.clear(); active.clear(); loseReply = false; refuseExpire = false; };

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  part("Control: the second ordinary attempt cannot reserve the last unit");
  reset();
  is("first checkout opens", (await reserve()).ok, true);
  is("second checkout is refused", (await reserve()).ok, false);
  is("one active checkout", active.size, 1);

  part("Lock expiry after renewal but before the provisional write");
  reset();
  const original = redis.pipeline.bind(redis);
  let paused = false;
  let arrive!: () => void;
  let resume!: () => void;
  const arrived = new Promise<void>((r) => { arrive = r; });
  const resumed = new Promise<void>((r) => { resume = r; });
  redis.pipeline = async (commands) => {
    if (!paused && commands.some((c) => c[0] === "HSET" && String(c[2]).startsWith("p_"))) {
      paused = true;
      arrive();
      await resumed;
    }
    return original(commands);
  };
  const first = reserve();
  await arrived;
  redis.advance(16_000);
  const second = await reserve();
  resume();
  const firstResult = await first;
  redis.pipeline = original;
  is("competing checkout took the expired lock", second.ok, true);
  is("stale holder must not open another checkout", firstResult.ok, false);
  is("only one payable checkout for the last unit", active.size, 1);

  part("A created checkout whose response was lost remains reserved");
  reset();
  loseReply = true;
  let rejected = false;
  await reserve().catch(() => { rejected = true; });
  is("the unknown opening is reported as an error", rejected, true);
  is("provider did create a checkout", active.size, 1);
  is("unknown opening keeps the last unit occupied", await stockLeft(shop, product), 0);
  is("retry cannot open a second checkout", (await reserve()).ok, false);
  is("one active checkout after retry", active.size, 1);

  part("Partial binding writes plus unknown expiration do not free the unit");
  reset();
  refuseExpire = true;
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "HSET" && String(c[2]).startsWith("cs_test_"))) {
      // A pipeline is not a transaction: the HSET may fail while the HDEL succeeds.
      for (const command of commands) if (command[0] === "HDEL") await original([command]);
      return commands.map((c) => c[0] === "HSET" ? { error: "write refused" } : 1) as never;
    }
    return original(commands);
  };
  const partial = await reserve();
  redis.pipeline = original;
  is("unknown binding is refused", partial, { ok: false, reason: "busy" });
  is("checkout could not be confirmed expired", active.size, 1);
  is("unknown binding keeps the last unit occupied", await stockLeft(shop, product), 0);
  is("retry cannot open another checkout", (await reserve()).ok, false);
  is("one active checkout after retry", active.size, 1);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
