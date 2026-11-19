/**
 * EU and UK VAT, unit 4 (Codex X3's LOW on #4575, X3-20261118-1450-pr-4575.md): a checkout decides whether VAT may be
 * collected only through its whole switch (lib/vat-registrations.ts euVatCollectOn, ukVatCollectOn): the reviewed
 * constant, the registration and the owner's commercial review together. A bare `reviewed: true` from a caller, the
 * shortcut the checkouts used to take, never stands for them: with no registration and no review the sale is refused
 * for its review, as when nothing is passed. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { euCheckout } from "@/lib/eu-vat-checkout";
import { ukCheckout } from "@/lib/uk-vat";
import type { EuVatRate } from "@/lib/eu-vat-amount";

const rates: EuVatRate[] = [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-13" }];
const de = { ip: "DE", billing: "DE" };
const gb = { ip: "GB", billing: "GB" };
const collecting = [{
  jurisdiction: "EU", treatment: "collect", implementedIn: "lib/eu-vat-checkout.ts", recordedOn: "2026-11-13",
  registration: "IE OSS, 2026-11-13, EU000000000", evidence: "tests/vat-checkout-switch-whole.test.ts",
}];
const now = new Date("2026-11-14T12:00:00.000Z");
const verified = {
  vatNumber: "DE123456789",
  vies: {
    state: "valid", country: "DE", number: "123456789", askedAt: "2026-11-14T11:59:00.000Z", viesDate: "2026-11-14T11:59:00.000Z",
    error: null, name: "BEISPIEL GMBH", address: "BEISPIELWEG 1, 10115 BERLIN", requestIdentifier: null,
  },
};
/** The old shortcut, passed as a caller might still pass it: an input the checkouts no longer take. */
const shortcut = { reviewed: true } as Record<string, unknown>;

test("EU: a bare reviewed: true, with no registration and no owner's review, collects nothing", () => {
  const sale = euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting, now, ...shortcut } as Parameters<typeof euCheckout>[0]);
  assert.deepEqual(sale, { kind: "refuse", reason: "review" });
});

test("EU: nor does it give a business the reverse charge", () => {
  const sale = euCheckout({ supply: "ess", priceCents: 1000, items: de, rates, records: collecting, business: verified, now, ...shortcut } as Parameters<typeof euCheckout>[0]);
  assert.deepEqual(sale, { kind: "refuse", reason: "review" });
});

test("UK: a bare reviewed: true, with no registration and no owner's review, collects nothing", () => {
  const sale = ukCheckout({ supply: "ess", priceCents: 1000, items: gb, now, publication: false, ...shortcut } as Parameters<typeof ukCheckout>[0]);
  assert.deepEqual(sale, { kind: "refuse", reason: "review" });
});
