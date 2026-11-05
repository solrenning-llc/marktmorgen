import { reconcileSupplierInvoiceEvidence } from "../lib/company-supplier-reconciliation";
import { done, is, part } from "./check";

const row = {
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
};

const packet = JSON.stringify({ schema: 1, period: "2026-10", currency: "USD", complete: true, rows: [row] });

part("Ordinary exact-schema controls");
is("an exact packet reconciles", reconcileSupplierInvoiceEvidence(packet).status, "reconciled");
is(
  "an extra root field remains unknown",
  reconcileSupplierInvoiceEvidence(JSON.stringify({ schema: 1, period: "2026-10", currency: "USD", complete: true, rows: [row], extra: 0 })).status,
  "unknown",
);

part("Conflicting duplicate JSON members are malformed evidence");
const duplicateRoot = packet.replace('"complete":true', '"complete":false,"complete":true');
is(
  "a conflicting duplicate completeness member remains unknown",
  reconcileSupplierInvoiceEvidence(duplicateRoot).status,
  "unknown",
);

const duplicateAmount = packet.replace('"invoicedCents":1250', '"invoicedCents":999999,"invoicedCents":1250');
is(
  "a conflicting duplicate amount member remains unknown",
  reconcileSupplierInvoiceEvidence(duplicateAmount).status,
  "unknown",
);

done();
