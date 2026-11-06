import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { BundleEditor, type PickerProduct } from "@/components/bundle-editor";

async function main() {
  const items: PickerProduct[] = ["Bread", "Soup", "Cake"].map((title, i) => ({
    id: `product_${i}`, title, priceCents: 1000, what: "Download", hidden: false, why: null,
  }));
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, {
    value: { refresh() {} } as never,
  }, createElement(BundleEditor, { mode: "edit", owner: { id: "bundle", title: "Recipes", priceCents: 2000 }, initial: items, currency: "usd" })));
  const buttons = [...html.matchAll(/<button\b([^>]*)>/g)]
    .map(([, attrs]) => ({ attrs, name: attrs.match(/aria-label="([^"]*)"/)?.[1] }))
    .filter((button) => /^(Move .* (up|down)|Take .* out)$/.test(button.name ?? ""));
  assert.deepEqual(buttons.map((button) => button.name), items.flatMap((item) => [
    `Move ${item.title} up`, `Move ${item.title} down`, `Take ${item.title} out`,
  ]), "the real component retains all nine named actions in product order");
  assert.deepEqual(buttons.map((button) => /\bdisabled=""/.test(button.attrs)),
    [true, false, false, false, false, false, false, true, false],
    "only moving above the first or below the last product is disabled");
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const classes = buttons.map((button) => button.attrs.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? []);
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build(classes.flat());
  assert.match(css, /--spacing:\s*0\.25rem/, "the actual stylesheet retains the quarter-rem spacing scale");
  for (const [i, tokens] of classes.entries()) {
    for (const [prefix, property] of [["h", "height"], ["w", "width"]]) {
      const token = tokens.find((value) => new RegExp(`^${prefix}-\\d+$`).test(value));
      assert.ok(token && Number(token.slice(2)) * 4 >= 44, `${buttons[i].name}: ${property} is at least 44px`);
      assert.ok(css.includes(`.${token} {`) && css.includes(`${property}: calc(var(--spacing) * ${token.slice(2)})`), `${buttons[i].name}: actual CSS emits ${property}`);
    }
  }
  console.log("Bundle controls: nine real named targets, boundary states and compiled dimensions passed");
}

void main();
