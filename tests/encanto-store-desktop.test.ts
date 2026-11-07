/**
 * Encanto 3, the store on a computer (C4-20261106-0520-TODOS-19; docs/encanto-visual-comparison-2026-11-06.md, unit 3):
 *
 *   - the box to start access at once (components/digital-consent-box.tsx: the checkbox, its EU/UK note and the
 *     store-closing sentence) is drawn once, on the chosen product's own page, directly above its Buy button, inside
 *     the checkout form the server checks (lib/digital-consent.ts); a card on a list of products (the store page, a
 *     collection) no longer repeats it: its button leads to that buy step, with the same words the product page's
 *     own buttons use (pageAction), and the product's name for a screen reader;
 *   - the words of the box are untouched: the same component, the same props, drawn by the same BuyBox;
 *   - from 1024 px wide, the store's profile stands beside its products, which go two to a row; a phone keeps one
 *     column, as before.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { BuyBox, ProductCard, productPath } from "@/components/store-product";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_encanto_store_only";
  await claimHandle("encanto@example.com", "encantostore", "Encanto Kitchen", "");
  await ensureStatsId("encanto@example.com");
  await setStripeAccount("encanto@example.com", "acct_1EncantoStore01", true);
  await setSubscription("encanto@example.com", { customerId: "cus_Encanto0001", subscriptionId: "sub_Encanto0001", active: true, period: paidPeriod() });
  const made = await addProduct("encanto@example.com", "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("encanto@example.com", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("encanto@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  const base = { store, product, related: [], remaining: null, writes: false, selling: true };

  part("A card on a list: the box is not repeated, the button leads to the buy step");
  const card = renderToStaticMarkup(createElement(ProductCard, { ...base, manageable: false }));
  is("no box to start access at once on the card", [count(card, /name="dc"/g), count(card, /data-digital-consent=""/g), count(card, /data-closing-access=""/g)], [0, 0, 0]);
  is("no checkout form on the card for it", count(card, /data-checkout=""/g), 0);
  const step = card.match(/<a[^>]*data-buy-step=""[^>]*>([\s\S]*?)<\/a>/);
  is("one button to the product's own buy step", [count(card, /data-buy-step=""/g), step?.[0].includes(`href="${productPath(store, product)}#buy"`)], [1, true]);
  is("it says what the product page's own buttons say", step?.[1].replace(/<span class="sr-only">[\s\S]*?<\/span>/, ""), "Buy for $49");
  is("and names the product for a screen reader (link purpose on its own)", /<span class="sr-only">: Sourdough Course<\/span>/.test(step?.[1] ?? ""), true);
  is("it is a button-sized target", /class="btn st-btn btn-block mt-4"/.test(step?.[0] ?? ""), true);

  part("The product's own page: the box once, directly above its Buy button, in the form the server checks");
  const page = renderToStaticMarkup(createElement(BuyBox, base));
  is("one checkout form", count(page, /data-checkout=""/g), 1);
  is("one box, its note and the closing sentence once", [count(page, /name="dc"/g), count(page, /data-digital-consent=""/g), count(page, /data-closing-access=""/g)], [1, 1, 1]);
  const form = page.slice(page.indexOf("data-checkout"), page.indexOf("</form>"));
  is("the box is inside that form", form.includes('name="dc"'), true);
  const afterBox = form.slice(form.indexOf("data-digital-consent"));
  is("and the next control after it is the Buy button", /^[\s\S]*?<\/div>\s*<button type="submit"/.test(afterBox.slice(afterBox.indexOf('data-closing-access'))), true);
  is("the box is still required for a product handed over digitally", /name="dc"[^>]*required|required[^>]*name="dc"/.test(page), true);

  part("Coming soon, taking pre-orders: the card leads to the pre-order");
  const soon = renderToStaticMarkup(createElement(ProductCard, { ...base, manageable: false, soon: true, preorder: "2026-12-01" }));
  is("no box on the card", count(soon, /name="dc"/g), 0);
  is("the button leads to the pre-order", (soon.match(/<a[^>]*data-buy-step=""[^>]*>/)?.[0] ?? "").includes(`href="${productPath(store, product)}#preorder"`), true);

  part("The words of the box are untouched");
  const source = readFileSync("components/store-product.tsx", "utf8");
  is("the same five boxes in the file (buy box, gift, group, pre-order, PayPal)", count(source, /<DigitalConsentBox/g), 5);
  is("the card's buy box is asked for the buy step", /<BuyBox\s[\s\S]*?\bstepped\b[\s\S]*?\/>/.test(source.slice(source.indexOf("export function ProductCard"))), true);

  part("From 1024 px: the profile beside the products, two to a row");
  const store_page = readFileSync("app/[handle]/page.tsx", "utf8");
  const layout = store_page.match(/<div className="([^"]*)" data-store-layout="">/)?.[1] ?? "";
  is("a two-column layout from lg, the profile's column first", [/\blg:grid\b/.test(layout), layout.includes("lg:grid-cols-[19rem_minmax(0,1fr)]")], [true, true]);
  is("the profile is the layout's first part", store_page.indexOf('data-store-layout=""') >= 0 && store_page.indexOf('data-store-layout=""') < store_page.indexOf("data-store-profile") && store_page.indexOf("data-store-profile") < store_page.indexOf('<div className="mx-auto max-w-xl px-4 pb-16 pt-5'), true);
  is("the products two to a row from lg", store_page.includes('<ul className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">'), true);
  is("a phone keeps the one column, as before", store_page.includes('<div className="mx-auto max-w-xl px-4 pb-16 pt-5 lg:max-w-none lg:px-0 lg:pt-0">'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
