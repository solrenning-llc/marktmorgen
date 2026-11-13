/**
 * WCAG 2.4.3 in the studio's lists: removing an item takes its Remove button with it, and the browser dropped the
 * focus to the top of the page. The audit of 13 November 2026 found six more lists that did so after the funnel
 * offers, a bundle's products and a page funnel's steps: the questions asked at checkout, a media kit's platforms
 * and its rates, a funnel form's questions, an affiliate program's bonuses and the pages brought from ClickFunnels.
 *
 * Each now hands the focus on with focusAfterListRemoval (lib/focus-when-drawn.ts), by the page editor's rule:
 * the item now in its place, or the one before, or the button that adds one once the list is empty. Driven here
 * with frames of its own; the source of each list is read for the call and for the marks its buttons carry.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { type Focusable, type Frames, focusAfterListRemoval } from "@/lib/focus-when-drawn";

function handFrames() {
  const waiting: (() => void)[] = [];
  const frames: Frames = { request: (step) => waiting.push(step), cancel: () => undefined };
  return { frames, step: () => waiting.shift()?.() };
}
const button = (name: string, log: string[]): Focusable & { name: string } => ({ name, focus: () => log.push(name) });

part("focusAfterListRemoval: where the focus goes, once the list is drawn shorter");
for (const [what, before, at, after, want] of [
  ["the first of three", 3, 0, ["b", "c"], "b"],
  ["the middle of three", 3, 1, ["a", "c"], "c"],
  ["the last of three", 3, 2, ["a", "b"], "b"],
  ["the only one", 1, 0, [], "add"],
] as const) {
  const log: string[] = [];
  const hand = handFrames();
  let drawn: string[] = Array.from({ length: before }, (_, i) => "abc"[i]);
  focusAfterListRemoval(() => drawn.map((n) => button(n, log)), at, before, () => button("add", log), hand.frames);
  is(`${what}: nothing moves while the old list is still drawn`, log, []);
  drawn = [...after];
  hand.step();
  is(`${what}: then the focus goes to ${want}`, log, [want]);
}

part("The six lists hand the focus on");
for (const [file, mark] of [
  ["components/checkout-fields-editor.tsx", "checkout-question"],
  ["components/kit-editor.tsx", "kit-audience"],
  ["components/kit-editor.tsx", "kit-rate"],
  ["components/funnel-form-setup.tsx", "funnel-form-question"],
  ["components/affiliate-studio.tsx", "affiliate-bonus"],
  ["components/clickfunnels-funnel.tsx", "cf-page"],
] as const) {
  const text = readFileSync(file, "utf8");
  is(`${file}: its Remove buttons carry data-list-remove="${mark}"`, text.includes(`data-list-remove="${mark}"`), true);
  is(`${file}: the removal hands the focus on for "${mark}"`, new RegExp(`focusAfterListRemoval\\([^;]*data-list-remove="${mark}"`).test(text), true);
}
done();
