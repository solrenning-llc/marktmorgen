/**
 * The cart as it is opened (GET /api/store/cart) reads which products are
 * still coming soon (soonState) to say whether each line can be paid for. A
 * reading that cannot be had was taken as "nothing is coming soon", so the
 * cart showed a pre-order product as payable and the payment was refused
 * after (Claude 6's audit of rule 24, 7 November 2026, a LOW). Unknown is
 * never "not coming soon": the line is not payable right now.
 */
import { NextRequest } from "next/server";
import { GET as readCart } from "@/app/api/store/cart/route";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { setSoon } from "@/lib/waitlist";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const pipeline = redis.pipeline.bind(redis);
const stripeSessions: URLSearchParams[] = [];
process.env.STRIPE_SECRET_KEY = "sk_test_cart_soon_get";

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
async function open(mode: Mode): Promise<boolean | null> {
  redis.clear();
  redis.pipeline = pipeline;
  const fixture = await shop(`cartget${mode}`);
  if (mode !== "out") await setSoon(fixture.store, fixture.product, true);
  if (mode === "throws") {
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (commands[0]?.[0] === "SMEMBERS" && commands[0]?.[1] === `nl:wl:${fixture.store.statsId}:soon`) throw new Error("connection lost");
      return pipeline(commands);
    };
  }
  try {
    const url = `https://marktmorgen.test/api/store/cart?handle=${fixture.store.handle}&ids=${fixture.product}`;
    const response = await readCart(new NextRequest(url, { headers: { host: "marktmorgen.test" } }));
    const json = (await response.json()) as { items?: { id: string; ok: boolean }[] };
    return json.items?.find((item) => item.id === fixture.product)?.ok ?? null;
  } finally {
    redis.pipeline = pipeline;
  }
}

async function main() {
  part("Controls: what is known decides as before");
  is("a product that is out can be paid for", await open("out"), true);
  is("a product known to be coming soon cannot", await open("soon"), false);

  part("Unknown is never \"not coming soon\"");
  is("when the pre-order reading fails, the line is not payable right now", await open("throws"), false);
  done();
}

void main().catch((error) => { console.error(error); process.exitCode = 2; });
