/**
 * EU and UK VAT, unit 4 (IVA, 14/11/2026; coordinator, 20h50 Fortaleza: "Construa tudo pronto e desligado"): two
 * separate switches, both off. Each collects only when all of its own three hold together: its reviewed constant is
 * true, its registration is configured (the non-Union OSS number EUxxxyyyyyz of Ireland for the EU; the 9-digit VAT
 * registration number for the UK; the seller's legal name and address; the day it took effect, not in the future),
 * and the owner's commercial review names that very registration. Today every field is empty, so neither collects,
 * whatever a caller passes. Turning one on never turns on the other. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  EU_OSS_REGISTRATION, UK_VAT_REGISTRATION, VAT_COMMERCIAL_REVIEWS, VAT_SELLER, euVatCollectOn, ukVatCollectOn, vatSwitchProblems,
} from "@/lib/vat-registrations";
import { EU_VAT_COLLECT_REVIEWED, euCheckout } from "@/lib/eu-vat-checkout";
import { UK_VAT_COLLECT_REVIEWED, ukCheckout } from "@/lib/uk-vat";

const now = new Date("2027-02-01T12:00:00Z");
const seller = { legalName: "Example Platform LLC", address: "1 Example Street, Dover, DE 19901, United States" };
const eu = { memberState: "IE", vatNumber: "EU372000019", effectiveFrom: "2027-01-01" };
const uk = { vatNumber: "123456789", effectiveFrom: "2027-01-01" };
const reviews = [
  { jurisdiction: "EU", registration: "EU372000019", reviewedOn: "2027-01-15", reviewer: "owner" },
  { jurisdiction: "UK", registration: "123456789", reviewedOn: "2027-01-15", reviewer: "owner" },
];
const all = { reviewed: true, seller, eu, uk, reviews, now };

test("both reviewed constants are false and every registration field is empty today", () => {
  assert.equal(EU_VAT_COLLECT_REVIEWED, false);
  assert.equal(UK_VAT_COLLECT_REVIEWED, false);
  assert.deepEqual(EU_OSS_REGISTRATION, { memberState: "", vatNumber: "", effectiveFrom: "" });
  assert.deepEqual(UK_VAT_REGISTRATION, { vatNumber: "", effectiveFrom: "" });
  assert.deepEqual(VAT_SELLER, { legalName: "", address: "" });
  assert.deepEqual(VAT_COMMERCIAL_REVIEWS, []);
  assert.equal(euVatCollectOn(), false);
  assert.equal(ukVatCollectOn(), false);
});

test("with everything of its own, each switch is on; the problems list names what is missing", () => {
  assert.equal(euVatCollectOn(all), true);
  assert.equal(ukVatCollectOn(all), true);
  assert.deepEqual(vatSwitchProblems("EU", all), []);
  assert.deepEqual(vatSwitchProblems("EU"), [
    "EU: EU_VAT_COLLECT_REVIEWED is false",
    "EU: the seller's legal name and address are not configured",
    "EU: the non-Union OSS registration (Ireland, EUxxxyyyyyz) is not configured",
    "EU: the owner's commercial review of this registration is missing",
  ]);
  assert.deepEqual(vatSwitchProblems("UK"), [
    "UK: UK_VAT_COLLECT_REVIEWED is false",
    "UK: the seller's legal name and address are not configured",
    "UK: the 9-digit UK VAT registration number is not configured",
    "UK: the owner's commercial review of this registration is missing",
  ]);
});

test("each of the three missing keeps its switch off", () => {
  for (const change of [
    { reviewed: false }, { seller: { ...seller, legalName: "" } }, { seller: { ...seller, address: " " } },
    { eu: { ...eu, vatNumber: "" } }, { eu: { ...eu, vatNumber: "EU276000019" } }, { eu: { ...eu, memberState: "DE" } }, { eu: { ...eu, vatNumber: "EU37200001" } },
    { eu: { ...eu, effectiveFrom: "" } }, { eu: { ...eu, effectiveFrom: "2027-03-01" } }, { eu: { ...eu, effectiveFrom: "2027-02-30" } },
    { reviews: [] }, { reviews: [{ ...reviews[0], registration: "EU372000027" }] }, { reviews: [{ ...reviews[0], reviewer: "a test" }] },
    { reviews: [{ ...reviews[0], reviewedOn: "2027-03-01" }] }, { reviews: [reviews[1]] },
  ]) {
    assert.equal(euVatCollectOn({ ...all, ...change }), false, JSON.stringify(change));
  }
  for (const change of [
    { reviewed: false }, { uk: { ...uk, vatNumber: "" } }, { uk: { ...uk, vatNumber: "GB123456789" } }, { uk: { ...uk, effectiveFrom: "2027-03-01" } },
    { reviews: [reviews[0]] }, { reviews: [{ ...reviews[1], registration: "987654321" }] },
  ]) {
    assert.equal(ukVatCollectOn({ ...all, ...change }), false, JSON.stringify(change));
  }
});

test("the two switches are separate: one on never turns on the other", () => {
  assert.equal(euVatCollectOn({ ...all, uk: { vatNumber: "", effectiveFrom: "" }, reviews: [reviews[0]] }), true);
  assert.equal(ukVatCollectOn({ ...all, uk: { vatNumber: "", effectiveFrom: "" }, reviews: [reviews[0]] }), false);
  assert.equal(ukVatCollectOn({ ...all, eu: { memberState: "", vatNumber: "", effectiveFrom: "" }, reviews: [reviews[1]] }), true);
  assert.equal(euVatCollectOn({ ...all, eu: { memberState: "", vatNumber: "", effectiveFrom: "" }, reviews: [reviews[1]] }), false);
});

test("the checkouts ask their own switch when no test passes one: today an EU or UK sale is refused for review", () => {
  const rates = [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-13" }];
  const records = [{ jurisdiction: "EU", treatment: "collect", implementedIn: "lib/eu-vat-checkout.ts", recordedOn: "2026-11-14", registration: "IE OSS", evidence: "tests/vat-switches.test.ts" }];
  assert.deepEqual(euCheckout({ supply: "ess", priceCents: 1000, items: { ip: "DE", billing: "DE" }, rates, records }), { kind: "refuse", reason: "review" });
  assert.deepEqual(ukCheckout({ supply: "ess", priceCents: 1000, items: { ip: "GB", billing: "GB" }, now: new Date("2026-11-14T12:00:00Z") }), { kind: "refuse", reason: "review" });
});

test("a clock that is not a moment never throws and never turns a switch on", () => {
  const bad = new Date(Number.NaN);
  assert.equal(euVatCollectOn({ ...all, now: bad }), false);
  assert.equal(ukVatCollectOn({ ...all, now: bad }), false);
  assert.ok(vatSwitchProblems("EU", { ...all, now: bad }).length > 0);
});
