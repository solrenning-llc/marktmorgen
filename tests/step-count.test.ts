/**
 * 766 [STN13], unit 2: "Step 2 of 3" in a creation flow that really has
 * steps. One component says it (components/step-count.tsx); the one flow of
 * the studio with real steps today, a funnel from a kind
 * (components/funnel-type-picker.tsx), shows it on each of its three steps
 * and moves the focus to it when the step changes, so a keyboard or screen
 * reader user is never left on a button that has just gone (AX274, WCAG
 * 2.4.3 Focus Order).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StepCount, stepWords } from "@/components/step-count";
import { funnelPickerStep } from "@/components/funnel-type-picker";
import { done, is, part } from "./check";

part("The words");
is("step, place, total and what the step is", stepWords(2, 3, "Products"), "Step 2 of 3: Products");
is("the first and the last", [stepWords(1, 3, "Pick a kind"), stepWords(3, 3, "Review")], ["Step 1 of 3: Pick a kind", "Step 3 of 3: Review"]);
is("never a step outside the flow", [stepWords(0, 3, "A"), stepWords(4, 3, "A"), stepWords(-1, 3, "A")], [null, null, null]);
is("never a flow of one step or none", [stepWords(1, 1, "A"), stepWords(1, 0, "A")], [null, null]);
is("never a step that is not a whole number", [stepWords(1.5, 3, "A"), stepWords(1, 2.5, "A"), stepWords(Number.NaN, 3, "A")], [null, null, null]);
is("never a step without a name", [stepWords(1, 3, ""), stepWords(1, 3, "   ")], [null, null]);

part("What it draws");
const html = renderToStaticMarkup(createElement(StepCount, { current: 2, total: 3, label: "Products" }));
is("one line of text that the focus can be moved to", /^<p [^>]*tabindex="-1"[^>]*>Step 2 of 3: Products<\/p>$/.test(html), true);
is("no live region: the moved focus reads it once", /aria-live|role="status"/.test(html), false);
is("no bar or color carries the step: the words do", /<progress|role="progressbar"/.test(html), false);
is("a step that does not exist draws nothing", renderToStaticMarkup(createElement(StepCount, { current: 4, total: 3, label: "Products" })), "");
is("a name is shown as text, never as markup", renderToStaticMarkup(createElement(StepCount, { current: 1, total: 2, label: "<b>x</b>" })).includes("Step 1 of 2: &lt;b&gt;x&lt;/b&gt;"), true);

part("A funnel from a kind: three steps");
is("closed: no step", funnelPickerStep({ open: false, chosen: false, reviewing: false }), null);
is("the kinds: step 1", funnelPickerStep({ open: true, chosen: false, reviewing: false }), { current: 1, total: 3, label: "Pick a kind" });
is("a kind chosen: step 2", funnelPickerStep({ open: true, chosen: true, reviewing: false }), { current: 2, total: 3, label: "Products" });
is("the review: step 3", funnelPickerStep({ open: true, chosen: true, reviewing: true }), { current: 3, total: 3, label: "Review" });

const picker = readFileSync("components/funnel-type-picker.tsx", "utf8");
is("the picker says the step with the shared component, on each step", (picker.match(/<StepCount\b/g) ?? []).length, 2);
is("no step words typed by hand are left in it", /Step \d of \d/.test(picker), false);
is("the step is moved to when it changes, but not while the success notice has just appeared", /useEffect\(/.test(picker) && /stepLine\.current\?\.focus\(\)/.test(picker) && /if \(made\)/.test(picker), true);

done();
