import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ShippingEditor } from "@/components/shipping-editor";
import type { Product } from "@/lib/store";
import { done, is, part } from "./check";

const router = {
  bfcacheId: "shipping-hydration-fixture",
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

const product = (shipping: Product["shipping"]): Product =>
  ({
    id: "physical_1",
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

const draw = (shipping: Product["shipping"]) =>
  renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(ShippingEditor, { product: product(shipping) }),
    ),
  );

const control = (html: string, visible: string) =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map((match) => match[0])
    .find((button) => button.includes(visible)) ?? "";

function unavailable(button: string, label: string): void {
  is(`${label} keeps one server-rendered control`, button.length > 0, true);
  is(`${label} is natively unavailable before hydration`, /\sdisabled(="")?/.test(button), true);
  is(`${label} exposes its unavailable state`, button.includes('aria-disabled="true"'), true);
  is(`${label} does not override its visible accessible name`, button.includes("aria-label="), false);
  is(`${label} visibly keeps its action while Loading`, button.includes(`>${label} — Loading…</`), true);
}

part("Physical-shipping controls are honest before hydration");
const add = draw(null);
unavailable(control(add, "Ship it: a physical product, sent by you"), "Ship it: a physical product, sent by you");
is("the add control does not draw a false open form", add.includes("<form"), false);

const existing = draw({ cents: 500, region: "us", countries: ["US"], note: "Ships tomorrow", sku: "Harbor-01" });
unavailable(control(existing, "Change"), "Change");
unavailable(control(existing, "Stop shipping it"), "Stop shipping it");
is("the saved-shipping controls do not draw a false open form", existing.includes("<form"), false);

done();
