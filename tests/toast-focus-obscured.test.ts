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
  followToastFocus?: (region: HTMLElement, onHidden: (hidden: boolean) => void, win?: Window) => () => void;
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

// A fake window and document: listeners, animation frames and layout observers, driven by hand.
function fakePage() {
  type Listener = () => void;
  const listeners = new Map<string, Set<Listener>>();
  const add = (type: string, fn: Listener) => (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn);
  const remove = (type: string, fn: Listener) => listeners.get(type)?.delete(fn);
  const frames = new Map<number, Listener>();
  let nextFrame = 0;
  const mutations = new Set<(records: { target: unknown }[]) => void>();
  const resizes = new Set<Listener>();
  const body = { nodeName: "BODY" };
  const content = { nodeName: "MAIN" };
  const doc = { activeElement: null as unknown, body, documentElement: {}, addEventListener: add, removeEventListener: remove };
  class FakeMutationObserver {
    constructor(private readonly fn: (records: { target: unknown }[]) => void) {}
    observe() {
      mutations.add(this.fn);
    }
    disconnect() {
      mutations.delete(this.fn);
    }
  }
  class FakeResizeObserver {
    constructor(private readonly fn: Listener) {}
    observe() {
      resizes.add(this.fn);
    }
    disconnect() {
      resizes.delete(this.fn);
    }
  }
  const win = {
    document: doc,
    addEventListener: add,
    removeEventListener: remove,
    requestAnimationFrame: (fn: Listener) => {
      nextFrame += 1;
      frames.set(nextFrame, fn);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
  };
  return {
    win: win as unknown as Window,
    content,
    focus: (element: Element) => {
      doc.activeElement = Object.assign(element, { ownerDocument: doc });
    },
    fire: (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn()),
    frame: () => {
      const waiting = [...frames.values()];
      frames.clear();
      waiting.forEach((fn) => fn());
    },
    framesWaiting: () => frames.size,
    mutate: (target: unknown) => [...mutations].forEach((fn) => fn([{ target }])),
    resizeBody: () => [...resizes].forEach((fn) => fn()),
    mutationWatchers: () => mutations.size,
    resizeWatchers: () => resizes.size,
    listeners: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

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

  // While a toast shows, it follows the page: a layout change with no event (a refresh that grows the content
  // above the focused Save button) moves it too, and a hidden box tells the Toaster so its countdown waits.
  is("the toast exports what follows the page while it shows", typeof api.followToastFocus, "function");
  const follow = api.followToastFocus!;
  const page = fakePage();
  const four = fakeRegion(wide, "bottom-end");
  const save = { rect: box(1100, 600, 140, 44) };
  page.focus({ getBoundingClientRect: () => save.rect } as unknown as Element);
  const hiddenSaid: boolean[] = [];
  const stop = follow(four.region, (hidden) => hiddenSaid.push(hidden), page.win);
  is("it watches the page's layout while the toast shows", [page.mutationWatchers(), page.resizeWatchers()], [1, 1]);
  save.rect = box(1100, 730, 140, 44); // the refresh pushed the focused button down, under the toast
  page.mutate(page.content);
  page.frame();
  is("a page change with no event moves the toast off the focused control", four.data.place, "top-end");
  save.rect = box(1100, 40, 140, 44);
  page.resizeBody();
  page.frame();
  is("so does the content's size changing", four.data.place, "bottom-end");
  four.data.place = "bottom-end";
  page.mutate(four.region);
  is("the toast's own changes never start another check", page.framesWaiting(), 0);
  is("while it shows, the countdown is never told to wait", hiddenSaid, []);
  page.focus({ getBoundingClientRect: () => box(0, 0, 1280, 800) } as unknown as Element);
  page.fire("focusin");
  is("a focused control under every corner hides the box, and the countdown is told to wait", [four.data.place, hiddenSaid], ["hidden", [true]]);
  page.fire("focusin");
  is("still hidden: nothing new is said", hiddenSaid, [true]);
  page.focus({ getBoundingClientRect: () => box(40, 300, 200, 44) } as unknown as Element);
  page.fire("focusin");
  is("a corner clears: the box shows again and the countdown goes on", [four.data.place, hiddenSaid], ["bottom-end", [true, false]]);
  stop();
  is("when the toast goes, nothing is left watching", [page.mutationWatchers(), page.resizeWatchers(), page.listeners()], [0, 0, 0]);
  const fromHidden = fakeRegion(wide, "hidden");
  const said: boolean[] = [];
  const stopHidden = follow(fromHidden.region, (hidden) => said.push(hidden), page.win);
  page.fire("focusin");
  is("a toast placed hidden before it was painted is said visible once a corner clears", [fromHidden.data.place, said], ["bottom-end", [false]]);
  stopHidden();
  is("the countdown never starts while the box is hidden", /const startTimer = useCallback\(\(\) => \{\s*stopTimer\(\);\s*if \([^)]*hidden\.current[^)]*\) return;/.test(source), true);
  is("the Toaster pauses and resumes the countdown with the box", /followToastFocus\(region\.current, \(isHidden\) => \{[\s\S]*?isHidden \? pauseTimer\(\) : startTimer\(\)/.test(source), true);

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

  // Targets and forced colors.
  is("the Dismiss button is a 44 x 44 px target (2.5.5)", /width:\s*44px;\s*height:\s*44px;/.test(rule(".nb-toast-close {")), true);
  is("in forced colors the toast keeps a visible edge", /@media \(forced-colors: active\)\s*\{\s*\.nb-toast\s*\{\s*border:[^}]*CanvasText/.test(css), true);

  console.log(`Toast focus not obscured: ${passed} checks passed`);
}

main();
