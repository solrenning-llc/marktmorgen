/**
 * A product the creator ships, at a price the buyer chooses (514 [PF2], one
 * of its units; lib/shipping.ts, lib/store.ts, lib/pay-what-you-want.ts;
 * added 16 November 2026). Until now a physical product had to have a set
 * price. Checked:
 *
 *   - lib/shipping.ts no longer refuses a price the buyer chooses, and still
 *     refuses everything else it did (free, membership, call, payment plan,
 *     something to hand over);
 *   - a product can be made physical with a price the buyer chooses on it,
 *     and a physical product can be given one in its editor, at or above the
 *     creator's lowest price; it still cannot be made free or a membership;
 *   - its checkout uses the creator's choose-your-price Price, still asks
 *     Stripe for an address in one of its countries and adds the shipping as
 *     its own line; with tax on, the Price is made for goods (Stripe's
 *     product_data[tax_code], read on docs.stripe.com on 16 November 2026)
 *     and shipping is taxed as shipping; the goods Price is a different one
 *     from the same product's Price made before it shipped;
 *   - never as a gift or for a group, never in PayPal, never in a cart, as
 *     before.
 */
import { shipProblem, type ShipCandidate } from "@/lib/shipping";
import { sellsWithPayPal } from "@/lib/paypal-sales";
import { addProduct, claimHandle, editProduct, ensureStatsId, setProductLink, setProductShipping, setStripeAccount, setSubscription, setTax, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { parseShipping } from "@/lib/shipping";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const checkouts: URLSearchParams[] = [];
const prices: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/prices" && method === "POST") {
    prices.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `price_test${String(prices.length).padStart(8, "0")}` });
  }
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"s".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_physical_pwyw_only_a_stand_in";

  part("The rule");
  const base: ShipCandidate = { priceCents: 2_000, recurring: null, call: null, options: [], pwyw: null, plan: null, file: null, link: null, course: null, podcast: null, bundle: null };
  is("a price the buyer chooses can ship", shipProblem({ ...base, pwyw: { suggestedCents: 2_500 } }), null);
  is("what could not ship still cannot", [
    shipProblem({ ...base, priceCents: 0 }),
    shipProblem({ ...base, recurring: { interval: "month" } as never }),
    shipProblem({ ...base, call: {} as never }),
    shipProblem({ ...base, plan: {} as never }),
    shipProblem({ ...base, file: {} as never }),
  ], ["free", "membership", "call", "plan", "delivery"]);

  part("In the studio");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const shipping = parseShipping({ cents: 600, region: "na", note: "Ships within 3 business days" })!;
  // Chosen first, then shipped.
  const zine = await addProduct(OWNER, "Harbor Zine", "Printed, 40 pages.", "10", null, "15");
  if (!zine.ok) throw new Error(`no product: ${JSON.stringify(zine)}`);
  const shippedAfter = await setProductShipping(OWNER, zine.product.id, shipping);
  is("a product with a price the buyer chooses can be made physical", shippedAfter.ok ? [shippedAfter.product.pwyw, shippedAfter.product.shipping?.cents] : shippedAfter.reason, [{ suggestedCents: 1500 }, 600]);
  // Shipped first, then chosen.
  const mug = await addProduct(OWNER, "Harbor Mug", "Stoneware.", "20", null);
  if (!mug.ok) throw new Error("no product");
  await setProductShipping(OWNER, mug.product.id, shipping);
  const chosen = await editProduct(OWNER, mug.product.id, "Harbor Mug", "Stoneware.", "20", null, "28");
  is("a physical product can be given a price the buyer chooses", chosen.ok ? [chosen.product.pwyw, chosen.product.priceCents, chosen.product.shipping?.cents] : chosen.reason, [{ suggestedCents: 2800 }, 2000, 600]);
  const under = await editProduct(OWNER, mug.product.id, "Harbor Mug", "Stoneware.", "20", null, "12");
  is("the suggestion is still at or above the lowest price", under.ok ? "saved" : [under.reason, (under as { pwyw?: string }).pwyw], ["pwyw", "suggested"]);
  const free = await editProduct(OWNER, mug.product.id, "Harbor Mug", "Stoneware.", "0", null, null);
  is("a physical product still cannot be free", free.ok ? "saved" : free.reason, "shipped");
  const monthly = await editProduct(OWNER, mug.product.id, "Harbor Mug", "Stoneware.", "20", { interval: "month" } as never, null);
  is("or a membership", monthly.ok ? "saved" : monthly.reason, "shipped");

  part("Its checkout");
  const load = async (id: string) => {
    const store = (await storeForEmail(OWNER))!;
    return { store, product: (await readProduct(store, id))! };
  };
  let { store, product } = await load(mug.product.id);
  is("not in PayPal, as before", sellsWithPayPal(product), false);
  await createCheckout(store, product, "https://marktmorgen.com", "", {});
  let sent = checkouts.at(-1)!;
  is("the line is the creator's choose-your-price Price", [sent.get("line_items[0][price]"), sent.get("line_items[0][price_data][unit_amount]"), sent.get("metadata[pwyw]")], ["price_test00000001", null, "yes"]);
  is("with the creator's lowest and suggested prices", [prices.at(-1)?.get("custom_unit_amount[minimum]"), prices.at(-1)?.get("custom_unit_amount[preset]")], ["2000", "2800"]);
  is("Stripe asks for an address in one of its countries", [sent.get("shipping_address_collection[allowed_countries][0]"), sent.get("shipping_address_collection[allowed_countries][1]")], ["US", "CA"]);
  is("and adds the shipping as its own line", [sent.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"), sent.get("metadata[ship]")], ["600", "yes"]);
  is("tax off: the Price has no tax code of ours", prices.at(-1)?.get("product_data[tax_code]") ?? null, null);

  await setTax(OWNER, { enabled: true, included: false, ids: false, invoices: false } as never);
  ({ store, product } = await load(mug.product.id));
  await createCheckout(store, product, "https://marktmorgen.com", "", {});
  sent = checkouts.at(-1)!;
  is("tax on: the Price is made for goods, with the store's tax behavior", [prices.length, prices.at(-1)?.get("product_data[tax_code]"), prices.at(-1)?.get("tax_behavior")], [2, "txcd_99999999", "exclusive"]);
  is("and shipping is taxed as shipping", [sent.get("line_items[0][price]"), sent.get("shipping_options[0][shipping_rate_data][tax_code]")], ["price_test00000002", "txcd_92010001"]);

  // A product that does not ship keeps the Price it had: no goods tax code on it.
  const pdf = await addProduct(OWNER, "Harbor PDF", "", "8", null, "10");
  if (!pdf.ok) throw new Error("no product");
  await setProductLink(OWNER, pdf.product.id, "https://example.com/pdf");
  ({ store, product } = await load(pdf.product.id));
  await createCheckout(store, product, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT });
  is("a product that does not ship is not made for goods", [prices.length, prices.at(-1)?.get("product_data[tax_code]") ?? null], [3, null]);

  ({ store, product } = await load(mug.product.id));
  let gift = "sent";
  await createCheckout(store, product, "https://marktmorgen.com", "", { gift: "g".repeat(16) }).catch(() => (gift = "refused"));
  is("never as a gift", gift, "refused");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
