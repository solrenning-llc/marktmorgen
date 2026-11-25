/**
 * Issue #4287, item 14 (Codex X5, `X5-20261112-2211-defeito-carrinho-leitura-parcial.md`; rule 24): the cart as it is
 * opened (GET /api/store/cart) read the store's coming-soon products (lib/preorders.ts soonState) and used the set it
 * got even when the read was partial (`partial: true`: some members were not text, so a product coming soon may be
 * missing from it). A line was then said payable, and suggestions and a bundle swap were offered from that set,
 * although the checkout (POST) already refuses on a partial read (knownNotSoon). Now the GET reads it the same way:
 * on a partial read no line is payable, and nothing is suggested or swapped.
 *
 * Synthetic store, in-memory Redis, Stripe played by a stand-in; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { GET as readCart } from "@/app/api/store/cart/route";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cart_soon_partial";
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

const original = redis.pipeline.bind(redis);
/** What the coming-soon set's SMEMBERS answers instead of Redis, while set. */
let soonAnswer: unknown = undefined;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (soonAnswer !== undefined && commands[0]?.[0] === "SMEMBERS" && /^nl:wl:.*:soon$/.test(String(commands[0]?.[1]))) {
    const rest = commands.length > 1 ? await original(commands.slice(1)) : [];
    return [soonAnswer, ...rest];
  }
  return original(commands);
}) as typeof redis.pipeline;

type Line = { id: string; ok: boolean };

async function main() {
  redis.clear();
  const owner = "soon-partial@example.test";
  if (!(await claimHandle(owner, "soonpartial", "Soon shop", "")).ok) throw new Error("no store");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestCartSoon1", true);
  await setSubscription(owner, { customerId: "cus_SoonPartial01", subscriptionId: "sub_SoonPartial01", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Public guide", "Out now", "19", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.test/guide");
  const store = (await storeForEmail(owner))!;
  const open = async () => {
    const response = await readCart(new NextRequest(`https://marktmorgen.test/api/store/cart?handle=${store.handle}&ids=${made.product.id}`, { headers: { host: "marktmorgen.test" } }));
    return { status: response.status, json: (await response.json()) as { items?: Line[]; suggest?: unknown[]; bundle?: unknown } };
  };

  part("Control: the coming-soon set read whole, the line is payable");
  const control = await open();
  is("answered", control.status, 200);
  is("the line is payable", control.json.items?.map((l) => l.ok), [true]);

  part("The coming-soon set read partially: no line is payable, nothing offered");
  soonAnswer = ["another00000", 7];
  const partial = await open();
  soonAnswer = undefined;
  is("answered", partial.status, 200);
  is("the line is not payable", partial.json.items?.map((l) => l.ok), [false]);
  is("nothing suggested", partial.json.suggest ?? [], []);
  is("no bundle swap", partial.json.bundle ?? null, null);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
