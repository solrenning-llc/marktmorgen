import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ShippingEditor } from "@/components/shipping-editor";
import type { Product } from "@/lib/store";
import { done, is, part } from "./check";

const router = {
  bfcacheId: "review-q-shipping-label-return",
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

const product = (shipping: Product["shipping"]): Product => ({
  id: "physical_review_return",
  priceCents: 2500,
  recurring: null,
  call: null,
  pwyw: null,
  plan: null,
  file: null,
  link: null,
  course: null,
  podcast: null,
  bundle: null,
  options: [],
  shipping,
}) as unknown as Product;

const draw = (shipping: Product["shipping"]) => renderToStaticMarkup(
  createElement(AppRouterContext.Provider, { value: router }, createElement(ShippingEditor, { product: product(shipping) })),
);
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
const attribute = (button: string, name: string) => button.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
const visible = (button: string) => button.replace(/<[^>]+>/g, "").trim();
const buttonFor = (html: string, action: string) => buttons(html).find((button) =>
  attribute(button, "aria-label") === action || visible(button).startsWith(action),
) ?? "";

function check(button: string, action: string): void {
  const shown = visible(button);
  const name = attribute(button, "aria-label") || shown;
  is(`${action} keeps one control`, button.length > 0, true);
  is(`${action} stays disabled before hydration`, /\sdisabled(="")?/.test(button), true);
  is(`${action} exposes aria-disabled`, attribute(button, "aria-disabled"), "true");
  is(`${action} remains in the accessible name`, name.toLocaleLowerCase().includes(action.toLocaleLowerCase()), true);
  is(`${action} accessible name contains all visible text`, name.toLocaleLowerCase().includes(shown.toLocaleLowerCase()), true);
}

part("The corrected pre-hydration labels satisfy Label in Name");
const addAction = "Ship it: a physical product, sent by you";
check(buttonFor(draw(null), addAction), addAction);
const existing = draw({ cents: 500, region: "us", countries: ["US"], note: "Ships tomorrow", sku: "Harbor-01" });
check(buttonFor(existing, "Change"), "Change");
check(buttonFor(existing, "Stop shipping it"), "Stop shipping it");
done();
