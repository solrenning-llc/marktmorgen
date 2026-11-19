/**
 * The studio's focus-clear rule (lib/studio-focus-clear.ts, #3757): when a control takes focus under the sticky
 * header and section bar, the page scrolls by the overlap (plus the focus ring's room), and by nothing otherwise.
 * WebKit does not apply scroll-padding-top to focus scrolling, so a focused control could stay under the bars
 * (WCAG 2.4.11 AA, 2.4.12 AAA). Chromium and Firefox already bring it clear, so the rule answers 0 there. Pure.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FOCUS_CLEAR_ROOM, focusScrollBy } from "@/lib/studio-focus-clear";

const base = { barsBottom: 124, inDialog: false, inBars: false, fromPointer: false };

test("a control under the bars scrolls the page by the overlap and the focus ring's room", () => {
  assert.equal(FOCUS_CLEAR_ROOM, 12, "124 px of bars + 12 = the 8.5rem of scroll-padding-top");
  assert.equal(focusScrollBy({ ...base, controlTop: 100 }), 100 - 124 - FOCUS_CLEAR_ROOM);
  assert.equal(focusScrollBy({ ...base, controlTop: 0 }), -136);
  assert.equal(focusScrollBy({ ...base, controlTop: -400 }), -536, "above the viewport: brought to just under the bars");
  assert.equal(focusScrollBy({ ...base, controlTop: 123.5 }), 123.5 - 136);
});

test("a control already clear of the bars never moves the page", () => {
  for (const controlTop of [124, 130, 136, 500, 5000]) assert.equal(focusScrollBy({ ...base, controlTop }), 0, String(controlTop));
});

test("never inside a dialog, never for the bars' own controls", () => {
  assert.equal(focusScrollBy({ ...base, controlTop: 10, inDialog: true }), 0);
  assert.equal(focusScrollBy({ ...base, controlTop: 10, inBars: true }), 0);
});

test("nothing when no bar is sticky (print, forced reflow) or a reading is not a number", () => {
  assert.equal(focusScrollBy({ ...base, barsBottom: null, controlTop: 10 }), 0);
  assert.equal(focusScrollBy({ ...base, barsBottom: 0, controlTop: -10 }), 0);
  assert.equal(focusScrollBy({ ...base, barsBottom: -5, controlTop: -10 }), 0);
  assert.equal(focusScrollBy({ ...base, controlTop: Number.NaN }), 0);
  assert.equal(focusScrollBy({ ...base, barsBottom: Number.POSITIVE_INFINITY, controlTop: 10 }), 0);
  assert.equal(focusScrollBy({ ...base, controlTop: Number.NEGATIVE_INFINITY }), 0);
});

test("never during a pointer press: a mouse or touch focus is the click's own, and moving the page would lose it", () => {
  // Cross-browser (firefox 2/3, webkit 2/3) and Copying a whole store (chromium 2/3) on 9d3a4bdfe6: a forced click on the
  // look editor's visually hidden theme radio focused it under the bars, the page moved before the click ended, and the
  // radio stayed unchecked (tests/e2e/look-acknowledgment.mjs:32).
  assert.equal(focusScrollBy({ ...base, controlTop: 10, fromPointer: true }), 0);
  assert.equal(focusScrollBy({ ...base, controlTop: -400, fromPointer: true }), 0);
  assert.equal(focusScrollBy({ ...base, controlTop: 10, fromPointer: false }), 10 - 124 - FOCUS_CLEAR_ROOM, "keyboard and script focus still come clear");
});
