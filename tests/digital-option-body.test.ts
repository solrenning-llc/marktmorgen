import { test } from "node:test";
import assert from "node:assert/strict";
import { BUMP_KEYS } from "@/lib/bundle-rules";
import { digitalOptionBodyMatches } from "@/lib/digital-option-body";
const option = { id: "edition01", label: "Original PDF", priceCents: 6500, file: { pathname: "stores/synthetic/edition01/book.pdf", name: "Book.pdf", bytes: 1200, contentType: "application/pdf", addedAt: "2026-11-01T00:00:00.000Z" }, link: null, details: [], best: false };
function fixture() {
  const product = structuredClone({ options: [option] });
  const identity = { storeHandle: "original.store", productId: "product01", title: "Original book", currency: "usd", consent: "original-consent-snapshot", summary: "" };
  const name = `${identity.title} (${option.label})`;
  const form = new URLSearchParams({ mode: "payment", "metadata[store]": identity.storeHandle, "metadata[product]": identity.productId,
    "metadata[option]": option.id, "metadata[title]": name, "metadata[dc]": identity.consent,
    "line_items[0][quantity]": "1", "line_items[0][price_data][unit_amount]": "6500", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][product_data][name]": name, "payment_intent_data[metadata][dc]": identity.consent });
  return { product, identity, form, match: () => digitalOptionBodyMatches(form.toString(), product, option.id, "synthetic", identity, 60000) };
}
test("the exact selected original amount/file namespace and duplicated consent metadata agree", () => {
  const f = fixture(); assert.equal(f.match(), true);
  f.product.options[0].priceCents = 1; assert.equal(f.match(), false);
});
test("identity, currency, consent and selected line cannot be substituted", () => {
  for (const key of [...fixture().form.keys()]) {
    const f = fixture(); f.form.set(key, "replacement"); assert.equal(f.match(), false, key);
  }
});
test("coupled delivery, extra entitlement, discount and duplicate keys refuse", () => {
  for (const key of ["metadata[option]", "line_items[1][quantity]", "line_items[0][adjustable_quantity][enabled]", "line_items[0][price]", "discounts[0][coupon]", "custom_fields[0][key]", "optional_items[0][price]", "shipping_options[0][shipping_rate]", "metadata[gift]", "metadata[bundle]", "metadata[ship]"]) {
    const f = fixture(); f.form.append(key, "1"); assert.equal(f.match(), false, key);
  }
});
test("the original identity cannot execute getters or inherit its values", () => {
  const f = fixture(); let reads = 0;
  const identity = Object.defineProperty({ ...f.identity }, "currency", { get() { reads++; throw Error("no"); } });
  assert.equal(digitalOptionBodyMatches(f.form.toString(), f.product, option.id, "synthetic", identity, 60000), false);
  assert.equal(digitalOptionBodyMatches(f.form.toString(), f.product, option.id, "synthetic", Object.create(f.identity), 60000), false); assert.equal(reads, 0);
});
test("canonical byte bounds and original file owner/selection are required", () => {
  const f = fixture(), body = f.form.toString();
  for (const cap of [0, -1, NaN, Infinity, "60000", 131073, Buffer.byteLength(body) - 1]) assert.equal(digitalOptionBodyMatches(body, f.product, option.id, "synthetic", f.identity, cap), false);
  assert.equal(digitalOptionBodyMatches(body, f.product, option.id, "synthetic", f.identity, Buffer.byteLength(body)), true);
  for (const folder of ["other", undefined, "synthetic/edition01"]) assert.equal(digitalOptionBodyMatches(body, f.product, option.id, folder, f.identity, 60000), false);
  assert.equal(digitalOptionBodyMatches(body.replaceAll("+", "%20"), f.product, option.id, "synthetic", f.identity, 60000), false);
});

test("a digital option cannot silently inherit any of the three checkout bump slots", () => {
  for (const slot of BUMP_KEYS) for (const suffix of ["", "_key", "_title", "_amount", "_currency", "_product"]) {
    const f = fixture(), key = `metadata[${slot}${suffix}]`;
    f.form.set(key, "coupled-extra-entitlement");
    assert.equal(f.match(), false, key);
  }
});

test("description is bound to the original summary, including absence and substituted copies",()=>{
 const f=fixture();f.identity.summary="Original summary";f.form.set("line_items[0][price_data][product_data][description]",f.identity.summary);assert.equal(f.match(),true);
 f.form.set("line_items[0][price_data][product_data][description]","Changed summary");assert.equal(f.match(),false);
 f.form.delete("line_items[0][price_data][product_data][description]");assert.equal(f.match(),false);
 f.identity.summary="";assert.equal(f.match(),true);f.form.set("line_items[0][price_data][product_data][description]","");assert.equal(f.match(),false);
});
