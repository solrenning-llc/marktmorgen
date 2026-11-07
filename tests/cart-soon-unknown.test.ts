/**
 * The cart's checkout (POST /api/store/cart) reads which products are still
 * coming soon (soonState). A reading that cannot be had was taken as "nothing
 * is coming soon", so a pre-order product could be paid for as if it were out
 * (found in the independent review of #2846, which makes soonState throw on a
 * malformed reply). Unknown is never "not coming soon": the buyer goes back to
 * the cart to try again and no checkout is opened.
 */
import { NextRequest } from "next/server";
import { POST as payCart } from "@/app/api/store/cart/route";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { setSoon } from "@/lib/waitlist";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const pipeline = redis.pipeline.bind(redis);
const stripeSessions: URLSearchParams[] = [];
process.env.STRIPE_SECRET_KEY = "sk_test_cart_soon_unknown";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    stripeSessions.push(new URLSearchParams(String(init.body)));
    return Response.json({ id: "cs_test_cartSoonUnknown0001", url: "https://checkout.stripe.com/c/pay/cs_test_cartSoonUnknown0001" });
  }
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

async function shop(handle: string): Promise<{ store: Store; product: string }> {
  const owner = `${handle}@example.test`;
  const claimed = await claimHandle(owner, handle, "Cart soon shop", "");
  if (!claimed.ok) throw new Error("fixture could not claim store");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestCartSoon1", true);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Soon guide", "A synthetic guide", "19", null);
  if (!made.ok) throw new Error("fixture could not add product");
  await setProductLink(owner, made.product.id, "https://example.test/guide");
  const store = await storeForEmail(owner);
  if (!store) throw new Error("fixture store not found");
  return { store, product: made.product.id };
}

type Mode = "soon" | "out" | "throws";
async function pay(mode: Mode) {
  redis.clear();
  redis.pipeline = pipeline;
  stripeSessions.length = 0;
  const fixture = await shop(`cartsoon${mode}`);
  if (mode !== "out") await setSoon(fixture.store, fixture.product, true);
  if (mode === "throws") {
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (commands[0]?.[0] === "SMEMBERS" && commands[0]?.[1] === `nl:wl:${fixture.store.statsId}:soon`) throw new Error("connection lost");
      return pipeline(commands);
    };
  }
  try {
    const form = withConsent(new URLSearchParams({ handle: fixture.store.handle, id: fixture.product }));
    const response = await payCart(new NextRequest("https://marktmorgen.test/api/store/cart", {
      method: "POST",
      headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }));
    return { location: response.headers.get("location") ?? "", opened: stripeSessions.length };
  } finally {
    redis.pipeline = pipeline;
  }
}

async function main() {
  part("Controls: what is known decides as before");
  const out = await pay("out");
  is("a product that is out opens its checkout", out.opened, 1);
  const soon = await pay("soon");
  is("a product known to be coming soon is refused, nothing opened", [soon.opened, soon.location.includes("cart=changed")], [0, true]);

  part("Unknown is never \"not coming soon\"");
  const unknown = await pay("throws");
  is("no checkout is opened when the pre-order reading fails", unknown.opened, 0);
  is("the buyer goes back to the cart to try again", unknown.location.includes("cart=error"), true);
  done();
}

void main().catch((error) => { console.error(error); process.exitCode = 2; });
