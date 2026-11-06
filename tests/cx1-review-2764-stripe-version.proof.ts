// Fixture copied from immutable CX1 proof 08f9d750d; separate assertions about outgoing API version.
import { addProduct, claimHandle, ensureStatsId, setProductLink, setProductYearly, setStoreTiers, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { requestManageLink } from "@/lib/membership-manage";
import { onAccount } from "@/lib/stripe-account";
import { switchTier } from "@/lib/tier-switch";
import { switchYearly } from "@/lib/yearly-switch";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { is, done } from "./check";

// Synthetic transport only. No request is forwarded to a provider.
const emails: { to: string | string[]; text: string }[] = [];
const calls: { path: string; body: URLSearchParams; version: string | null }[] = [];
const subscription = "sub_CX1Member0001", customer = "cus_CX1Member0001";
const now = Math.floor(Date.now() / 1000);
const consent = { version: EU_WITHDRAWAL_CONSENT_VERSION, at: now };
let product = "", mode = "exact", actualPrice = "price_CX1Monthly0001", actualConsent = "";
const row = () => ({
  id: subscription, object: "subscription", status: "active", customer, created: now - 90 * 86400,
  start_date: now - 90 * 86400, trial_end: null, discount: null, discounts: [], pause_collection: null,
  metadata: { store: "cx1switch", product, ...(actualConsent ? { dc: actualConsent } : {}) },
  items: { data: [{ id: "si_CX1Member0001", quantity: 1, price: { id: actualPrice, unit_amount: 2000, currency: "usd", metadata: { product }, recurring: { interval: "month", interval_count: 1 } } }] },
});
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input)), method = init?.method ?? "GET";
  const json = (value: unknown) => new Response(JSON.stringify(value));
  if (url.hostname === "api.resend.com") { emails.push(JSON.parse(String(init?.body))); return json({ id: "synthetic_email" }); }
  if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
  const path = url.pathname.replace(/^\/v1/, ""), body = new URLSearchParams(String(init?.body ?? ""));
  calls.push({ path, body, version: new Headers(init?.headers).get("Stripe-Version") });
  if (method === "GET" && path === "/customers") return json({ object: "list", data: [{ id: customer, created: 1 }], has_more: false });
  if (method === "GET" && path === `/customers/${customer}`) return json({ id: customer, email: "member@example.test" });
  if (method === "GET" && path === "/subscriptions") return json({ object: "list", data: [row()], has_more: false });
  if (method === "POST" && path === "/prices") return json({ id: "price_CX1Target0001" });
  if (method === "POST" && path === `/subscriptions/${subscription}`) {
    if (!body.has("items[0][price]")) return json(row());
    const invoice = { id: "in_CX1Paid0001", status: "paid", total: 1000, amount_paid: 1000, currency: "usd" };
    if (mode === "empty") return json({});
    if (mode === "wrong subscription") return json({ ...row(), id: "sub_CX1Other0001", pending_update: null, latest_invoice: invoice });
    if (mode === "false pending") return json({ ...row(), pending_update: false, latest_invoice: invoice });
    if (mode === "declined") return json({ ...row(), pending_update: { expires_at: now + 100 }, latest_invoice: { ...invoice, id: "in_CX1Declined0001", status: "open" } });
    actualPrice = body.get("items[0][price]")!;
    actualConsent = body.get("metadata[dc]") ?? "";
    return json({ ...row(), pending_update: null, latest_invoice: invoice });
  }
  if (method === "POST" && path === "/invoices/in_CX1Declined0001/void") return json({ id: "in_CX1Declined0001", status: "void" });
  throw new Error(`Missing synthetic response ${method} ${path}`);
}) as typeof fetch;

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_cx1_synthetic_fixture_only";
  // Existing allowlisted synthetic fixture credential; no account credential.
  process.env.RESEND_API_KEY = "re_test_tiers_only";
  const owner = "cx1-switch-owner@example.test";
  await claimHandle(owner, "cx1switch", "Synthetic membership", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1CX1Fake0001", true);
  await setSubscription(owner, { customerId: "cus_CX1Owner0001", subscriptionId: "sub_CX1Owner0001", active: true, period: paidPeriod() });
  const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
  const a = await addProduct(owner, "Basic", "", "20", monthly), b = await addProduct(owner, "Pro", "", "30", monthly);
  if (!a.ok || !b.ok) throw new Error("Missing products");
  product = a.product.id;
  await setProductLink(owner, product, "https://example.test/basic");
  await setProductLink(owner, b.product.id, "https://example.test/pro");
  await setStoreTiers(owner, [product, b.product.id]);
  let store = (await storeForEmail(owner))!;
  const sent = await requestManageLink({ store, email: "member@example.test", ip: "203.0.113.15", origin: "https://example.test" });
  const token = /token=([0-9a-f]{64})/.exec(emails.at(-1)?.text ?? "")?.[1];
  if (sent !== "sent" || !token) throw new Error(`Missing synthetic member token: ${sent}; ${emails.length} emails; paths=${calls.map(c => c.path).join(",")}`);
  for (const flow of ["tier", "yearly"]) {
    if (flow === "yearly") {
      await setStoreTiers(owner, []);
      const yearly = await setProductYearly(owner, product, { cents: 20000 });
      if (!yearly.ok) throw new Error("Missing yearly offer");
      store = (await storeForEmail(owner))!;
    }
    for (mode of ["exact"]) {
      emails.length = 0; calls.length = 0;
      actualPrice = "price_CX1Monthly0001"; actualConsent = "";
      const result = flow === "tier"
        ? await switchTier(store, token, subscription, b.product.id, now, consent)
        : await switchYearly(store, token, subscription, now, consent);
      if (!result.ok) throw new Error("Fixture did not reach the charge");
      const charge = calls.find(c => c.path === `/subscriptions/${subscription}` && c.body.has("items[0][price]"));
      if (!charge || !charge.body.has("metadata[dc]")) throw new Error("Missing actual charging request with consent");
      const supportsMetadata = (version: string | null) => Boolean(version && /^20[0-9]{2}-[0-9]{2}-[0-9]{2}\.[a-z]+$/.test(version) && version.slice(0, 10) >= "2026-05-27");
      is(`${flow}: metadata with pending_if_incomplete pins an API version that supports it`, [charge.body.get("payment_behavior"), supportsMetadata(charge.version)], ["pending_if_incomplete", true]);
      // Real onAccount positive control: its explicit fifth argument reaches the outgoing header.
      calls.length = 0;
      await onAccount("POST", store.stripeAccountId!, `/subscriptions/${subscription}`, charge.body, "2026-08-26.dahlia");
      is(`${flow}: explicit supported version survives the real transport`, calls.at(-1)?.version, "2026-08-26.dahlia");
    }
  }
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
