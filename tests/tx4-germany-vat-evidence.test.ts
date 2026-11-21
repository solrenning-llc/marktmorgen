import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION } from "../lib/llc-fixed-costs";

const read = () => readFileSync("docs/tx4-germany-vat-evidence.md", "utf8");

test("German filing evidence separates local VAT returns from the conditional non-Union OSS route", () => {
  const text = read();
  for (const source of [
    "https://www.gesetze-im-internet.de/ustg_1980/__18.html",
    "https://www.gesetze-im-internet.de/ustg_1980/__18i.html",
    "https://www.gesetze-im-internet.de/ustg_1980/__16.html",
    "https://www.elster.de/eportal/helpGlobal?themaGlobal=help_fsekapg_202501",
    "https://online.portal.bzst.de/SharedDocs/Leistungsbeschreibung/EN/besteuerungsverfahren_one-stop-shop_fuer_nicht_EU_unternehmen.html",
  ]) assert.ok(text.includes(source), source);
  assert.match(text, /2026-11-05/);
  assert.match(text, /tenth day[\s\S]*annual return/i);
  assert.match(text, /quarter[\s\S]*last day of the following month/i);
  assert.match(text, /section 18\(1\)[\s\S]*18\(4\)[\s\S]*do not apply[\s\S]*covered German supplies/i);
  assert.match(text, /does not select[\s\S]*LLC[\s\S]*registration/i);
  assert.match(text, /indexed text[\s\S]*ELSTER[\s\S]*2025/i);
});

test("German invoice and OSS records retain distinct periods, starting points and transition qualifications", () => {
  const text = read();
  for (const source of [
    "https://www.gesetze-im-internet.de/ustg_1980/__14b.html",
    "https://www.gesetze-im-internet.de/ustg_1980/__27.html",
    "https://www.gesetze-im-internet.de/ustg_1980/__22.html",
  ]) assert.ok(text.includes(source), source);
  assert.match(text, /eight years[\s\S]*end of the calendar year[\s\S]*invoice was issued/i);
  assert.match(text, /2025[\s\S]*2026[\s\S]*specified supervised institutions/i);
  assert.match(text, /ten years[\s\S]*end of the year[\s\S]*transaction/i);
  assert.match(text, /does not shorten[\s\S]*OSS[\s\S]*eight years/i);
  assert.match(text, /retention implementation[\s\S]*unchanged/i);
  assert.doesNotMatch(text, /[\t ]+$/m);
});

test("German compliance work cannot replace unknown cost with zero or a funded reserve", () => {
  const text = read();
  const cost = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(cost);
  assert.deepEqual([cost.fullMonthlyUsdCents, cost.fullAnnualUsdCents, cost.reserveReviewed], [null, null, false]);
  assert.deepEqual([LLC_FIXED_COST_ALLOCATION.marktmorgenBps, LLC_FIXED_COST_ALLOCATION.hazelsongBps], [10000, 0]);
  assert.match(text, /complete cost remains unknown, never zero/i);
  assert.match(text, /registration[\s\S]*calendar[\s\S]*currency[\s\S]*retention[\s\S]*reserve/i);
  assert.match(text, /no account, filing, payment or outside contact/i);
  assert.match(text, /Depends on the owner/);
  assert.match(text, /100% Marktmorgen/);
  assert.doesNotMatch(text, /(?:USD|EUR|US\$)\s*0(?:[.,]0+)?\b/i);
});
