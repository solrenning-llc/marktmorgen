import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ShippingEditor } from "@/components/shipping-editor";
import type { Product } from "@/lib/store";
import { done, is, part } from "./check";

const router = {
  bfcacheId: "review-q-shipping-label",
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

const product = (shipping: Product["shipping"]): Product => ({
  id: "physical_review",
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

function checkLabel(button: string, action: string): void {
  is(`${action} stays disabled before hydration`, /\sdisabled(="")?/.test(button), true);
  is(`${action} exposes aria-disabled`, attribute(button, "aria-disabled"), "true");
  const shown = visible(button);
  const name = attribute(button, "aria-label");
  is(`${action} accessible name contains its visible label`, name.toLocaleLowerCase().includes(shown.toLocaleLowerCase()), true);
}

part("Visible loading labels remain available to speech input");
checkLabel(buttons(draw(null))[0] ?? "", "Ship it");
const existing = buttons(draw({ cents: 500, region: "us", countries: ["US"], note: "Ships tomorrow", sku: "Harbor-01" }));
checkLabel(existing.find((button) => attribute(button, "aria-label") === "Change") ?? "", "Change");
checkLabel(existing.find((button) => attribute(button, "aria-label") === "Stop shipping it") ?? "", "Stop shipping it");
done();
