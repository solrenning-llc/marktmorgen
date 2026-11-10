import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CollectionsEditor } from "@/components/collections-editor";
import { done, is, part } from "./check";

const router = { bfcacheId: "collection-target-fixture", back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const draw = (products: string[]) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, createElement(CollectionsEditor, {
  handle: "fixture-store",
  collections: [{ id: "abcd1234", title: "Guides", blurb: "Read at your own pace.", products }],
  products: [{ id: "product1", title: "First guide" }, { id: "product2", title: "Second guide" }],
})));
const html = draw(["product1", "product2"]);
const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map(match => match[1]);

part("Collection product controls keep full size even when moving is unavailable");
for (const label of ["Move First guide up", "Take First guide out", "Move Second guide up", "Take Second guide out"]) {
  const found = buttons.filter(attributes => attributes.includes(`aria-label="${label}"`));
  is(`${label} has one named control`, found.length, 1);
  is(`${label} provides a 44px target in both directions`, !!found[0] && /\bh-11\b/.test(found[0]) && /\bw-11\b/.test(found[0]), true);
}
is("the first product still cannot move above the list", buttons.find(attributes => attributes.includes('aria-label="Move First guide up"'))?.includes('disabled=""'), true);
is("the next product waits for its handler on the server", buttons.find(attributes => attributes.includes('aria-label="Move Second guide up"'))?.includes('disabled=""'), true);
is("server-rendered editing controls wait for hydration", buttons.every(attributes => attributes.includes('disabled=""')), true);
is("the collection page keeps its saved id", html.includes("guides-abcd1234"), true);
is("empty collections offer no phantom product actions", /aria-label="(?:Move|Take) /.test(draw([])), false);
done();
