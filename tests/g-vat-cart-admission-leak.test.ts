/**
 * A VAT refusal happens after admitOrders but before Stripe is asked. With no session id,
 * holdCheckout cannot register a hold for the unpaid-checkout sweep, so the slot must not remain held.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCartCheckout } from "@/lib/cart-checkout";
import { EuVatCollectRefused } from "@/lib/eu-vat-collect";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_g_vat_admission_only";

const held = (folder: string): number => {
  const fields = redis.run(["HGETALL", `nl:orders:open:${folder}`]);
  if (!Array.isArray(fields)) return -1;
  let total = 0;
  for (let i = 1; i < fields.length; i += 2) total += Number(fields[i]);
  return total;
};

async function main(): Promise<void> {
  redis.clear();
  const owner = "g-vat-admission-owner@example.com";
  await claimHandle(owner, "gvatadmission", "Synthetic", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1GvatAdmission", true);
  await setSubscription(owner, {
    customerId: "cus_GvatAdmission01",
    subscriptionId: "sub_GvatAdmission01",
    active: true,
    period: paidPeriod(),
  });
  const ids: string[] = [];
  for (const [title, link] of [["Synthetic pack", "https://example.invalid/pack"], ["Synthetic guide", "https://example.invalid/guide"]]) {
    const made = await addProduct(owner, title, "", "10", null);
    if (!made.ok) throw new Error("fixture product was not made");
    await setProductLink(owner, made.product.id, link);
    ids.push(made.product.id);
  }
  const shop = (await storeForEmail(owner))!;
  const products = await Promise.all(ids.map(async (id) => (await readProduct(shop, id))!));
  const folder = await storeFolder(owner);

  part("a refusal before Stripe must leave no admitted checkout behind");
  is("control: no checkout place is held", held(folder), 0);
  const answer = await createCartCheckout(shop, products, "https://marktmorgen.com", {
    digitalConsent: TEST_CONSENT,
    euVat: {
      country: "DE",
      now: new Date("2026-12-01T12:00:00Z"),
      rates: [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-20" }],
      // No reviewed collection cost: the production function returns null and refuses before Stripe.
    },
  }).then(() => "opened", (error: unknown) => (error instanceof EuVatCollectRefused ? "vat-refused" : String(error)));
  is("VAT refused before Stripe", answer, "vat-refused");
  is("the refused checkout holds no monthly order place", held(folder), 0);
  done();
}

void main();
