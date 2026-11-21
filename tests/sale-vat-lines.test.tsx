/**
 * 793 [IV3] unit 2, item 2 (b): the sale's own lines in the studio's list of sales (components/sale-vat-lines.tsx).
 * Nothing for a sale without VAT collected; the VAT and Stripe's fee on it, in words and amounts; a fee Stripe has not
 * given said in words, never 0.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SaleVatLines } from "@/components/sale-vat-lines";

const vat = { country: "DE", basisPoints: 1900, vatCents: 1900, currency: "eur", stripeFeeOnVat: { cents: 59, currency: "eur" } };

test("a sale without VAT collected draws nothing", () => {
  assert.equal(renderToStaticMarkup(<SaleVatLines vat={null} currency="eur" />), "");
  assert.equal(renderToStaticMarkup(<SaleVatLines vat={undefined} currency="eur" />), "");
});

test("the VAT collected for the tax office and Stripe's fee on it, each its own line", () => {
  const html = renderToStaticMarkup(<SaleVatLines vat={vat} currency="eur" />);
  assert.equal(html.match(/<p /g)?.length, 2);
  assert.match(html, /VAT for Germany \(19%\), collected by Marktmorgen for the tax office: €19</);
  assert.match(html, /Stripe&#x27;s fee on that VAT, which you pay: €0\.59/);
});

test("a fee not given yet is said in words, never 0", () => {
  const html = renderToStaticMarkup(<SaleVatLines vat={{ ...vat, stripeFeeOnVat: "unknown" }} currency="eur" />);
  assert.match(html, /which you pay: not known yet\./);
  assert.doesNotMatch(html, /€0\.00/);
});

test("an unreadable mark says so and points to Stripe", () => {
  assert.match(renderToStaticMarkup(<SaleVatLines vat="unreadable" currency="eur" />), /could not be read here\. You can see it in Stripe\./);
});
