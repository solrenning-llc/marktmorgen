import assert from "node:assert/strict";
import { test } from "node:test";
import { httpsSource } from "@/lib/reviewed-https-source";

// The one rule for a reviewed tax figure's source page (lib/eu-vat-collection-cost.ts, lib/hmrc-period-rates.ts).
for (const source of [
  "https://www.trade-tariff.service.gov.uk/exchange_rates/view/2026-12",
  "https://WWW.GOV.UK/guidance/x",
  "https://gov.uk:443/x",
  "https://taxation-customs.ec.europa.eu/x?y=1#z",
  "https://xn--bcher-kva.example/x",
  "https://example.invalid/fx",
]) test(`a domain address is a source: ${source}`, () => assert.equal(httpsSource(source), true));

for (const source of [
  "https:x",
  "https:///x",
  "https://x/y",
  "https://user@gov.uk/x",
  "https://gov.uk./x",
  "https://[::1]/x",
  "https://bücher.example/x",
  // Claude 5's NIT on #5334 (7099077097): an IP literal is dotted but names no domain.
  "https://1.2.3.4/x",
  "https://1.2.3/x",
  "https://0x7f.0.0.1/x",
  "https://example.123/x",
  "http://gov.uk/x",
  "",
]) test(`not a source: ${JSON.stringify(source)}`, () => assert.equal(httpsSource(source), false));

test("a value that is not text is not a source", () => {
  for (const value of [undefined, null, 1, {}, ["https://gov.uk/x"]]) assert.equal(httpsSource(value), false);
});
