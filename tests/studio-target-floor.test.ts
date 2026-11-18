/**
 * A floor of 44 px under the studio's small controls (WCAG 2.2 2.5.5 Target
 * Size (Enhanced), AAA; AX274 Part A item 4). Measured in Chromium at 390 and
 * 1280 px, the studio's disclosure summaries ("How sending works", "What the
 * notifications say") were 20 px tall, and so were the labels around its
 * checkboxes (the consents on /studio/requests and /studio/agreements), whose
 * boxes are 13 to 20 px. There are about 50 such summaries and 167 checkboxes
 * across the studio's components, so the floor is set once, for the studio
 * only: app/studio/layout.tsx marks its pages with data-studio on a wrapper
 * that draws no box of its own (display: contents), and app/globals.css gives
 * every summary and every label wrapping a checkbox or a radio there a minimum
 * height of 2.75rem (44 px). It lives in @layer components behind :where, so
 * any size a control sets for itself with a utility still wins.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const layout = readFileSync("app/studio/layout.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

is("the studio layout wraps its pages in a data-studio marker", /<div data-studio="" className="contents">\s*\{children\}\s*<\/div>/.test(layout), true);
is("the skip link stays before the pages", layout.indexOf("<SkipLink />") < layout.indexOf("data-studio"), true);

const start = css.indexOf("/* begin studio target floor");
const block = start < 0 ? "" : css.slice(start, css.indexOf("/* end studio target floor", start));
is("globals.css has the studio target floor block", block.length > 0, true);
is("it sits in @layer components, under Tailwind's utilities", /@layer components\s*\{/.test(block), true);
is("every summary in the studio is at least 44px tall", /\[data-studio\] :where\(summary\)\s*\{[^}]*min-height:\s*2\.75rem/.test(block), true);
is("and its words sit in the middle of that height", /\[data-studio\] :where\(summary\)\s*\{[^}]*align-content:\s*center/.test(block), true);
is(
  "every label wrapping a checkbox or a radio in the studio is at least 44px tall",
  /\[data-studio\] :where\(label:has\(> input\[type="checkbox"\], > input\[type="radio"\]\)\)\s*\{[^}]*min-height:\s*2\.75rem/.test(block),
  true,
);
const selectors = [...block.matchAll(/^[ \t]*([^\n{}]+?)[ \t]*\{[ \t]*$/gm)].map((m) => m[1]).filter((s) => !s.startsWith("@"));
is("it reaches only the studio, never the store front or the public pages", selectors.length >= 2 && selectors.every((s) => s.startsWith("[data-studio]")), true);

done();
