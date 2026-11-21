import assert from "node:assert/strict";
import { test } from "node:test";
import { vatCollectionCostOf, type VatFxAllowance } from "@/lib/eu-vat-collection-cost";

const now = new Date("2026-12-01T12:00:00Z");
const valid: VatFxAllowance = { currency: "eur", bps: 300, source: "https://example.invalid/fx", checkedOn: "2026-11-20", validThrough: "2027-03-31" };
for (const [name, patch] of [
  ["impossible review day", { checkedOn: "2026-02-31" }],
  ["impossible validity day", { validThrough: "2027-02-31" }],
  ["non-leap February 29", { checkedOn: "2025-02-29" }],
  ["HTTPS prefix without a host", { source: "https://" }],
  ["HTTPS fragment without a host", { source: "https://#source" }],
] as const) test(`unreadable allowance evidence stays unknown: ${name}`, () => {
  assert.equal(vatCollectionCostOf(10000, "eur", [{ ...valid, ...patch }], now), null);
});
test("valid dated HTTPS evidence still gives a figure, including leap day", () => {
  assert.ok(vatCollectionCostOf(10000, "eur", [valid], now));
  assert.ok(vatCollectionCostOf(10000, "eur", [{ ...valid, checkedOn: "2024-02-29" }], now));
});
