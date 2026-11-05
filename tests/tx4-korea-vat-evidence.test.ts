import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allocateEntireLlcFixedCosts, CURRENT_LLC_FIXED_COST_CEILINGS } from "../lib/llc-fixed-costs";

const path = "docs/tx4-korea-vat-evidence.md";
test("Korean evidence distinguishes current Korean law, historical translation and actual classification", () => {
  const doc = readFileSync(path, "utf8");
  for (const fact of ["Read on November 5, 2026", "Article 53-2", "January 2, 2026", "Act No. 21065", "Act No. 19194", "reference only", "20 days", "registered businesses", "third-party", "classification remains unverified"]) assert.ok(doc.includes(fact), fact);
  for (const source of ["law.go.kr/LSW/lsLawLinkInfo.do", "lsJoLnkSeq=1000920308", "elaw.klri.re.kr/eng_mobile/viewer.do?hseq=63471", "nts.go.kr/english/na/ntt/selectNttList.do?bbsId=30699"]) assert.ok(doc.includes(source), source);
});
test("Korean evidence keeps return and retention conditions separate from a universal calendar or deletion rule", () => {
  const doc = readFileSync(path, "utf8");
  for (const fact of ["Articles 48(1)-(2) and 49", "five years after the final-return deadline", "60 days after a request", "including supplies for registered businesses", "Chapter VII", "not a universal deletion date", "currency conversion", "remain unverified", "December 23, 2020"]) assert.ok(doc.includes(fact), fact);
});
test("Korean documentary evidence cannot fund unknown complete compliance costs", () => {
  const doc = readFileSync(path, "utf8");
  for (const fact of ["unknown and unreserved", "100% Marktmorgen", "TX4 remains incomplete", "No account, registration, filing, payment or external contact", "not a complete legal review"]) assert.ok(doc.includes(fact), fact);
  const line = CURRENT_LLC_FIXED_COST_CEILINGS.find(row => row.id === "vat-oss-and-local-compliance");
  assert.ok(line);
  assert.equal(line.fullMonthlyUsdCents, null);
  assert.equal(line.fullAnnualUsdCents, null);
  assert.equal(line.reserveReviewed, false);
  assert.equal(allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS), null);
});
