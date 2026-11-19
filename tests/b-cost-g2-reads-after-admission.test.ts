/**
 * Rule MR audit, G2: the creator's Stripe account is read for a checkout's discount (a code that came in a link,
 * lib/discount.ts livePromotionId) only once the order is admitted (lib/order-admission.ts admitOrders), on one
 * product's checkout (lib/store-checkout.ts) and on a cart's (lib/cart-checkout.ts). A checkout the store cannot take
 * (its month's orders reached, or the count not known because Redis failed) reads nothing from Stripe: before, the
 * code was looked up first and the order refused after, so a store at its figure, or one whose Redis failed (where
 * the route's own per-connection limit opens, lib/request-guard.ts withinLimit), was read on every try.
 *
 * Stripe is played by a stand-in for `fetch`; synthetic data only.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setHasDiscounts, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { createCartCheckout } from "@/lib/cart-checkout";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_g2_reads_after_admission";
process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const OWNER = "g2.owner@example.com";
/** Every Stripe call, in order, as "METHOD path". */
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected ${url}`);
  calls.push(`${method} ${path}`);
  if (path === "/promotion_codes" && method === "GET") return answer({ object: "list", data: [{ id: "promo_G2Spring01", active: true }], has_more: false });
  if (path === "/checkout/sessions" && method === "POST") return answer({ id: `cs_test_${"g".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** How the admission's script is answered: as written, "paused" (the month's figure reached), or Redis failing. */
let admission: "real" | "paused" | "down" = "real";
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const admits = commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:order-admission:v3"));
  if (admits && admission === "paused") return [0];
  if (admits && admission === "down") throw new Error("Redis is down (synthetic)");
  return realPipeline(commands);
}) as typeof redis.pipeline;

const promotionReads = () => calls.filter((c) => c === "GET /promotion_codes").length;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "g2shop", "G2 Shop", "Synthetic store.");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestG2Reads01", true);
  await setSubscription(OWNER, { customerId: "cus_G2Reads00001", subscriptionId: "sub_G2Reads00001", active: true, tier: "creator", period: paidPeriod() });
  await setHasDiscounts(OWNER, true);
  const made = await addProduct(OWNER, "Recipe pack", "", "27", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readProduct(store, made.product.id))!;
  const one = () => createCheckout(store, product, "https://marktmorgen.com", undefined, { code: "SPRING", digitalConsent: TEST_CONSENT }).then(() => "opened", (error: unknown) => (error instanceof Error ? error.name : "thrown"));
  const cart = () => createCartCheckout(store, [product], "https://marktmorgen.com", { code: "SPRING", digitalConsent: TEST_CONSENT } as Parameters<typeof createCartCheckout>[3]).then(() => "opened", (error: unknown) => (error instanceof Error ? error.name : "thrown"));

  for (const [what, open] of [["one product's checkout", one], ["a cart's checkout", cart]] as const) {
    part(`${what}: the code is read from Stripe only once the order is admitted`);
    admission = "real";
    calls.length = 0;
    is(`${what}, admitted: it opens with the code read`, [await open(), promotionReads()], ["opened", 1]);
    for (const refusal of ["paused", "down"] as const) {
      admission = refusal;
      calls.length = 0;
      const result = await open();
      is(`${what}, the order not admitted (${refusal === "paused" ? "the month's figure reached" : "Redis failing"}): refused, with nothing read from Stripe`, [result === "opened", calls], [false, []]);
    }
  }
  admission = "real";

  part("A call's deposit code: read from the creator's Stripe only after one of the store's buyer requests is taken");
  // The booking route (app/api/store/book/route.ts) admits the order deeper (lib/calls.ts); the code it reads first,
  // for the deposit, is counted against the store's buyer requests before the read, as a returning code is
  // (lib/returning-code.ts): no room this month, or a count not known, reads nothing and says try again.
  const route = readFileSync("app/api/store/book/route.ts", "utf8");
  const taken = route.indexOf("await takeBuyerRead(store, DEPOSIT_CODE_REQUEST_UNITS)");
  const read = route.indexOf("await readDepositCode(");
  is("the buyer request is taken, and its refusal answered, before the code is read", [taken > 0, read > 0 && taken < read, /if \(!\(await takeBuyerRead\(store, DEPOSIT_CODE_REQUEST_UNITS\)\.catch\(\(\) => false\)\)\) return back\(/.test(route)], [true, true, true]);
  admission = "down";
  const { takeBuyerRead } = await import("@/lib/buyer-actions");
  redis.pipeline = (async () => {
    throw new Error("Redis is down (synthetic)");
  }) as typeof redis.pipeline;
  is("with Redis failing, the buyer request is not taken, so nothing is read", await takeBuyerRead(store, 1).catch(() => false), false);
  redis.pipeline = realPipeline;
  admission = "real";
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
