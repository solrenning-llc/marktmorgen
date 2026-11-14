/**
 * The pilot of BusyButton (components/busy-button.tsx; tests/busy-button-browser.test.ts): in the two studio files
 * no open pull request touched on 13 November 2026, every button that waited on the server by being disabled now
 * waits as a BusyButton, so the focus stays on it (WCAG 2.4.3). The other 149 files are listed, with how many
 * such buttons each has, in docs/busy-button-migration-2026-11-13.md, to move over a few at a time.
 *
 * What fails here: a button in either file disabled again while it waits.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const WAITS = /\bdisabled=\{[^}]*\b(busy|saving|sending|working|pending|loading)\b/;

part("No button of the pilot is disabled while it waits");
for (const [file, least] of [
  ["components/custom-range.tsx", 6],
  ["components/funnel-share-panel.tsx", 8],
] as const) {
  const text = readFileSync(file, "utf8");
  const waiting = [...text.matchAll(/<button\b((?:[^<>]|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*?)>/g)].filter((m) => WAITS.test(m[1]));
  is(`${file}: no <button> disabled while it waits`, waiting.length, 0);
  is(`${file}: its buttons that wait are BusyButtons`, (text.match(/<BusyButton\b/g) ?? []).length >= least, true);
  is(`${file}: imports BusyButton`, text.includes('import { BusyButton } from "@/components/busy-button";'), true);
}
done();
