/**
 * tests/e2e/mobile-render.mjs failed a sample in silence: the job ended with exit code 1 and no line said which page,
 * sample or target missed. The verdict lives in tests/e2e/mobile-render-verdict.mjs, with the same rule as before, and
 * every reason is named. These cases pin the rule so naming it never loosens or tightens it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sampleFailures } from "./e2e/mobile-render-verdict.mjs";

const met = { lcp: true, cls: true, interaction: true };
const clean = { writes: 0, lcp: 1380, cls: 0, interactionMs: 64, targets: met };

test("a sample that meets every target passes for both labels", () => {
  assert.deepEqual(sampleFailures(clean, "candidate"), []);
  assert.deepEqual(sampleFailures(clean, "baseline"), []);
});

test("a candidate interaction over 200 ms fails and says so", () => {
  const slow = { ...clean, interactionMs: 218, targets: { ...met, interaction: false } };
  assert.deepEqual(sampleFailures(slow, "candidate"), ["interaction target missed (218 ms, target under 200 ms)"]);
  assert.deepEqual(sampleFailures(slow, "baseline"), [], "a missed target fails only the candidate build, as before");
});

test("missed LCP and CLS targets are each named", () => {
  const late = { ...clean, lcp: 2600, cls: 0.2, targets: { lcp: false, cls: false, interaction: true } };
  assert.deepEqual(sampleFailures(late, "candidate"), [
    "lcp target missed (2600 ms, target under 2500 ms)",
    "cls target missed (0.2, target under 0.1)",
  ]);
});

test("blocked writes and unmeasured values fail every label", () => {
  const broken = { writes: 2, lcp: undefined, cls: Number.NaN, interactionMs: null, targets: met };
  const expected = ["2 blocked API writes", "LCP not measured", "CLS not measured", "interaction not measured"];
  assert.deepEqual(sampleFailures(broken, "candidate"), expected);
  assert.deepEqual(sampleFailures(broken, "baseline"), expected);
});

test("the script fails the run through the verdict and prints the reasons", async () => {
  const { readFileSync } = await import("node:fs");
  const script = readFileSync("tests/e2e/mobile-render.mjs", "utf8");
  assert.match(script, /sampleFailures\(/);
  assert.match(script, /MOBILE_RENDER_FAILURE:/);
});
