/**
 * EU VAT art. 9a, opening path (C2-20261113-1320-ABRIR-1, 2b): the card checkout of one product and the cart ask
 * lib/eu-vat-gate.ts consumerGate before anything is held, written or sent to Stripe. A paid sale to the EU or the UK
 * goes back to the page with "abroad"; a sale without the billing country goes back with "country"; one with both
 * outside opens Stripe's page as before. The creator's Stripe account is played by a stand-in for `fetch`; nothing
 * real is reached.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription } from "@/lib/store";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { POST as cartRoute } from "@/app/api/store/cart/route";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_eu_vat_checkout_routes_only";

const sessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    sessions.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"e".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const SHOP = "vatgateshop";
const ask = (path: string, ip: string | null, fields: Record<string, string>) => {
  const form = withConsent(new FormData());
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const headers: Record<string, string> = { host: "marktmorgen.com" };
  if (ip) headers["x-vercel-ip-country"] = ip;
  return new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", body: form, headers });
};

async function main(): Promise<void> {
  redis.clear();
  const owner = "vatgate@example.com";
  await claimHandle(owner, SHOP, "VAT Gate Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestVatGate001", true);
  await setSubscription(owner, { customerId: "cus_VatGate00001", subscriptionId: "sub_VatGate00001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Pattern pack", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/pack");
  const id = made.product.id;
  const buy = (ip: string | null, fields: Record<string, string> = {}) => checkoutRoute(ask("/api/store/checkout", ip, { handle: SHOP, product: id, ...fields }));
  const cart = (ip: string | null, fields: Record<string, string> = {}) => cartRoute(ask("/api/store/cart", ip, { handle: SHOP, id, ...fields }));
  const where = (response: Response) => [response.status, response.headers.get("location")];

  part("One product, by card");
  let before = sessions.length;
  is("an EU buyer: back to the product with abroad", where(await buy("DE", { billing_country: "DE" })), [303, `https://marktmorgen.com/@${SHOP}/p/${id}?status=abroad#buy`]);
  is("a UK buyer by billing country alone: abroad", where(await buy(null, { billing_country: "GB" })), [303, `https://marktmorgen.com/@${SHOP}/p/${id}?status=abroad#buy`]);
  is("a VPN outside with an EU billing country: abroad", where(await buy("US", { billing_country: "FR" })), [303, `https://marktmorgen.com/@${SHOP}/p/${id}?status=abroad#buy`]);
  is("no billing country: asked for it", where(await buy("US")), [303, `https://marktmorgen.com/@${SHOP}/p/${id}?status=country#buy`]);
  is("sent back from the renewal page: back there", where(await buy("US", { from: "renew" })), [303, `https://marktmorgen.com/@${SHOP}/renew/${id}?status=country`]);
  is("Stripe was never asked for any of them", sessions.length - before, 0);
  before = sessions.length;
  const fine = await buy("US", { billing_country: "US" });
  is("outside, with the billing country: Stripe's page opens", [fine.status, fine.headers.get("location"), sessions.length - before], [303, "https://checkout.stripe.com/c/pay/test", 1]);

  part("The cart");
  before = sessions.length;
  is("a UK buyer: back to the cart with abroad", where(await cart("GB", { billing_country: "GB" })), [303, `https://marktmorgen.com/@${SHOP}?cart=abroad#cart`]);
  is("no billing country: back to the cart, asked for it", where(await cart("US")), [303, `https://marktmorgen.com/@${SHOP}?cart=country#cart`]);
  is("Stripe was never asked", sessions.length - before, 0);
  const opened = await cart("CA", { billing_country: "CA" });
  is("outside, with the billing country: Stripe's page opens", [opened.status, opened.headers.get("location"), sessions.length - before], [303, "https://checkout.stripe.com/c/pay/test", 1]);

  done();
}

void main();
