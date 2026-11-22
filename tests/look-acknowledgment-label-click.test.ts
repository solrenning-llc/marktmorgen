/**
 * The appearance-editor acknowledgment check (tests/e2e/look-acknowledgment.mjs) chooses the theme by its visible
 * label, never by a forced click on the hidden radio. The theme radios are `.sr-only` (1 px, clipped) inside their
 * labels; a forced click is sent to the radio's own box, and in WebKit at 1280 px it did not land on the label, so
 * the radio stayed off and Playwright threw "Clicking the checkbox did not change its state" (merge-queue runs of
 * #5073 at 04:25 UTC and #4164 at 04:52 UTC on 22 November 2026, jobs 137090949323 and 137097272731). A creator
 * clicks the label; the check does the same, then reads the radio's state, and no wait changes.
 *
 * The test reads the harness source: no browser, network or page.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("tests/e2e/look-acknowledgment.mjs", "utf8");

test("the theme is chosen by its visible label, as a creator does", () => {
  assert.match(source, /section\.locator\('label:has\(input\[name="theme"\]\[value="night"\]\)'\)\.click\(\)/);
});

test("the hidden theme radio is never checked by force", () => {
  assert.doesNotMatch(source, /theme\.check\(\s*\{\s*force\s*:\s*true\s*\}\s*\)/);
  assert.doesNotMatch(source, /\.check\(\s*\{\s*force\s*:\s*true\s*\}\s*\)/);
});

test("the radio's own state is read after the label click, per width", () => {
  assert.match(source, /is\("look theme chosen by its label "\+width,await theme\.isChecked\(\),true\)/);
});

test("the check still reads the night theme through the radio for the draft-retained checks", () => {
  assert.match(source, /const theme=section\.locator\('input\[name="theme"\]\[value="night"\]'\)/);
  assert.match(source, /is\("look draft retained "\+name,await theme\.isChecked\(\),true\)/);
});

test("no wait was added or changed", () => {
  assert.equal((source.match(/waitForTimeout/g) ?? []).length, 0);
  assert.equal((source.match(/timeout:60000/g) ?? []).length, 1);
});
