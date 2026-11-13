/**
 * Synthetic only (#4351, Codex X5): a PayPal bundle hands over the items the buyer paid for, as the Stripe checkout
 * does (bundleMeta), not the bundle as the creator changed it while the PayPal order was open.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { NextRequest } from "next/server";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setPayPalSeller, setProductBundle, setProductLink, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import { importedFor } from "@/lib/imported-purchases";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
const BUYER = "bundle-buyer@example.com";
let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = `5O190127TN36472${String(made).padStart(2, "0")}`;
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    return json({
      id: capture,
      status: "COMPLETED",
      payer: { email_address: BUYER, payer_id: "QYR5Z8XDVJNXQ" },
      purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9088${capture.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }],
    }, 201);
  }
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const returnFor = (store: Store, order: string) =>
  paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": "198.51.100.71" } }));

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.RESEND_API_KEY = "re_test_paypal_bundle_items";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  const OWNER = "bundle-owner@example.com";
  await claimHandle(OWNER, "harborbundle", "Harbor Bundle", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_OwnerBun01", subscriptionId: "sub_OwnerBun01", active: true, period: paidPeriod() });
  const ids: string[] = [];
  for (const title of ["Guide A", "Guide B", "Guide C"]) {
    const one = await addProduct(OWNER, title, "", "19", null);
    if (!one.ok) throw new Error("no product");
    await setProductLink(OWNER, one.product.id, `https://example.com/${title.slice(-1).toLowerCase()}`);
    ids.push(one.product.id);
  }
  const [a, b, c] = ids;
  const pack = await addProduct(OWNER, "The Pack", "", "49", null);
  if (!pack.ok) throw new Error("no bundle");
  const first = await setProductBundle(OWNER, pack.product.id, [a, b]);
  if (!first.ok) throw new Error(`no bundle items: ${JSON.stringify(first)}`);
  await setPayPalSeller(OWNER, SELLER);

  part("A PayPal bundle opened with A and B, changed to A and C before the buyer pays (Codex X5, #4351)");
  const store = (await storeForEmail(OWNER))!;
  const listing = (await readListing(store, pack.product.id))!;
  is("the bundle holds A and B when the order opens", listing.bundle, [a, b]);
  const opened = await openOrder(store, listing, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
  const changed = await setProductBundle(OWNER, pack.product.id, [a, c]);
  is("the creator's change is saved", changed.ok, true);
  await returnFor((await storeForEmail(OWNER))!, opened.order);
  const got = (await importedFor((await storeForEmail(OWNER))!, BUYER)).find((p) => p.productId === pack.product.id);
  is("the bundle is handed over", Boolean(got), true);
  is("[CORRETO] with the items the buyer paid for, A and B", got?.items, [a, b]);
  done();
}

void main();
