/**
 * PayPal's refund.issued names nobody the store deleted at or after the payment (R38, rule 30; review of #3491): the
 * same deletion print as the Stripe events (lib/suppression.ts, nl:erased:), read by emitEvent only for an event about
 * to be kept for a live endpoint. A person deleted before they paid, or never deleted, is named as before; the rest
 * of the refund is unchanged. Synthetic only: PayPal and the sender are stand-ins for fetch, Redis is
 * lib/redis-memory.ts, and the endpoint's name resolves to a private address, so nothing leaves this machine.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder } from "@/lib/paypal-sales";
import { handOverPayPal, sweepPayPal } from "@/lib/paypal-delivery";
import { addEndpoint, recentMessages, setSendHooksForTests } from "@/lib/webhooks";
import { suppressCommand } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
process.env.RESEND_API_KEY = "re_test_paypal_refund_erased";
delete process.env.PAYPAL_ENV;

let made = 0;
const captures = new Map<string, string>();
const payers = new Map<string, string>();
const orderId = (n: number) => `5O190127TN36472${String(n).padStart(2, "0")}`;
let payer = "";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ object: "list", data: [], has_more: false });
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    payers.set(id, payer);
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture) {
    const cap = `3C679366HH9088${capture.slice(-2)}`;
    captures.set(cap, "COMPLETED");
    return json({
      id: capture,
      status: "COMPLETED",
      payer: { email_address: payers.get(capture) },
      purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: cap, status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }],
    }, 201);
  }
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap) return json({ id: cap, status: captures.get(cap) ?? "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const logged = console.error;
console.error = (...args: unknown[]) => {
  if (args.map(String).join(" ").startsWith("a webhook delivery failed")) return;
  logged(...args);
};

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "paypal-erased@example.com";
  await claimHandle(OWNER, "paypal-erased-shop", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PayPalErased1", subscriptionId: "sub_PayPalErased1", active: true, period: paidPeriod() });
  const added = await addProduct(OWNER, "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(OWNER, added.product.id, "https://example.com/guide");
  await setPayPalSeller(OWNER, SELLER);
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  is("an endpoint listening for refunds is kept", (await addEndpoint(store, "https://hooks.example.net/in", ["refund.issued"])).ok, true);
  const product = (await readListing(store, added.product.id))!;

  /** Pays an order as `email`, hands it over, writes their deletion print `erasedAfter` seconds after the payment (none when null), and refunds it in full on PayPal. */
  const refunded = async (email: string, erasedAfter: number | null) => {
    payer = email;
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error("no order");
    const paid = await captureOrder(store, opened.order);
    if (!paid.ok) throw new Error(`not paid: ${paid.reason}`);
    await handOverPayPal(store, paid.paid);
    if (erasedAfter !== null) await redis.pipeline([suppressCommand(listId, email, paid.paid.at + erasedAfter)]);
    captures.set(paid.paid.capture, "REFUNDED");
    await redis.pipeline([["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", opened.order]]);
    await sweepPayPal(store, Date.now() + 10_000);
    const message = (await recentMessages(store, "refund.issued", 50)).find((m) => (m.data as Record<string, unknown>).paypal_capture === paid.paid.capture);
    return message ? (message.data as Record<string, unknown>) : null;
  };

  part("PayPal's refund.issued: no address for a person deleted at or after the payment");
  const gone = await refunded("pp-gone@example.com", 100);
  is("deleted after paying: sent, with no address and no name", gone?.buyer, { email: null, name: null });
  is("the rest of the refund is unchanged", [gone?.paid_with, gone?.amount_refunded_cents, gone?.fully_refunded], ["paypal", 4900, true]);
  const same = await refunded("pp-same@example.com", 0);
  is("deleted in the second of the payment: the same", same?.buyer, { email: null, name: null });
  const before = await refunded("pp-before@example.com", -100);
  is("deleted before they paid: named as before", before?.buyer, { email: "pp-before@example.com", name: null });
  const kept = await refunded("pp-kept@example.com", null);
  is("never deleted: named as before", kept?.buyer, { email: "pp-kept@example.com", name: null });
  is("the address appears nowhere in what is kept for the endpoint", JSON.stringify(await recentMessages(store, "refund.issued", 50)).includes("pp-gone@example.com"), false);

  console.error = logged;
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
