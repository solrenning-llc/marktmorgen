/**
 * Drafts of the "refuse-consumers" records for the EU and the UK (C2-20261113-1320-ABRIR-1, 2e): what each record
 * would say once its treatment is reviewed and complete. A draft is NOT a record: DEEMED_SUPPLIER_RECORDS
 * (lib/deemed-supplier.ts) stays empty, and recording is a reviewed step the coordinator and the owner take, never a
 * code change made to pass a test. tests/deemed-supplier-drafts.test.ts holds that each draft reads as a complete
 * record under the same checks, that its files and tests exist, and that nothing here reaches the real list.
 *
 * Paths that take a paid order from a buyer and do not yet ask consumerGate are listed in REFUSE_CONSUMERS_OPEN below:
 * each is a sale the "refuse-consumers" treatment must cover or show it does not need to. None since 789 [IV1] unit 1.
 */
import type { DeemedSupplierRecord } from "@/lib/deemed-supplier";

const IMPLEMENTED_IN = [
  "lib/eu-vat-gate.ts (consumerGate, REFUSED_PLACES)",
  "lib/eu-vat-evidence.ts (the IP country and the billing country)",
  "app/api/store/checkout/route.ts",
  "app/api/store/paypal/checkout/route.ts",
  "app/api/store/cart/route.ts",
  "app/api/store/pay-request/route.ts",
  "app/api/store/tip/route.ts",
  "components/billing-country-field.tsx",
  "lib/upsell.ts (offerGate)",
  "lib/eu-vat-goods.ts (vatShipCloses)",
  "lib/physical-legal-ship.ts (shippingNow)",
].join("; ");

const EVIDENCE = ["tests/eu-vat-consumer-gate.test.ts", "tests/eu-vat-checkout-routes.test.ts", "tests/eu-vat-pay-request-gate.test.ts", "tests/eu-vat-tip-gate.test.ts", "tests/eu-vat-open-paths.test.ts", "tests/eu-vat-upsell-gate.test.ts", "tests/eu-vat-goods.test.ts"].join("; ");

export const REFUSE_CONSUMERS_DRAFTS: readonly DeemedSupplierRecord[] = [
  { jurisdiction: "EU", treatment: "refuse-consumers", implementedIn: IMPLEMENTED_IN, recordedOn: "2026-11-13", registration: "", evidence: EVIDENCE },
  { jurisdiction: "UK", treatment: "refuse-consumers", implementedIn: IMPLEMENTED_IN, recordedOn: "2026-11-13", registration: "", evidence: EVIDENCE },
];

/**
 * The paid paths a buyer can still reach without consumerGate: each must be gated, or shown not to need it. Empty since
 * 789 [IV1] unit 1 closed its last one, physical goods shipped to an EU or UK address (lib/eu-vat-goods.ts,
 * vatShipCloses, read by lib/physical-legal-ship.ts shippingNow for both checkouts; PayPal sells nothing shipped,
 * lib/paypal-sales.ts sellsWithPayPal). A path found later is added here at once.
 */
export const REFUSE_CONSUMERS_OPEN: readonly string[] = [];
