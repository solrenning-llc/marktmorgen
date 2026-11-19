/**
 * Art. 9a lock 3, jurisdiction "other", unit 3 (C5-20261119-1625-9a-other, conditions 1 to 4): the "threshold"
 * treatment at checkout. What fails here:
 *   - "threshold" is accepted for the EU, the UK or the US, or anything sells under it without a count;
 *   - a sale goes ahead at or above 90% of the local threshold, with this sale reserved (condition 1);
 *   - a sale goes ahead without a reviewed ceiling rate or scope (condition 2), or the counter is asked when the
 *     answer can only be a refusal;
 *   - a sale goes ahead whose reservation was not confirmed, or a refused sale keeps its reservation (condition 3);
 *   - anything opens: DEEMED_SUPPLIER_RECORDS and PLANS_ON_SALE stay as they are (condition 4).
 * Synthetic only: the records, rates, reviews and counter below are made up and are never the reviewed ones.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OTHER_COUNTRY_LEDGER, OTHER_COUNTRY_SAFETY_PERCENT, thresholdCheckoutDecision, thresholdCheckoutDecisionUnder,
  type PlaceSalesCounter,
} from "@/lib/other-country-checkout";
import { DEEMED_SUPPLIER_RECORDS, deemedSupplierProblems, recordedTreatment, type DeemedSupplierRecord } from "@/lib/deemed-supplier";
import { REFUSAL_WORDS, checkoutLocationDecision } from "@/lib/jurisdiction-refusal-rules";
import { otherCountryWindowStart, type OtherCountryReviews } from "@/lib/other-country-snapshot";
import { PLANS_ON_SALE } from "@/lib/opening";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const SOURCE = "https://example.test/synthetic-rate";
// Synthetic: 1 USD at most 1.5 CAD and 12 NOK.
const REVIEWS: OtherCountryReviews = {
  fx: [
    { from: "USD", to: "CAD", numerator: 3, denominator: 2, source: SOURCE, checkedOn: "2026-11-01", validThrough: "2026-11-30" },
    { from: "USD", to: "NOK", numerator: 12, denominator: 1, source: SOURCE, checkedOn: "2026-11-01", validThrough: "2026-11-30" },
  ],
  scopes: [
    { ruleId: "ca-specified-supplies", evidence: "synthetic review", reviewedOn: "2026-11-01", validThrough: "2026-12-31" },
    { ruleId: "no-remote-services", evidence: "synthetic review", reviewedOn: "2026-11-01", validThrough: "2026-12-31" },
  ],
};
const NO_REVIEWS: OtherCountryReviews = { fx: [], scopes: [] };

const record = (jurisdiction: DeemedSupplierRecord["jurisdiction"], treatment: DeemedSupplierRecord["treatment"]): DeemedSupplierRecord => ({
  jurisdiction, treatment, implementedIn: "lib/other-country-checkout.ts", recordedOn: "2026-11-19",
  registration: treatment === "collect" ? "synthetic registration, never real" : "", evidence: "tests/other-country-checkout.test.ts",
});
const RECORDS = [record("EU", "collect"), record("UK", "collect"), record("US", "collect"), record("other", "threshold")];
const at = (country: string) => ({ ipCountry: country, billingCountry: country });

// placeTotals("store-sales", place, since, now) as Claude 4's lib/place-sales.ts answers it (7020577795).
const totals = (country: string, currency: string, settledMinor: number, reservedMinor: number) => ({
  place: { country, state: null }, fromMonth: "2025-10", toMonth: "2026-11", countingSince: "2025-01", complete: true,
  currencies: { [currency]: { settledMinor, reservedMinor } },
});

type Fake = { reserve?: "reserved" | "refused" | "unknown" | "throw"; totals?: unknown; release?: boolean | "throw" };
function fake(options: Fake = {}) {
  const calls: unknown[][] = [];
  const port: PlaceSalesCounter = {
    async reserve(sale) {
      calls.push(["reserve", sale]);
      if (options.reserve === "throw") throw new Error("synthetic counter down");
      return options.reserve ?? "reserved";
    },
    async totals(ledger, place, since, now) {
      calls.push(["totals", ledger, place, since, now]);
      if (options.totals === "throw") throw new Error("synthetic counter down");
      return options.totals;
    },
    async release(ledger, ref) {
      calls.push(["release", ledger, ref]);
      if (options.release === "throw") throw new Error("synthetic counter down");
      return options.release ?? true;
    },
  };
  return { port, calls, names: () => calls.map((call) => call[0]) };
}
const SALE = { currency: "CAD", amountMinor: 100, ref: "cs_synthetic_1" };
const refused = (jurisdictions: string[] = ["other"]) => ({
  allowed: false, reason: "refused-jurisdiction", jurisdictions, buyerMessage: REFUSAL_WORDS["refused-jurisdiction"],
});

test("'threshold' is a treatment for 'other' only", () => {
  assert.deepEqual(deemedSupplierProblems(RECORDS), []);
  assert.equal(recordedTreatment("other", RECORDS), "threshold");
  for (const jurisdiction of ["EU", "UK", "US"] as const) {
    const records = RECORDS.map((row) => (row.jurisdiction === jurisdiction ? record(jurisdiction, "threshold") : row));
    assert.deepEqual(deemedSupplierProblems(records), [`${jurisdiction}: treatment`]);
    assert.equal(recordedTreatment(jurisdiction, records), null);
  }
});

test("the pure gate never sells under 'threshold': it asks for the count, and refuses meanwhile", () => {
  const decision = checkoutLocationDecision(at("CA"), RECORDS);
  assert.deepEqual(decision, {
    allowed: false, reason: "count-needed", jurisdictions: ["other"], country: "CA", buyerMessage: REFUSAL_WORDS["refused-jurisdiction"],
  });
  assert.equal(REFUSAL_WORDS["count-needed"], REFUSAL_WORDS["refused-jurisdiction"]);
  // A territory that may also be the EU's is counted under "other" too, with the EU collecting.
  assert.equal((checkoutLocationDecision(at("MC"), RECORDS) as { reason?: string }).reason, "count-needed");
  // The EU, the UK and the US are as before.
  assert.deepEqual(checkoutLocationDecision(at("DE"), RECORDS), { allowed: true, jurisdictions: ["EU"] });
  // "refuse-consumers" for "other" still refuses outright.
  const refusing = RECORDS.map((row) => (row.jurisdiction === "other" ? record("other", "refuse-consumers") : row));
  assert.deepEqual(checkoutLocationDecision(at("CA"), refusing), refused());
});

test("production: nothing recorded, nothing reviewed, nothing counted, nothing sold", async () => {
  const counter = fake();
  assert.deepEqual(await thresholdCheckoutDecision(at("CA"), SALE, counter.port, NOW), {
    allowed: false, reason: "not-recorded", jurisdictions: [], buyerMessage: REFUSAL_WORDS["not-recorded"],
  });
  // Even with synthetic records, the file's own reviewed rates and scopes are empty: refused before the counter.
  assert.deepEqual(await thresholdCheckoutDecisionUnder(NO_REVIEWS, at("CA"), SALE, counter.port, RECORDS, NOW), refused());
  assert.deepEqual(counter.calls, []);
  assert.deepEqual(DEEMED_SUPPLIER_RECORDS, []);
  // OPENING_REQUESTED is private to lib/opening.ts and untouched here; PLANS_ON_SALE reads it.
  assert.equal(PLANS_ON_SALE, false);
});

test("condition 1: below 90% of the threshold with this sale reserved sells; at 90% it refuses and releases", async () => {
  assert.equal(OTHER_COUNTRY_SAFETY_PERCENT, 90);
  // Canada: CAD 30,000.00 = 3,000,000 minor; 90% = 2,700,000. The counter's totals already hold this sale as reserved.
  const below = fake({ totals: totals("CA", "CAD", 2_699_899, 100) });
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), SALE, below.port, RECORDS, NOW), {
    allowed: true, jurisdictions: ["other"], reservation: { ledger: "store-sales", ref: "cs_synthetic_1" },
  });
  assert.deepEqual(below.calls, [
    ["reserve", { ledger: "store-sales", place: { country: "CA", state: null }, currency: "CAD", amountMinor: 100, ref: "cs_synthetic_1", at: NOW }],
    ["totals", "store-sales", { country: "CA", state: null }, otherCountryWindowStart("ca-specified-supplies", NOW), NOW],
  ]);
  const at90 = fake({ totals: totals("CA", "CAD", 2_699_900, 100) });
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), SALE, at90.port, RECORDS, NOW), refused());
  assert.deepEqual(at90.names(), ["reserve", "totals", "release"]);
  assert.deepEqual(at90.calls[2], ["release", "store-sales", "cs_synthetic_1"]);
  // Norway: NOK 50,000.00 = 5,000,000 minor; 90% = 4,500,000. USD at the ceiling of 12 NOK.
  const norway = (settledUsd: number) => fake({ totals: totals("NO", "USD", settledUsd, 100) });
  const sale = { currency: "USD", amountMinor: 100, ref: "cs_synthetic_2" };
  assert.equal((await thresholdCheckoutDecisionUnder(REVIEWS, at("NO"), sale, norway(374_899).port, RECORDS, NOW)).allowed, true);
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("NO"), sale, norway(374_900).port, RECORDS, NOW), refused());
});

test("a sale that alone reaches 90% is refused without asking the counter", async () => {
  const counter = fake({ totals: totals("CA", "CAD", 0, 2_700_000) });
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), { ...SALE, amountMinor: 2_700_000 }, counter.port, RECORDS, NOW), refused());
  assert.deepEqual(counter.calls, []);
});

test("condition 2: no reviewed rate for the sale's currency, or an expired one, refuses before the counter", async () => {
  const euros = fake({ totals: totals("CA", "EUR", 0, 100) });
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), { ...SALE, currency: "EUR" }, euros.port, RECORDS, NOW), refused());
  const expired = fake();
  const december = Date.parse("2026-12-01T12:00:00Z");
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), { ...SALE, currency: "USD" }, expired.port, RECORDS, december), refused());
  assert.deepEqual([...euros.calls, ...expired.calls], []);
  // A counted currency with no reviewed rate makes the count unknown: refused, and the reservation released.
  const mixed = fake({ totals: { ...totals("CA", "CAD", 0, 100), currencies: { CAD: { settledMinor: 0, reservedMinor: 100 }, EUR: { settledMinor: 1, reservedMinor: 0 } } } });
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), SALE, mixed.port, RECORDS, NOW), refused());
  assert.deepEqual(mixed.names(), ["reserve", "totals", "release"]);
});

test("condition 3: an unconfirmed reservation refuses; every refusal after reserving releases", async () => {
  // "refused": nothing was reserved under this ref, and releasing it could free another sale's reservation.
  const refusing = fake({ reserve: "refused" });
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), SALE, refusing.port, RECORDS, NOW), refused());
  assert.deepEqual(refusing.names(), ["reserve"]);
  // "unknown": the counter could not say whether it reserved, so it may exist: released, idempotently, and refused
  // (Claude 4's and Claude 3's LOW on #4908).
  const unsure = fake({ reserve: "unknown" });
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), SALE, unsure.port, RECORDS, NOW), refused());
  assert.deepEqual(unsure.names(), ["reserve", "release"]);
  assert.deepEqual(unsure.calls[1], ["release", "store-sales", "cs_synthetic_1"]);
  // A reservation that threw may or may not exist: released, idempotently, and refused.
  const threw = fake({ reserve: "throw" });
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), SALE, threw.port, RECORDS, NOW), refused());
  assert.deepEqual(threw.names(), ["reserve", "release"]);
  for (const answer of [null, "throw", { ...totals("CA", "CAD", 0, 100), complete: false }, totals("NO", "CAD", 0, 100)]) {
    const counter = fake({ totals: answer });
    assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), SALE, counter.port, RECORDS, NOW), refused());
    assert.deepEqual(counter.names(), ["reserve", "totals", "release"]);
  }
  // A release that fails still refuses: the reservation left behind only counts against later sales.
  for (const release of [false, "throw"] as const) {
    const counter = fake({ totals: totals("CA", "CAD", 2_699_900, 100), release });
    assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), SALE, counter.port, RECORDS, NOW), refused());
  }
});

test("only Canada and Norway are counted; every other country under 'other' refuses without the counter", async () => {
  for (const country of ["CH", "BR", "AU", "XK", "MC"]) {
    const counter = fake({ totals: totals(country, "CAD", 0, 100) });
    const decision = await thresholdCheckoutDecisionUnder(REVIEWS, at(country), SALE, counter.port, RECORDS, NOW);
    assert.equal(decision.allowed, false, country);
    assert.equal((decision as { reason: string }).reason, "refused-jurisdiction", country);
    assert.deepEqual(counter.calls, [], country);
  }
});

test("a malformed sale or clock refuses without the counter", async () => {
  const bad: unknown[] = [
    { ...SALE, amountMinor: 0 }, { ...SALE, amountMinor: -1 }, { ...SALE, amountMinor: 1.5 }, { ...SALE, currency: "cad" },
    { ...SALE, ref: "" }, { ...SALE, ref: 7 }, { currency: "CAD", amountMinor: 100 }, null,
    Object.defineProperty({ currency: "CAD", ref: "cs_synthetic_1" }, "amountMinor", { get: () => 100, enumerable: true }),
  ];
  for (const sale of bad) {
    const counter = fake({ totals: totals("CA", "CAD", 0, 100) });
    assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), sale, counter.port, RECORDS, NOW), refused());
    assert.deepEqual(counter.calls, []);
  }
  const counter = fake({ totals: totals("CA", "CAD", 0, 100) });
  assert.deepEqual(await thresholdCheckoutDecisionUnder(REVIEWS, at("CA"), SALE, counter.port, RECORDS, Number.NaN), refused());
  assert.deepEqual(counter.calls, []);
});

test("the ledger is the stores' sales, never the plans", () => {
  assert.equal(OTHER_COUNTRY_LEDGER, "store-sales");
});
