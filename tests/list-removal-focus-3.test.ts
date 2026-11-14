/**
 * WCAG 2.4.3 in a sequence's steps (components/email-studio.tsx): removing an email or a step took its Remove button
 * with it and the browser dropped the focus to the top of the page. It now hands the focus on with
 * handFocusOnAfterRemoval (lib/focus-when-drawn.ts), as the lists of tests/list-removal-focus*.test.ts: the step now
 * in its place, or the one before, or "Add a step" when the one left cannot be removed (a sequence keeps one step,
 * and its Remove is not drawn then). The helper itself is proven in Chromium by tests/list-removal-focus-browser.test.ts.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const text = readFileSync("components/email-studio.tsx", "utf8");

part("A sequence's steps hand the focus on");
is('its Remove buttons carry data-list-remove="flow-step"', text.includes('data-list-remove="flow-step"'), true);
is('"Add a step" has the id flow-step-add', text.includes('id="flow-step-add"'), true);
is("the removal hands the focus on", /handFocusOnAfterRemoval\("flow-step", i, draft\.steps\.length, "flow-step-add"\)/.test(text), true);
done();
