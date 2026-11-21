/**
 * The "refuse-consumers" drafts for the EU and the UK (lib/deemed-supplier-drafts.ts, C2-20261113-1320-ABRIR-1 2e):
 * each reads as a complete record under lib/deemed-supplier.ts's own checks; every file and test it names exists;
 * and none of it reaches DEEMED_SUPPLIER_RECORDS, which stays empty, so sales stay closed.
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { DEEMED_SUPPLIER_RECORDS, deemedSupplierReady, recordedTreatment } from "@/lib/deemed-supplier";
import { REFUSE_CONSUMERS_DRAFTS, REFUSE_CONSUMERS_OPEN } from "@/lib/deemed-supplier-drafts";

test("each draft reads as a complete refuse-consumers record", () => {
  assert.equal(recordedTreatment("EU", REFUSE_CONSUMERS_DRAFTS), "refuse-consumers");
  assert.equal(recordedTreatment("UK", REFUSE_CONSUMERS_DRAFTS), "refuse-consumers");
});

test("every file and test a draft names exists", () => {
  for (const draft of REFUSE_CONSUMERS_DRAFTS) {
    for (const part of [...draft.implementedIn.split("; "), ...draft.evidence.split("; ")]) {
      const file = part.split(" (")[0];
      assert.equal(existsSync(file), true, `${draft.jurisdiction}: ${file}`);
    }
  }
});

test("nothing is recorded: the real list stays empty and sales stay closed", () => {
  assert.deepEqual(DEEMED_SUPPLIER_RECORDS, []);
  assert.equal(deemedSupplierReady(), false);
  assert.equal(recordedTreatment("EU"), null);
  assert.equal(recordedTreatment("UK"), null);
});

// Since 789 [IV1] unit 1 no path is open. The list is empty only because each path the queue named is closed by a
// mechanism the drafts name, so emptying it without one fails here (it said "length > 0" while paths were open).
test("the paths still open are said, not hidden: none is open, and each one closed is named", () => {
  assert.deepEqual(REFUSE_CONSUMERS_OPEN, []);
  for (const draft of REFUSE_CONSUMERS_DRAFTS) {
    for (const closer of [
      "lib/eu-vat-gate.ts (consumerGate",
      "app/api/store/pay-request/route.ts",
      "app/api/store/tip/route.ts",
      "lib/upsell.ts (offerGate)",
      "lib/eu-vat-goods.ts (vatShipCloses)",
      "lib/physical-legal-ship.ts (shippingNow)",
    ]) {
      assert.equal(draft.implementedIn.includes(closer), true, `${draft.jurisdiction}: ${closer}`);
    }
    assert.equal(draft.evidence.includes("tests/eu-vat-open-paths.test.ts"), true, draft.jurisdiction);
  }
});
