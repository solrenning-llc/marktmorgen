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
import { captureOrder, openOrder, paypalReady, sellsThroughPayPal } from "@/lib/paypal-sales";
import { savedOfferIssues } from "@/lib/funnel-offer-review";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGES } from "@/lib/store-language";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, setPayPalSeller, setProductLink, setSubscription, setTax, storeForEmail, type Listing } from "@/lib/store";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.PAYPAL_PARTNER_CLIENT_ID = "synthetic-client";
process.env.PAYPAL_PARTNER_SECRET = "synthetic-secret";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "SYNTHETICPART1";
process.env.PAYPAL_BN_CODE = "SYNTHETIC_BN";

// A stand-in PayPal: an order it opens, and a capture it counts (Claude 7's LEVE on #5243).
const SELLER = "7KNGBPH2U58GQ";
let made = 0;
let captures = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = `7P190127TN36471${String(made).padStart(2, "0")}`;
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    captures += 1;
    const cap = `4D679366HH9087${capture.slice(-2)}`;
    return json({ id: capture, status: "COMPLETED", payer: { email_address: "buyer@example.com" }, purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: cap, status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }] }, 201);
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "paypal-tax@example.com";
  await claimHandle(owner, "paypaltax", "PayPal Tax", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_PayPalTax01", subscriptionId: "sub_PayPalTax01", active: true, tier: "creator", period: paidPeriod() });
  const base = { ...(await storeForEmail(owner))!, currency: "usd", paypalSeller: { merchant: "SYNTHETICMERCH1", at: Date.now() } } as NonNullable<Awaited<ReturnType<typeof storeForEmail>>>;
  const product = { id: "prod000001", title: "A guide", priceCents: 10_000, hidden: false, recurring: null, call: null, pwyw: null, keys: null, options: [], bumps: [], stock: null, shipping: null, bundle: null, course: null, podcast: null, file: { name: "guide.pdf" }, link: null } as unknown as Listing;
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
  is("\"by card\" only where the store sells by card", /canSell\(store\) \? " Buyers pay by card through Stripe\."/.test(page), true);
  // The coordinator's triple audit on #5243: "turn off tax on top" cannot be done in the studio without Stripe, so it is not offered.
  is("without card payments, only a step the creator can take", /store\.stripeAccountId \? " Buyers cannot pay until your Stripe account can take card payments\." : " Buyers cannot pay until you connect Stripe\."/.test(page), true);
  is("never \"turn off tax on top\" as the way out", page.includes("or turn off tax on top"), false);
  const editor = readFileSync(join(process.cwd(), "components/tax-editor.tsx"), "utf8");
  is("the tax editor says PayPal goes away as tax on top is chosen", /paypal && enabled && !included\s*\? "With tax added on top, PayPal is not offered at checkout, because a PayPal payment would not include the tax\."/.test(editor), true);
  const studio = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
  is("the studio tells the tax editor whether the store sells through PayPal", studio.includes("paypal={sellsThroughPayPal(store)}"), true);
  is("after connecting PayPal, a store with tax on top is not told a PayPal button now shows", /params\.paypal === "ready" && taxOnTop\(store\) \? paypalReadyTaxOnTop\(Boolean\(store\.stripeAccountId\)\)/.test(studio), true);
  // Claude 1 2as's LEVE on #5243: the notice names the section and the choice as the studio prints them.
  is("that notice names the studio's own section and choice", studio.includes("stripe ? \"Under Tax and invoices, choose \\u201cMy prices already include it\\u201d to show the PayPal button.\"") && editor.includes("Tax and invoices") && editor.includes("My prices already include it"), true);
  is("the connected PayPal box says it is not offered while tax is on top", /\{taxOnTop\(store\) \? \(\s*<p className="mt-2 text-sm text-ink">\s*Not offered at checkout while tax is added on top of your prices/.test(studio), true);

  // Claude 6 hsz3's LEVE on #5243: without Stripe the tax choice cannot be made, so connecting Stripe comes first.
  is("without Stripe, the PayPal notice says to connect Stripe first", studio.includes(": \"To show the PayPal button, connect Stripe, then under Tax and invoices choose \\u201cMy prices already include it\\u201d.\""), true);

  part("The funnel review names the real cause (a store selling by PayPal alone, with tax on top)");
  const paypalOnly = { ...withTax(true, false), stripeAccountId: null, stripeChargesEnabled: false } as typeof base;
  const issues = savedOfferIssues(paypalOnly, product, [product]);
  is("the review says tax on top is why PayPal is not offered", issues.some((issue) => issue.startsWith("Store payments are unavailable: PayPal is not offered while tax is added on top of your prices")), true);
  is("not the generic plan and connection words", issues.includes("Store payments are unavailable. Review the store plan and payment connection."), false);
  // Claude 6 hsz3's LEVE on #5243: only a step the creator can take; tax cannot be changed without Stripe.
  is("without Stripe: only \"Connect Stripe\", never the tax choice", issues.some((issue) => issue.endsWith("Connect Stripe to take payments.")) && !issues.some((issue) => issue.includes("include it")), true);
  const halfSet = savedOfferIssues({ ...paypalOnly, stripeAccountId: "acct_1TestHarbor0001" } as typeof base, product, [product]);
  is("with Stripe connected but no card payments yet: finish Stripe, or include tax", halfSet.some((issue) => issue.endsWith("Finish setting up your Stripe account to take card payments, or under Tax and invoices choose \u201cMy prices already include it\u201d.")), true);
  is("control: the same store with tax included has no payment issue", savedOfferIssues({ ...paypalOnly, tax: { ...paypalOnly.tax, included: true } }, product, [product]).some((issue) => issue.startsWith("Store payments are unavailable")), false);
  is("the PayPal checkout route asks paypalReady", readFileSync(join(process.cwd(), "app/api/store/paypal/checkout/route.ts"), "utf8").includes("paypalReady(store, product)"), true);

  part("An order opened before tax went on top and approved after is not taken without its tax (Claude 7's LEVE on #5243)");
  const seller = "paypal-tax-late@example.com";
  await claimHandle(seller, "paypaltaxlate", "PayPal Tax Late", "");
  await ensureStatsId(seller);
  await setSubscription(seller, { customerId: "cus_PayPalTax02", subscriptionId: "sub_PayPalTax02", active: true, tier: "creator", period: paidPeriod() });
  const added = await addProduct(seller, "Rye Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(seller, added.product.id, "https://example.com/rye");
  await setPayPalSeller(seller, SELLER);
  const onTop = { ...(await storeForEmail(seller))!.tax, enabled: true, included: false };
  let late = (await storeForEmail(seller))!;
  const sold = await openOrder(late, (await readListing(late, added.product.id))!, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!sold.ok) throw new Error("no order");
  const control = await openOrder(late, (await readListing(late, added.product.id))!, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!control.ok) throw new Error("no control order");
  const paidBefore = await captureOrder(late, control.order);
  is("control: with no tax, the approved order is taken", paidBefore.ok, true);
  const asked = captures;
  await setTax(seller, onTop);
  late = (await storeForEmail(seller))!;
  is("the store now adds tax on top", late.tax.enabled && !late.tax.included, true);
  const after = await captureOrder(late, sold.order);
  is("the order approved after tax went on top is not taken, said as \"tax\"", after, { ok: false, reason: "tax" });
  is("PayPal is not asked to take it", captures, asked);
  // One a capture was already asked for (its answer lost) stays with the sweep: its buyer goes to the thanks page.
  const tried = await openOrder({ ...late, tax: { ...late.tax, enabled: false } }, (await readListing(late, added.product.id))!, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!tried.ok) throw new Error("no tried order");
  await redis.pipeline([["INCR", `nl:ppsell:try:${tried.order}`]]);
  // Claude 6 UoHAG's LEVE on #5243: tried and let go (a declined try takes it out of pending) is "tax", not the thanks page.
  is("an order tried and let go (not under watch) is said as \"tax\"", await captureOrder(late, tried.order), { ok: false, reason: "tax" });
  await redis.pipeline([["ZADD", `nl:ppsell:pending:${late.statsId}`, Math.floor(Date.now() / 1000), tried.order]]);
  is("an order tried and still under watch goes to the thanks page, as a pending one", await captureOrder(late, tried.order), { ok: false, reason: "pending" });
  is("PayPal is still not asked", captures, asked);

  part("The buyer is told nothing was charged, in every buyer language");
  const ret = readFileSync(join(process.cwd(), "app/api/store/paypal/return/route.ts"), "utf8");
  is("the return route sends a \"tax\" refusal to its own words", ret.includes('if (result.reason === "tax") return away(`/@${store.handle}?status=paypal-tax`);'), true);
  is("English: nothing was charged, and how to pay", wordsIn("en").notices["paypal-tax"]?.body.includes("Nothing was charged."), true);
  is("every buyer language has the words", Object.values(LANGUAGES).every((lang) => Boolean(wordsIn(lang.code).notices["paypal-tax"]?.title && wordsIn(lang.code).notices["paypal-tax"]?.body)), true);
  const again = await captureOrder(late, control.order);
  is("one already paid is still shown as paid", again.ok && !again.fresh, true);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
