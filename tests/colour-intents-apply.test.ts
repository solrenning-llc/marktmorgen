/**
 * AX274 Part A (WCAG 1.4.6 checked before and after; no lower contrast accepted). Found by Claude 4 cloud AA on
 * 15 November 2026: most of app/globals.css is outside any @layer, and an unlayered rule beats Tailwind's layered
 * utilities whatever their specificity. So a colour utility on an element that also carries a site class setting
 * `color` (`.btn-ghost`, `.notice-warn`, `.field-hint`, `.tag`, `.field`) never applied: the "danger" red of a
 * delete button or a failure count, and the darker ink asked for on two warnings and two hints, were silently
 * replaced by the site class's own colour. Only the important variant ("!") applies over an unlayered rule.
 *
 * Each of the seven now carries the "!" variant, except where the colour asked for would draw text under 7:1;
 * those stay on the site class's colour, with the reason written beside them (the coordinator's condition,
 * 15 November 2026). The measured contrasts are in the branch's PR-BODY.md.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

/** [file, the site class, the colour utility asked for, a phrase of the element's own text to find its line]. */
const INTENTS: [string, string, string, string][] = [
  ["components/blog-editor.tsx", "btn-ghost", "text-danger", 'question="Delete this post?'],
  ["components/calendar-editor.tsx", "notice-warn", "text-ink", "Your previous address was asked too often"],
  ["components/call-editor.tsx", "field-hint", "text-ink", "is not longer than the call's own length"],
  ["components/call-editor.tsx", "field-hint", "text-ink", "A group call has one length"],
  ["components/closing-refunds-confirm.tsx", "notice-warn", "text-ink", "{state.message}"],
  ["components/feature-visuals.tsx", "field", "text-ink-mute", "Who it is for, what makes it different"],
  ["components/workflow-tools.tsx", "tag", "text-danger", "Failed ${n(counts.failed)}"],
];

/** Kept on the site class's colour after measuring, with the reason (see PR-BODY.md); filled from the measurement. */
const KEPT: Record<string, string> = {
  "components/blog-editor.tsx btn-ghost text-danger question=\"Delete this post?": "The delete button is kept on the site class's colour (measured 15 Nov 2026: the colour asked for is under 7:1",
  "components/workflow-tools.tsx tag text-danger Failed ${n(counts.failed)}": "The failed count is kept on the site class's colour (measured 15 Nov 2026: the colour asked for is under 7:1",
  "components/feature-visuals.tsx field text-ink-mute Who it is for, what makes it different": "The sample field's text is kept on the site class's colour (measured 15 Nov 2026: the colour asked for is under 7:1",
  "components/call-editor.tsx field-hint text-ink is not longer than the call's own length": "Its two length hints are kept on the site class's colour (measured 15 Nov 2026: the colour asked for is under 7:1",
  "components/call-editor.tsx field-hint text-ink A group call has one length": "Its two length hints are kept on the site class's colour (measured 15 Nov 2026: the colour asked for is under 7:1",
};

part("a colour asked for over a site class applies (the important variant), or is kept with its reason");
for (const [file, site, utility, phrase] of INTENTS) {
  const source = readFileSync(file, "utf8");
  const at = source.indexOf(phrase);
  const before = source.slice(0, at);
  // The className of the element that holds the phrase: the last one opened before it, within a few lines.
  const window = before.slice(Math.max(0, before.length - 900));
  const classes = [...window.matchAll(/className="([^"]*)"/g)].map((m) => m[1]).filter((c) => c.split(/\s+/).includes(site)).at(-1) ?? "";
  const key = `${file} ${site} ${utility} ${phrase}`;
  is(`${key}: the element is found`, at > 0 && classes.length > 0, true);
  if (KEPT[key]) {
    is(`${key}: kept on the site colour, and says why in the source`, source.includes(KEPT[key]), true);
    is(`${key}: no colour utility left that would do nothing`, classes.split(/\s+/).some((c) => c === utility || c === `${utility}!`), false);
  } else {
    is(`${key}: the colour applies (${utility}!)`, classes.split(/\s+/).includes(`${utility}!`), true);
    is(`${key}: no plain ${utility} left that would do nothing`, classes.split(/\s+/).includes(utility), false);
  }
}

done();
