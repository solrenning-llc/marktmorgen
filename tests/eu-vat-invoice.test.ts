/**
 * EU VAT under art. 9a, unit 1 (IVA, 14/11/2026): the invoice of an EU sale carries every detail of Directive
 * 2006/112/EC art. 226 (legislation.gov.uk/eudr/2006/112/article/226, read 14/11/2026), whole or none; a collected sale
 * needs the OSS number EUxxxyyyyyz of the Member State of identification (empty until the owner registers, so no
 * collected sale can be invoiced), and states its VAT in euro at the ECB rate of the sale (arts. 230 and 91(2)); a
 * reverse-charged one carries the customer's number and the mention "Reverse charge" (art. 226(11a)) and no VAT.
 * Synthetic only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ECB_REFERENCE_RATES, REVERSE_CHARGE_MENTION, euInvoice, toEuroCents, type EuInvoiceInput } from "@/lib/eu-vat-invoice";

const day = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const seller = { name: "Example Platform LLC", address: "1 Example Street, Dover, DE 19901", country: "US", oss: { memberState: "IE", vatNumber: "EU372000001" } };
const customer = { name: "Erika Beispiel", address: "Beispielweg 1, 10115 Berlin", country: "DE" };
const collect: EuInvoiceInput = {
  kind: "collect", number: "MM-EU-2026-000001", issuedAt: day("2026-11-14T12:00:00Z"), suppliedAt: day("2026-11-14T11:59:00Z"),
  seller, customer, service: "Recorded course: Example (electronically supplied service)", currency: "EUR", taxableCents: 1000,
  vat: { priceCents: 1000, vatCents: 190, totalCents: 1190, basisPoints: 1900, country: "DE" },
};

test("a collected sale's invoice holds every art. 226 detail and its VAT in euro", () => {
  assert.deepEqual(euInvoice(collect), {
    kind: "collect", number: "MM-EU-2026-000001", issuedOn: "2026-11-14", suppliedOn: null,
    seller: { name: seller.name, address: seller.address, country: "US", vatNumber: "EU372000001" },
    customer: { ...customer, vatNumber: null },
    service: collect.service, quantity: 1, currency: "EUR", unitPriceCents: 1000, taxableCents: 1000,
    rateBasisPoints: 1900, vatCents: 190, totalCents: 1190,
    vatNational: { currency: "EUR", cents: 190, perEuro: null, day: null, source: null },
    mentions: [],
  });
});

test("until the owner's OSS registration is configured, no collected sale can be invoiced", () => {
  for (const oss of [{ memberState: "IE", vatNumber: "" }, { memberState: "", vatNumber: "" }, { memberState: "IE", vatNumber: "EU276000001" }, { memberState: "IE", vatNumber: "EU37200001" },
    { memberState: "IE", vatNumber: "IE1234567X" }, { memberState: "DE", vatNumber: "EU276000001" }]) {
    assert.equal(euInvoice({ ...collect, seller: { ...seller, oss } }), null, JSON.stringify(oss));
  }
});

test("in another currency the VAT is also stated in euro at a recent ECB rate, rounded half up once", () => {
  const usd = { ...collect, currency: "USD", ecb: { perEuro: "1.1606", day: "2026-11-13" } };
  const invoice = euInvoice(usd);
  assert.deepEqual(invoice?.vatNational, { currency: "EUR", cents: 164, perEuro: "1.1606", day: "2026-11-13", source: ECB_REFERENCE_RATES });
  assert.equal(euInvoice({ ...collect, currency: "USD" }), null, "no rate, no invoice");
  assert.equal(euInvoice({ ...collect, currency: "USD", ecb: { perEuro: "1.1606", day: "2026-11-15" } }), null, "a rate after the sale");
  assert.equal(euInvoice({ ...collect, currency: "USD", ecb: { perEuro: "1.1606", day: "2026-11-01" } }), null, "a rate too old");
  assert.equal(euInvoice({ ...collect, currency: "USD", ecb: { perEuro: "abc", day: "2026-11-13" } }), null);
  for (const impossible of ["2026-13-01", "2026-11-31", "2026-02-30"]) {
    assert.equal(euInvoice({ ...collect, currency: "USD", ecb: { perEuro: "1.1606", day: impossible } }), null, `${impossible} is no day, and never a throw`);
  }
  assert.equal(euInvoice({ ...collect, currency: "JPY" }), null, "minor units other than hundredths are not modelled");
});

test("toEuroCents converts in integers, half up", () => {
  assert.equal(toEuroCents(190, "1.1606"), 164); // 163.71
  assert.equal(toEuroCents(100, "2"), 50);
  assert.equal(toEuroCents(1, "2"), 1); // 0.5 rounds up
  assert.equal(toEuroCents(3, "2"), 2); // 1.5 rounds up
  assert.equal(toEuroCents(0, "1.1606"), 0);
  assert.equal(toEuroCents(1_900_000_000, "25.123456"), 75_626_538);
  for (const bad of ["0", "-1", "1.1234567", "1e3", "", " 1.2"]) assert.equal(toEuroCents(100, bad), null, bad);
  assert.equal(toEuroCents(-1, "1"), null);
  assert.equal(toEuroCents(1.5, "1"), null);
});

test("a reverse-charged sale names the business's number, says Reverse charge and carries no VAT", () => {
  const invoice = euInvoice({ ...collect, kind: "reverse-charge", vat: null, customer: { name: "Beispiel GmbH", address: "Beispielweg 1, 10115 Berlin", country: "DE", vatNumber: "de 123456789" } });
  assert.deepEqual(invoice, {
    kind: "reverse-charge", number: "MM-EU-2026-000001", issuedOn: "2026-11-14", suppliedOn: null,
    seller: { name: seller.name, address: seller.address, country: "US", vatNumber: null },
    customer: { name: "Beispiel GmbH", address: "Beispielweg 1, 10115 Berlin", country: "DE", vatNumber: "DE123456789" },
    service: collect.service, quantity: 1, currency: "EUR", unitPriceCents: 1000, taxableCents: 1000,
    rateBasisPoints: null, vatCents: 0, totalCents: 1000, vatNational: null, mentions: [REVERSE_CHARGE_MENTION],
  });
  assert.equal(REVERSE_CHARGE_MENTION, "Reverse charge");
  assert.equal(euInvoice({ ...collect, kind: "reverse-charge", vat: null, customer: { ...customer, vatNumber: "FR12345678901" } }), null, "another country's number");
  assert.equal(euInvoice({ ...collect, kind: "reverse-charge", customer: { ...customer, vatNumber: "DE123456789" } }), null, "VAT on a reverse charge");
  assert.equal(euInvoice({ ...collect, kind: "reverse-charge", vat: null, customer }), null, "no number");
});

test("a missing or broken detail gives no invoice, never one with a blank", () => {
  const broken: Partial<EuInvoiceInput>[] = [
    { number: "" }, { number: "has space" }, { issuedAt: 0 }, { suppliedAt: day("2026-11-15T00:00:00Z") }, { service: " " },
    { currency: "eur" }, { taxableCents: 0 }, { taxableCents: 10.5 },
    { customer: { ...customer, address: "" } }, { customer: { ...customer, name: "" } }, { customer: { ...customer, country: "US" } },
    { seller: { ...seller, address: "" } },
    { vat: null }, { vat: { priceCents: 999, vatCents: 190, totalCents: 1189, basisPoints: 1900, country: "DE" } },
    { vat: { priceCents: 1000, vatCents: 190, totalCents: 1190, basisPoints: 1900, country: "FR" } },
    { vat: { priceCents: 1000, vatCents: 190, totalCents: 1191, basisPoints: 1900, country: "DE" } },
  ];
  for (const change of broken) assert.equal(euInvoice({ ...collect, ...change } as EuInvoiceInput), null, JSON.stringify(change));
  // The supply date is printed only when it differs from the date of issue (art. 226(7)).
  assert.equal(euInvoice({ ...collect, suppliedAt: day("2026-11-13T23:00:00Z") })?.suppliedOn, "2026-11-13");
});
