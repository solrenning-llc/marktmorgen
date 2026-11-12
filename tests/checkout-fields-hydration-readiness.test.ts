import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CheckoutFieldsEditor } from "@/components/checkout-fields-editor";
import type { Product } from "@/lib/store";
import { done, is, part } from "./check";

const router = {
  bfcacheId: "checkout-fields-hydration-fixture",
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

const product = (fields: Product["fields"], priceCents = 2500): Product => ({
  id: "synthetic_questions",
  title: "Synthetic product",
  summary: "",
  priceCents,
  createdAt: "2026-11-01T00:00:00.000Z",
  file: null,
  link: null,
  recurring: null,
  options: [],
  call: null,
  stock: null,
  bumps: [],
  funnel: null,
  plan: null,
  course: null,
  image: null,
  display: "button",
  fields,
  pwyw: null,
  about: false,
  keys: null,
  stamp: false,
  preview: 0,
  page: false,
  bundle: null,
  hidden: false,
});

const draw = (fields: Product["fields"], priceCents?: number) =>
  renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(CheckoutFieldsEditor, { product: product(fields, priceCents) }),
    ),
  );

part("Checkout-question controls are honest before hydration");
const saved: Product["fields"] = [{ label: "Size", type: "dropdown", optional: false, options: ["Small", "Large"] }];
for (const [label, fields] of [
  ["Ask the buyer something at checkout", []],
  ["Change", saved],
] as const) {
  const html = draw([...fields]);
  const controls = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
  const button = controls[0] ?? "";
  is(`${label} keeps one server-rendered control`, controls.length, 1);
  is(`${label} is natively unavailable before hydration`, /\sdisabled(="")?/.test(button), true);
  is(`${label} exposes its unavailable state`, button.includes('aria-disabled="true"'), true);
  is(`${label} does not override its visible accessible name`, button.includes("aria-label="), false);
  is(`${label} visibly keeps its action while loading`, button.includes(`>${label} — Loading…</`), true);
  is(`${label} does not draw a false open form`, html.includes("<form"), false);
}
is("existing questions remain readable while the control loads", draw(saved).includes("Size"), true);
is("a free product still offers no checkout questions", draw(saved, 0), "");
done();
