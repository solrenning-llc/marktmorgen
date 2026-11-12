import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPLIER_INVOICE_MAX_CHARACTERS,
  reconcileSupplierInvoiceEvidence,
} from "../lib/company-supplier-reconciliation";

const row = (overrides: Record<string, unknown> = {}) => ({
  supplier: "synthetic-mail",
  invoiceRef: "inv_alpha",
  period: "2026-10",
  currency: "USD",
  complete: true,
  invoicedCents: 1_250,
  measuredUnits: 2_000,
  registeredUnitMicros: 100_000,
  billedUnitMicros: 100_000,
  registeredSubscriptionCents: 1_050,
  billedSubscriptionCents: 1_050,
  subscriptionUsed: true,
  ...overrides,
});

const packet = (rows: unknown[]) => JSON.stringify({
  schema: 1,
  period: "2026-10",
  currency: "USD",
  complete: true,
  rows,
});

test("reconciles a complete monthly supplier packet without inventing exceptions", () => {
  const result = reconcileSupplierInvoiceEvidence(packet([row()]));
  assert.equal(result.status, "reconciled");
  assert.equal(result.supplierCount, 1);
  assert.deepEqual(result.totals, {
    invoicedCents: 1_250,
    registeredExpectedCents: 1_250,
    billedExpectedCents: 1_250,
  });
  assert.deepEqual(result.observations, {
    duplicateInvoices: 0,
    unusedSubscriptions: 0,
    aboveMeasuredUsage: 0,
    priceIncreases: 0,
  });
});

test("keeps four supplier exceptions separate and includes duplicated charges in the invoice total", () => {
  const duplicate = row({ subscriptionUsed: false });
  const result = reconcileSupplierInvoiceEvidence(packet([
    duplicate,
    duplicate,
    row({
      supplier: "synthetic-storage",
      invoiceRef: "inv_beta",
      invoicedCents: 1_601,
      measuredUnits: 1_000,
      registeredUnitMicros: 100_000,
      billedUnitMicros: 200_000,
      registeredSubscriptionCents: 1_300,
      billedSubscriptionCents: 1_400,
    }),
  ]));
  assert.equal(result.status, "exceptions");
  assert.deepEqual(result.observations, {
    duplicateInvoices: 1,
    unusedSubscriptions: 2,
    aboveMeasuredUsage: 1,
    priceIncreases: 1,
  });
  assert.equal(result.totals?.invoicedCents, 4_101);
});

test("known zero remains evidence while an incomplete or malformed packet remains unknown", () => {
  const zero = reconcileSupplierInvoiceEvidence(packet([row({
    invoicedCents: 0,
    measuredUnits: 0,
    registeredUnitMicros: 0,
    billedUnitMicros: 0,
    registeredSubscriptionCents: 0,
    billedSubscriptionCents: 0,
    subscriptionUsed: false,
  })]));
  assert.equal(zero.status, "reconciled");
  assert.equal(zero.totals?.invoicedCents, 0);

  for (const input of [
    null,
    { schema: 1 },
    JSON.stringify({ schema: 1, period: "2026-10", currency: "USD", complete: false, rows: [] }),
    JSON.stringify({ schema: 1, period: "2026-10", currency: "USD", complete: true, rows: [row({ extra: 0 })] }),
    "x".repeat(SUPPLIER_INVOICE_MAX_CHARACTERS + 1),
  ]) {
    assert.equal(reconcileSupplierInvoiceEvidence(input).status, "unknown");
  }
});

test("refuses period disagreement, unsafe arithmetic and unbounded rows", () => {
  const inputs = [
    packet([row({ period: "2026-09" })]),
    packet([row({ measuredUnits: Number.MAX_SAFE_INTEGER, billedUnitMicros: Number.MAX_SAFE_INTEGER })]),
    packet(Array.from({ length: 65 }, (_, index) => row({ invoiceRef: `inv_${index}` }))),
  ];
  for (const input of inputs) assert.equal(reconcileSupplierInvoiceEvidence(input).status, "unknown");
});

test("does not expose supplier invoice references and returns detached frozen evidence", () => {
  const source = packet([row()]);
  const result = reconcileSupplierInvoiceEvidence(source);
  assert.equal(JSON.stringify(result).includes("inv_alpha"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-mail"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.totals), true);
  assert.equal(Object.isFrozen(result.observations), true);
});

test("never inspects executable non-string input", () => {
  let traps = 0;
  const input = new Proxy({}, {
    get() { traps += 1; return "2026-10"; },
    ownKeys() { traps += 1; return []; },
    getOwnPropertyDescriptor() { traps += 1; return undefined; },
  });
  assert.equal(reconcileSupplierInvoiceEvidence(input).status, "unknown");
  assert.equal(traps, 0);
});

test("a conflicting duplicate root member is unknown before last-value normalization", () => {
  const valid = packet([row()]);
  assert.equal(reconcileSupplierInvoiceEvidence(valid).status, "reconciled");
  const duplicateRoot = valid.replace(
    '"complete":true',
    '"complete":false,"complete":true',
  );
  assert.equal(reconcileSupplierInvoiceEvidence(duplicateRoot).status, "unknown");
});

test("a conflicting duplicate row member is unknown before last-value normalization", () => {
  const valid = packet([row()]);
  assert.equal(reconcileSupplierInvoiceEvidence(valid).status, "reconciled");
  const duplicateRow = valid.replace(
    '"invoicedCents":1250',
    '"invoicedCents":999999,"invoicedCents":1250',
  );
  assert.equal(reconcileSupplierInvoiceEvidence(duplicateRow).status, "unknown");
});
