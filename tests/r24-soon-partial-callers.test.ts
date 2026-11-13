/**
 * CX-123 rule 24 for the three callers left by #3183: soonState now returns
 * `partial: true`, with the ids it could read, when one member of the
 * coming-soon set is not a product id. The cart link builder
 * (lib/cart-link-products.ts), the email product cards
 * (lib/mail-product-sellable.ts) and the cart checkout (POST
 * /api/store/cart) only failed closed when the read threw; with `partial`
 * they took every product not in the read set as "not coming soon", so a
 * product whose own member was unreadable could be listed, shown in an email
 * as buyable, or sent to Stripe.
 *
 * While the read is partial, a product not in the read set is unknown: the
 * builder leaves it out, the email leaves it out, and the checkout sends the
 * buyer back to the cart with the unknown-state answer (cart=error), nothing
 * opened at Stripe. A product read as coming soon keeps its old answer, and a
 * reply read whole decides as before.
 *
 * Synthetic store; one reply injected per case; Stripe stubbed; no network.
 */
import { NextRequest } from "next/server";
import { POST as payCart } from "@/app/api/store/cart/route";
import { cartLinkProducts } from "@/lib/cart-link-products";
import { readListings } from "@/lib/catalog";
import { productsBuyableNow } from "@/lib/mail-product-sellable";
import { soonState } from "@/lib/preorders";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let soonKey = "";
let inject: (() => unknown[]) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (inject && batch.some((c) => c[0] === "SMEMBERS" && c[1] === soonKey)) return inject();
  return real(batch);
}) as typeof redis.pipeline;

const stripeSessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    stripeSessions.push(new URLSearchParams(String(init.body)));
    return Response.json({ id: "cs_test_r24SoonPartial0001", url: "https://checkout.stripe.com/c/pay/cs_test_r24SoonPartial0001" });
  }
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

const OWNER = "r24-soon-partial@example.test";
const HANDLE = "r24soonpartial";

async function made(title: string, price: string): Promise<string> {
  const added = await addProduct(OWNER, title, "A synthetic product.", price, null);
  if (!added.ok) throw new Error(`fixture could not add ${title}`);
  await setProductLink(OWNER, added.product.id, `https://example.test/${added.product.id}`);
  return added.product.id;
}

/** The cart checkout for these ids; where it sends the buyer and how many Stripe sessions it opened. */
async function pay(ids: string[]): Promise<{ location: string; opened: number }> {
  const before = stripeSessions.length;
  const form = withConsent(new URLSearchParams([["handle", HANDLE], ...ids.map((id) => ["id", id] as [string, string])]));
  const response = await payCart(new NextRequest("https://marktmorgen.test/api/store/cart", {
    method: "POST",
    headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  }));
  return { location: response.headers.get("location") ?? "", opened: stripeSessions.length - before };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_r24_soon_partial_stand_in";
  redis.clear();
  await claimHandle(OWNER, HANDLE, "R24 Soon Partial", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_R24Partial01", subscriptionId: "sub_R24Partial01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1R24SoonPartial", true);
  const app = await made("Desktop app", "40");
  const guide = await made("Field guide", "25");
  const notes = await made("Pocket notes", "12");
  const store = (await storeForEmail(OWNER))!;
  soonKey = `nl:wl:${store.statsId}:soon`;
  const listings = await readListings(store);
  const listed = async () => (await cartLinkProducts(store)).map((p) => p.id).sort();
  const buyable = async () => [...(await productsBuyableNow(store, listings))].sort();
  const everyone = [app, guide, notes].sort();

  part("Control: the reading whole, nothing coming soon");
  is("soonState is whole and empty", [(await soonState(store)).soon.size, (await soonState(store)).partial], [0, undefined]);
  is("cart link builder: every product is offered", await listed(), everyone);
  is("email cards: every product is buyable", await buyable(), everyone);
  const whole = await pay([guide, notes]);
  is("cart checkout: opens at Stripe", whole.opened, 1);

  part("Control: the reading whole, one product coming soon");
  await real([["SADD", soonKey, app]]);
  is("cart link builder: the product coming soon is left out, the others offered", await listed(), [guide, notes].sort());
  is("email cards: the product coming soon is out, the others in", await buyable(), [guide, notes].sort());
  const soonPaid = await pay([app, guide]);
  is("cart checkout with the product coming soon: back to the cart as changed, nothing opened", [soonPaid.opened, soonPaid.location.includes("cart=changed")], [0, true]);
  const otherPaid = await pay([guide, notes]);
  is("cart checkout without it: opens at Stripe", otherPaid.opened, 1);
  await real([["SREM", soonKey, app]]);

  for (const [reading, reply] of [
    ["one product read as coming soon, a member beside it unreadable", () => [[app, null], []]],
    ["no member readable", () => [[1], []]],
  ] as const) {
    part(`Coming soon read in part: ${reading}`);
    inject = reply;
    const partly = await soonState(store);
    is("soonState says only part of it was read", partly.partial, true);
    is("cart link builder: offers no product whose state is unknown", await listed(), []);
    is("email cards: no product whose state is unknown is buyable", await buyable(), []);
    const unknown = await pay([guide, notes]);
    is("cart checkout: nothing is sent to Stripe", unknown.opened, 0);
    is("cart checkout: the buyer goes back to the cart to try again (unknown state)", unknown.location.includes("cart=error"), true);
    inject = null;
  }

  part("Control: in part, a product read as coming soon keeps its own answer at the checkout");
  inject = () => [[app, null], []];
  const known = await pay([app]);
  is("the product read as coming soon is refused as changed, nothing opened", [known.opened, known.location.includes("cart=changed")], [0, true]);
  inject = null;

  part("Control: the reading whole again decides as before");
  is("soonState is whole again", (await soonState(store)).partial, undefined);
  is("cart link builder: every product is offered again", await listed(), everyone);
  is("email cards: every product is buyable again", await buyable(), everyone);
  const again = await pay([guide, notes]);
  is("cart checkout: opens at Stripe again", again.opened, 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
