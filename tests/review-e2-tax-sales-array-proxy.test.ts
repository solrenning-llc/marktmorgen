import assert from "node:assert/strict";
import { test } from "node:test";
import { countTaxSales } from "../lib/tax-sales-counter";

test("a sales-entry array Proxy cannot hide a large settled supply", () => {
  const supply = (id: string, amountMinor: number) => ({ id, country: "US", state: "CA", currency: "USD", supplyOn: "2026-10-15", position: "settled", amountMinor, applicable: true });
  const original = [supply("kept", 1), supply("hidden", 3_000_001)];
  const entries = new Proxy(original, {
    ownKeys(target) { return Reflect.ownKeys(target).filter(key => key !== "1"); },
    getOwnPropertyDescriptor(target, key) {
      const field = Reflect.getOwnPropertyDescriptor(target, key);
      return key === "length" && field ? { ...field, value: 1 } : field;
    },
  });
  const ledger = { place: { country: "US", state: "CA" }, currency: "USD", periodStart: "2026-10-01", periodEnd: "2026-10-31", coverageFrom: "2026-10-01", coverageThrough: "2026-10-31", complete: true, entries };
  const direct = countTaxSales(ledger);
  const persisted = countTaxSales(JSON.parse(JSON.stringify(ledger)));
  console.log("SYNTHETIC_PROXY_TOTALS", JSON.stringify({ direct, persisted }));
  assert.equal(persisted.status, "known");
  assert.equal(direct.status, "unknown", "hidden entries cannot be certified as complete evidence");
});
