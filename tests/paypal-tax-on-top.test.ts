/**
 * Issue #3971 (Codex X8; money and tax), coordinator's decision (mail 20261123T021638Z-claude-1-coord-6df4, 2): a
 * store whose tax is added on top of its prices (store.tax.enabled and not included) charges a Stripe buyer the price
 * plus the tax, but the PayPal order (lib/paypal-sales.ts) asks for the price alone, so a PayPal buyer paid less and
 * the tax configured to be charged on top was never charged: sold without its tax, which IV (h) forbids. Until the
 * owner decides how PayPal could charge it, PayPal is not offered in such a store (paypalOffered, and so paypalReady
 * and the PayPal checkout route), and the creator is told so plainly. A store with tax included in its prices, or no
 * tax, keeps PayPal as before; what was bought by PayPal stays readable (sellsThroughPayPal is unchanged).
 *
 * Synthetic only: a synthetic store record and PayPal partner settings, nothing reached.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paypalReady, sellsThroughPayPal } from "@/lib/paypal-sales";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.PAYPAL_PARTNER_CLIENT_ID = "synthetic-client";
process.env.PAYPAL_PARTNER_SECRET = "synthetic-secret";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "SYNTHETICPART1";
process.env.PAYPAL_BN_CODE = "SYNTHETIC_BN";

async function main(): Promise<void> {
  redis.clear();
  const owner = "paypal-tax@example.com";
  await claimHandle(owner, "paypaltax", "PayPal Tax", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_PayPalTax01", subscriptionId: "sub_PayPalTax01", active: true, tier: "creator", period: paidPeriod() });
  const base = { ...(await storeForEmail(owner))!, currency: "usd", paypalSeller: { merchant: "SYNTHETICMERCH1", at: Date.now() } } as NonNullable<Awaited<ReturnType<typeof storeForEmail>>>;
  const product = { id: "prod000001", title: "A guide", priceCents: 10_000, hidden: false, recurring: null, call: null, pwyw: null, keys: null, options: [], stock: null, shipping: null, bundle: null, course: null, podcast: null, file: { name: "guide.pdf" }, link: null } as unknown as Listing;
  const withTax = (enabled: boolean, included: boolean) => ({ ...base, tax: { ...base.tax, enabled, included } });

  part("Controls: no tax, or tax included in the price: PayPal as before");
  is("the store takes PayPal", sellsThroughPayPal(withTax(false, false)), true);
  is("no tax: PayPal offered", paypalReady(withTax(false, false), product), true);
  is("tax included in the price: PayPal offered", paypalReady(withTax(true, true), product), true);

  part("Tax added on top of the price: PayPal is not offered, never sold without its tax");
  is("PayPal not offered for the product", paypalReady(withTax(true, false), product), false);
  is("what was bought by PayPal stays readable (the store still takes PayPal for that)", sellsThroughPayPal(withTax(true, false)), true);

  part("The creator is told, in plain words");
  const page = readFileSync(join(process.cwd(), "app/studio/tax/page.tsx"), "utf8");
  is("the tax page says PayPal is not offered while tax is added on top", page.includes("PayPal is not offered at checkout while tax is added on top of your prices"), true);
  // Claude 1's LEVE on #5243: the sentence only where PayPal would otherwise be offered, and "by card" only where the card checkout sells.
  is("the sentence only where PayPal would otherwise be offered", /sellsThroughPayPal\(store\) && taxOnTop\(store\)/.test(page), true);
  is("\"by card\" only where the store sells by card", /canSell\(store\) \? " Buyers pay by card through Stripe\." : " Buyers cannot pay until you connect Stripe or turn off tax on top\."/.test(page), true);
  is("the PayPal checkout route asks paypalReady", readFileSync(join(process.cwd(), "app/api/store/paypal/checkout/route.ts"), "utf8").includes("paypalReady(store, product)"), true);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
