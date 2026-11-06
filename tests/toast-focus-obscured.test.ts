// WCAG 2.4.11 / 2.4.12 (Focus Not Obscured, Minimum and Enhanced): the studio-wide
// confirmation toast ("Draft saved." and the rest) must never cover the control that
// has focus, wherever that control is, for the 5 seconds it shows. Found by the email
// editor audit (PR #2984): the toast sat bottom right over the focused control.
//
// The geometry here is synthetic (a 1280 x 800 window and a 390 x 844 phone); the
// placement code under test is the real one in components/toast.tsx, and the page
// rules are read from the real app/globals.css.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as toastModule from "@/components/toast";

type Box = { left: number; top: number; right: number; bottom: number };
type Place = "bottom-end" | "top-end" | "bottom-start" | "top-start" | "hidden";

const api = toastModule as unknown as {
  TOAST_PLACES?: readonly Place[];
  FOCUS_ROOM?: number;
  coversFocus?: (toast: Box, focus: Box, room?: number) => boolean;
  chooseToastPlace?: (focus: Box | null, rectAt: (place: Place) => Box, preferred: Place) => Place;
  keepToastClear?: (region: HTMLElement, active: Element | null, preferred?: Place) => Place;
};

let passed = 0;
function is<T>(name: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, name);
  passed += 1;
}

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, right: left + width, bottom: top + height });

// Where the toast region lands for each place on a 1280 x 800 window (24 px from the
// edges, 420 x 60) and on a 390 x 844 phone (16 px from the edges, full width).
const wide: Record<Exclude<Place, "hidden">, Box> = {
  "bottom-end": box(836, 716, 420, 60),
  "top-end": box(836, 24, 420, 60),
  "bottom-start": box(24, 716, 420, 60),
  "top-start": box(24, 24, 420, 60),
};
const phone: Record<Exclude<Place, "hidden">, Box> = {
  "bottom-end": box(16, 768, 358, 60),
  "top-end": box(16, 16, 358, 60),
  "bottom-start": box(16, 768, 358, 60),
  "top-start": box(16, 16, 358, 60),
};
const at = (layout: typeof wide) => (place: Place) => layout[place === "hidden" ? "bottom-end" : place];
const overlap = (a: Box, b: Box, room = 0) => a.left < b.right + room && a.right > b.left - room && a.top < b.bottom + room && a.bottom > b.top - room;

// A fake region: its box moves with data-place, as the stylesheet moves it.
function fakeRegion(layout: typeof wide, place?: Place) {
  const inside = new Set<unknown>();
  const region = {
    dataset: (place ? { place } : {}) as Record<string, string>,
    getBoundingClientRect: () => at(layout)((region.dataset.place as Place) ?? "bottom-end"),
    contains: (node: unknown) => node === region || inside.has(node),
  };
  return { region: region as unknown as HTMLElement, inside, data: region.dataset };
}
const focusAt = (b: Box) => ({ getBoundingClientRect: () => b }) as unknown as Element;

function main() {
  const source = readFileSync("components/toast.tsx", "utf8");
  const css = readFileSync("app/globals.css", "utf8");

  is("the toast exports its placement code", [typeof api.chooseToastPlace, typeof api.keepToastClear, typeof api.coversFocus], ["function", "function", "function"]);
  is("four corners to try, the usual bottom right first", api.TOAST_PLACES, ["bottom-end", "top-end", "bottom-start", "top-start"]);
  is("the focus ring's room (outline and offset) counts as part of the focused control", (api.FOCUS_ROOM ?? 0) >= 8, true);

  const choose = api.chooseToastPlace!;
  const covers = api.coversFocus!;

  // The audit's case: a control near the bottom right has focus when "Draft saved." appears.
  const saveButton = box(1100, 730, 140, 44);
  is("bottom right would cover the focused Save button", covers(wide["bottom-end"], saveButton), true);
  const moved = choose(saveButton, at(wide), "bottom-end");
  is("so the toast moves to the top right, the next corner", moved, "top-end");
  is("and there it covers no part of the control or its ring", overlap(at(wide)(moved), saveButton, api.FOCUS_ROOM), false);

  // A ring 4 px outside the toast's edge is still covered: the room is counted.
  const justAbove = box(900, 640, 200, 70); // bottom edge 710, toast top 716
  is("a control whose ring reaches under the toast counts as covered", covers(wide["bottom-end"], justAbove), true);
  is("a control well clear of the toast is not covered", covers(wide["bottom-end"], box(40, 300, 200, 44)), false);

  is("focus well away: the toast stays where it is", choose(box(40, 300, 200, 44), at(wide), "bottom-end"), "bottom-end");
  is("no focused control: the toast stays where it is", choose(null, at(wide), "top-end"), "top-end");
  is("a zero-size focus target is ignored", choose(box(0, 0, 0, 0), at(wide), "bottom-end"), "bottom-end");
  is("an already clear place is kept rather than jumping back", choose(box(1100, 300, 140, 44), at(wide), "top-end"), "top-end");

  // A tall right-hand column has focus: both right corners would cover it.
  const sidebar = box(820, 0, 460, 800);
  is("a tall right column sends the toast to the bottom left", choose(sidebar, at(wide), "bottom-end"), "bottom-start");
  // A full-window editor has focus: every corner would cover it.
  const editor = box(0, 0, 1280, 800);
  is("a full-window editor: no corner is clear, so the box is hidden (still announced)", choose(editor, at(wide), "bottom-end"), "hidden");

  // On a phone the toast is full width: bottom, then top, then hidden.
  const phoneField = box(16, 760, 358, 48);
  is("phone: a field at the bottom sends the toast to the top", choose(phoneField, at(phone), "bottom-end"), "top-end");
  is("phone: a field filling the screen hides the box", choose(box(0, 0, 390, 844), at(phone), "bottom-end"), "hidden");

  // keepToastClear measures the real region at each place and leaves it on a clear one.
  const keep = api.keepToastClear!;
  const one = fakeRegion(wide, "bottom-end");
  is("the region is moved off the focused control", [keep(one.region, focusAt(saveButton)), one.data.place], ["top-end", "top-end"]);
  is("and moved back only when it would cover again", [keep(one.region, focusAt(box(1100, 40, 140, 44))), one.data.place], ["bottom-end", "bottom-end"]);
  const two = fakeRegion(wide, "top-end");
  const dismiss = {};
  two.inside.add(dismiss);
  is("focus inside the toast (its Dismiss button): the toast does not jump", [keep(two.region, dismiss as Element), two.data.place], ["top-end", "top-end"]);
  const three = fakeRegion(wide, "hidden");
  is("after being hidden, the first clear corner is used again", [keep(three.region, focusAt(box(40, 300, 200, 44))), three.data.place], ["bottom-end", "bottom-end"]);

  // The component re-checks whenever focus or the page moves, before the box is painted.
  is("the Toaster re-checks on focus, typing, scrolling and resizing", ["\"focusin\"", "\"input\"", "\"scroll\"", "\"resize\""].every((event) => source.includes(event)), true);
  is("the first check runs in the layout effect, before the toast is painted", /useLayoutEffect\(\(\) => \{\s*if \(!current\) return;[\s\S]*?keepToastClear\(/.test(source), true);
  is("a new toast starts from the usual corner", /keepToastClear\([^)]*"bottom-end"\)/.test(source), true);

  // The announcement is unchanged.
  const html = renderToStaticMarkup(createElement(toastModule.Toaster));
  is("the region keeps its polite, atomic status announcement (4.1.3)", /<div role="status" aria-live="polite" aria-atomic="true" class="sr-only"><\/div>/.test(html), true);

  // The stylesheet moves the region for each place, without animating the move.
  const rule = (selector: string) => {
    const at = css.indexOf(selector);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };
  is("top places pin the region to the top", /top:\s*max\(16px, env\(safe-area-inset-top\)\)/.test(rule('.nb-toast-region[data-place^="top"]')) && /bottom:\s*auto/.test(rule('.nb-toast-region[data-place^="top"]')), true);
  is("start places pin it to the left on a wide screen", /left:\s*24px/.test(rule('.nb-toast-region[data-place$="start"]')) && /right:\s*auto/.test(rule('.nb-toast-region[data-place$="start"]')), true);
  is("hidden takes the box out of sight and out of reach", /visibility:\s*hidden/.test(rule('.nb-toast-region[data-place="hidden"] .nb-toast')), true);
  is("the move is never animated (reduced motion is respected by not moving smoothly at all)", /transition/.test(css.slice(css.indexOf(".nb-toast-region {"), css.indexOf(".nb-toast {"))), false);

  // Targets and forced colours.
  is("the Dismiss button is a 44 x 44 px target (2.5.5)", /width:\s*44px;\s*height:\s*44px;/.test(rule(".nb-toast-close {")), true);
  is("in forced colours the toast keeps a visible edge", /@media \(forced-colors: active\)\s*\{\s*\.nb-toast\s*\{\s*border:[^}]*CanvasText/.test(css), true);

  console.log(`Toast focus not obscured: ${passed} checks passed`);
}

main();
