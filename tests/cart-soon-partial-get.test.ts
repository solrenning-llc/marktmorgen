/**
 * The cart as it is opened (GET /api/store/cart) while the coming-soon reading
 * is partial (lib/preorders.ts, soonState: a member of the set is not a product
 * id). A product outside the read set may be coming soon, so it is unknown
 * (CX-123 rule 24): its line is not payable right now, and nothing is suggested,
 * as the cart checkout (POST) and the email cards already do (#3212). Issue
 * #4287, item 14 (Codex X5). A reading taken whole decides as before.
 */
import { NextRequest } from "next/server";
import { GET as readCart } from "@/app/api/store/cart/route";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setProductPairs, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const pipeline = redis.pipeline.bind(redis);
process.env.STRIPE_SECRET_KEY = "sk_test_cart_soon_partial_get";
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

type Read = { ok: boolean | null; suggest: number };
async function open(partial: boolean): Promise<Read> {
  redis.clear();
  redis.pipeline = pipeline;
  const handle = partial ? "cartpartialget" : "cartwholeget";
  const owner = `${handle}@example.test`;
  const claimed = await claimHandle(owner, handle, "Cart partial shop", "");
  if (!claimed.ok) throw new Error("fixture could not claim store");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestCartPartial1", true);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "creator", period: paidPeriod() });
  const ids: string[] = [];
  for (const title of ["Main guide", "Paired guide"]) {
    const made = await addProduct(owner, title, "A synthetic guide", "19", null);
    if (!made.ok) throw new Error("fixture could not add product");
    await setProductLink(owner, made.product.id, `https://example.test/${made.product.id}`);
    ids.push(made.product.id);
  }
  const paired = await setProductPairs(owner, ids[0], [ids[1]]);
  if (!paired.ok) throw new Error("fixture could not pair products");
  const store = (await storeForEmail(owner))!;
  if (partial) {
    redis.pipeline = async (commands: (string | number)[][]) => {
      const replies = await pipeline(commands);
      // One member of the coming-soon set is not a product id: soonState reads it as partial.
      if (commands[0]?.[0] === "SMEMBERS" && commands[0]?.[1] === `nl:wl:${store.statsId}:soon`) return [[42], ...replies.slice(1)];
      return replies;
    };
  }
  try {
    const url = `https://marktmorgen.test/api/store/cart?handle=${handle}&ids=${ids[0]}`;
    const response = await readCart(new NextRequest(url, { headers: { host: "marktmorgen.test" } }));
    const json = (await response.json()) as { items?: { id: string; ok: boolean }[]; suggest?: unknown[] };
    return { ok: json.items?.find((item) => item.id === ids[0])?.ok ?? null, suggest: json.suggest?.length ?? -1 };
  } finally {
    redis.pipeline = pipeline;
  }
}

async function main() {
  part("Control: the coming-soon set read whole");
  const whole = await open(false);
  is("the line can be paid for", whole.ok, true);
  is("the creator's pick is suggested", whole.suggest, 1);

  part("The coming-soon set read in part");
  const partial = await open(true);
  is("the line is not payable right now", partial.ok, false);
  is("nothing is suggested", partial.suggest, 0);
  done();
}

void main().catch((error) => { console.error(error); process.exitCode = 2; });
