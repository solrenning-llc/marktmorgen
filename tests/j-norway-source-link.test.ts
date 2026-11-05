/** J review #2573: on 2026-11-05 the cited old currency URL redirected to
 * /en/person/to-from-norway/, a landing page without the claimed guidance.
 * The official article exists at the canonical URL below. Network evidence
 * is recorded in the review; these deterministic checks preserve that fix. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const text = readFileSync("docs/tx4-norway-voec-evidence.md", "utf8");
test("the currency evidence links to the actual official article rather than a landing-page redirect", () => {
  assert.ok(text.includes("https://www.skatteetaten.no/en/person/to-from-norway/from/conversion-foreign-currency-to-nok/"));
});
test("a general currency article does not choose the LLC's VOEC method", () => {
  assert.match(text, /não identifica por si só qual taxa[\s\S]*VOEC[\s\S]*por confirmar/);
});
test("complete compliance cost remains unknown and unfunded", () => {
  assert.match(text, /custo completo[\s\S]*desconhecido[\s\S]*nunca zero/);
  assert.match(text, /teto mensal e anual nulos[\s\S]*reserveReviewed: false/);
});
test("the evidence document passes the required change-level whitespace check", () => {
  assert.doesNotMatch(text, /[\t ]+$/m);
});
