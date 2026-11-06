/**
 * Review proof for #2846 (synthetic). The cart route reads soonState with `.catch(() => ({ soon: new Set() }))`.
 * At base, soonState read SMEMBERS leniently and a malformed HGETALL (pre-order days) only lost the days: the
 * coming-soon product stayed in `soon` and the cart refused it. At the PR head, exactDays throws on that HGETALL,
 * soonState throws, the cart's catch turns it into "nothing is coming soon", and a Stripe checkout opens for a
 * product its creator marked coming soon (SMEMBERS answered exactly).
 */
import { NextRequest } from "next/server";
import { POST as cartRoute } from "@/app/api/store/cart/route";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { setSoon } from "@/lib/waitlist";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_rev2846_cart";
const sessions: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    sessions.push(String(init.body));
    return Response.json({ id: "cs_test_rev2846cart01", url: "https://checkout.stripe.com/c/pay/rev2846" });
  }
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

let malformedDays = false;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await real(commands);
  if (!malformedDays) return replies;
  // Only the pre-order days' HGETALL answers in another shape (odd length); SMEMBERS answers exactly.
  return replies.map((reply, i) => (commands[i][0] === "HGETALL" && String(commands[i][1]).endsWith(":pre") ? ["only-a-field"] : reply));
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "rev2846cart@example.test";
  await claimHandle(owner, "rev2846cart", "Cart proof", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_Rev2846Cart0001", true);
  await setSubscription(owner, { customerId: "cus_Rev2846Cart01", subscriptionId: "sub_Rev2846Cart01", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Coming guide", "", "19", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.test/guide");
  const store = (await storeForEmail(owner))!;
  await setSoon(store, made.product.id, true);
  const pay = async () => {
    const before = sessions.length;
    const f = new FormData();
    f.set("handle", "rev2846cart");
    f.set("id", made.product.id);
    // Outside Next's request scope the route's `after()` (run only once the checkout is open) throws: read as "opened".
    const location = await cartRoute(new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com" } }))
      .then((response) => response.headers.get("location"), () => "after() outside a request: the checkout had opened");
    return [location, sessions.length - before];
  };
  part("control: the coming-soon product, read exactly, is refused by the cart");
  is("refused, no Stripe checkout", await pay(), ["https://marktmorgen.com/@rev2846cart?cart=changed#cart", 0]);
  part("finding: SMEMBERS exact, only the days' HGETALL malformed");
  malformedDays = true;
  is("still refused, no Stripe checkout (base behaviour)", await pay(), ["https://marktmorgen.com/@rev2846cart?cart=changed#cart", 0]);
  malformedDays = false;
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
