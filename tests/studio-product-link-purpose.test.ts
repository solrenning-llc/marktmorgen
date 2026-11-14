/**
 * AX274, WCAG 2.4.9 Link Purpose (Link Only) at AAA: every link says where it goes
 * by its own words. Chromium on 13 November 2026, /studio at 1280 px with three
 * products: each product's row had "Sell this as a bundle of your products" and
 * "Offer more after they pay", the same words three times to three different
 * products, so a screen reader's list of links could not tell them apart. The
 * bundle's "Choose what is in it" and the funnel's "Edit the funnel" repeat the
 * same way once a store has several bundles or funnels.
 *
 * What must hold: each of those links names its product for screen readers, after
 * the visible words, so the words shown stay at the start of the name (2.5.3). The
 * same audit's "Its page" and "Do it" are in #3782.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BundleToggle } from "@/components/bundle-toggle";
import type { Product } from "@/lib/store";
import { done, is, part } from "./check";

const base = { priceCents: 1900, options: [], recurring: undefined, call: undefined, course: undefined, file: undefined, link: undefined, pwyw: undefined } as unknown as Product;
const product = (id: string, title: string, bundle?: string[]) => ({ ...base, id, title, bundle }) as unknown as Product;
const draw = (p: Product) => renderToStaticMarkup(createElement(BundleToggle, { product: p }));
const text = (html: string) => html.replace(/<[^>]+>/g, "");

part("Sell this as a bundle names its product");
const a = draw(product("p1", "Weekly meal planner"));
const b = draw(product("p2", "Grocery list pack"));
is("each link's name differs by its product", [text(a), text(b)], ["Sell this as a bundle of your products: Weekly meal planner", "Sell this as a bundle of your products: Grocery list pack"]);
is("the product's name is for screen readers; the words shown are unchanged", /Sell this as a bundle of your products<span class="sr-only">: Weekly meal planner<\/span>/.test(a), true);

part("Choose what is in it names its bundle");
const c = draw(product("p3", "Starter kit", ["p1", "p2"]));
is("the bundle's link names it", /Choose what is in it<span class="sr-only">: Starter kit<\/span>/.test(c), true);

part("The funnel links name their product");
const extras = readFileSync("components/checkout-extras.tsx", "utf8");
is("Offer more after they pay names its product", /Offer more after they pay\s*<span className="sr-only">\{`: \$\{product\.title\}`\}<\/span>/.test(extras), true);
is("Edit the funnel names its product", /Edit the funnel<span className="sr-only">\{`: \$\{product\.title\}`\}<\/span>/.test(extras), true);

done();
