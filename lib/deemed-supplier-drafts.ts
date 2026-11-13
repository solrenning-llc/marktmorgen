/**
 * Drafts of the "refuse-consumers" records for the EU and the UK (C2-20261113-1320-ABRIR-1, 2e): what each record
 * would say once its treatment is reviewed and complete. A draft is NOT a record: DEEMED_SUPPLIER_RECORDS
 * (lib/deemed-supplier.ts) stays empty, and recording is a reviewed step the coordinator and the owner take, never a
 * code change made to pass a test. tests/deemed-supplier-drafts.test.ts holds that each draft reads as a complete
 * record under the same checks, that its files and tests exist, and that nothing here reaches the real list.
 *
 * Still open before either draft can be recorded (`open` below): paths that take a paid order from a buyer and do not
 * yet ask consumerGate. Each is a sale the "refuse-consumers" treatment must cover or show it does not need to.
 */
import type { DeemedSupplierRecord } from "@/lib/deemed-supplier";

const IMPLEMENTED_IN = [
  "lib/eu-vat-gate.ts (consumerGate, REFUSED_PLACES)",
  "lib/eu-vat-evidence.ts (the IP country and the billing country)",
  "app/api/store/checkout/route.ts",
  "app/api/store/paypal/checkout/route.ts",
  "app/api/store/cart/route.ts",
  "components/billing-country-field.tsx",
].join("; ");

const EVIDENCE = ["tests/eu-vat-consumer-gate.test.ts", "tests/eu-vat-checkout-routes.test.ts"].join("; ");

export const REFUSE_CONSUMERS_DRAFTS: readonly DeemedSupplierRecord[] = [
  { jurisdiction: "EU", treatment: "refuse-consumers", implementedIn: IMPLEMENTED_IN, recordedOn: "2026-11-13", registration: "", evidence: EVIDENCE },
  { jurisdiction: "UK", treatment: "refuse-consumers", implementedIn: IMPLEMENTED_IN, recordedOn: "2026-11-13", registration: "", evidence: EVIDENCE },
];

/** The paid paths a buyer can still reach without consumerGate: each must be gated, or shown not to need it. */
export const REFUSE_CONSUMERS_OPEN: readonly string[] = [
  "payment requests (lib/payment-requests.ts): free text, kind not readable; awaiting the coordinator's answer",
  "store tips (lib/store-tip-checkout.ts): not a supply for consideration; awaiting the coordinator's answer",
  "call bookings and call packages (lib/calls.ts, lib/call-packages.ts): live services, outside art. 9a, to be shown so in a test",
  "sales blocks and the embedded card (components/sales-blocks.tsx, app/embed): sent to the product page, where the field is asked",
];
