/**
 * AX274 Part A (WCAG 2.2 AAA, 1.4.6 Contrast (Enhanced)) on /studio/deals: each pipeline button ends with
 * " · N open" and, for a pipeline this person may only see, " · view only". Both were drawn at `opacity-80`, which
 * blends the button's own text into its background: measured at 5.63:1 on the chosen pipeline (Claude 4 cloud P's
 * studio audit, docs/studio-accessibility-audit-2026-11-11.md), under the 7:1 the enhanced level needs. The button's
 * text color already meets 7:1, so the counts take it whole, with no opacity.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const source = readFileSync("components/deals-board.tsx", "utf8");
const at = source.indexOf('aria-label="Pipelines"');
const tabs = at >= 0 ? source.slice(at, source.indexOf("</div>", source.indexOf("allTotals.map", at))) : "";

part("1.4.6: the pipeline buttons' counts keep the button's full text color");
is("the pipeline buttons are found", /allTotals\.map/.test(tabs) && /open`\}/.test(tabs), true);
is("no opacity is laid on their text (it blended them to 5.63:1)", /\bopacity-\d+/.test(tabs), false);
is("the count and the view-only note are still said", [/ open`\}/.test(tabs), / · view only/.test(tabs)], [true, true]);

done();
