/** Reviewer 3 C79: a bundle's outer disclosure already names its region. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BundleDelivery, type BundleLine } from "@/components/bundle-delivery";

const lines: BundleLine[] = [{ product: { id: "book", title: "A book", link: null }, download: "/download/book", course: null }];
const props = { lines, missing: 0, storeName: "Book Studio", heading: "Inside the book bundle" };

test("forty bundle disclosures have one named region each, with none added by their delivery list", () => {
  const html = renderToStaticMarkup(createElement("main", null, Array.from({ length: 40 }, (_, i) => createElement("section", { key: i, "aria-labelledby": `bundle-${i}` },
    createElement("h2", { id: `bundle-${i}` }, props.heading),
    createElement(BundleDelivery, { ...props, showHeading: false }),
  ))));
  assert.equal((html.match(/<section\b/g) ?? []).length, 40, "each outer disclosure is the only region for that bundle");
  assert.equal((html.match(/<ul\b/g) ?? []).length, 40, "every delivery list remains available");
  assert.equal((html.match(/href="\/download\/book"/g) ?? []).length, 40, "every download remains available");
  assert.ok(!html.includes(`aria-label="${props.heading}"`), "no repeated inner region name");
});

test("standalone delivery keeps its named region and visible heading by default and with showHeading=true", () => {
  for (const showHeading of [undefined, true]) {
    const html = renderToStaticMarkup(createElement(BundleDelivery, { ...props, showHeading }));
    assert.ok(html.startsWith(`<section class="mt-6" aria-label="${props.heading}">`));
    assert.ok(html.includes(`<p class="st-label">${props.heading}</p>`));
    assert.ok(html.includes('href="/download/book"'));
  }
});

test("delivery under an existing heading keeps its empty and missing-product explanations without a second region", () => {
  const html = renderToStaticMarkup(createElement(BundleDelivery, { ...props, lines: [], missing: 1, showHeading: false }));
  assert.ok(html.startsWith('<div class="mt-6">'));
  assert.ok(!html.includes("<section") && !html.includes("aria-label") && !html.includes(props.heading));
  assert.ok(html.includes("One product of this bundle is no longer in Book Studio"));
});
