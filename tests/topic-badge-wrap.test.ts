/**
 * AX274 Part A / 310 [AX2] (WCAG 1.4.12 Text Spacing, 1.4.10 Reflow), found in the measured browser sweep outside
 * the studio (Claude 4 cloud AA, 15 November 2026): a topic page's badge under its title is a `.tag`, which never
 * wraps (`white-space: nowrap`) and is 26 px tall. On /proof/creator-showcase at 320 px, with 1.4.12's spacing
 * (letters 0.12em, words 0.16em), "Permission registry reviewed 2026-10-20" grew past the hero, whose box clips,
 * and its last 18 px were cut off.
 *
 * The two badges of a topic page's hero (components/topic-page.tsx) now wrap, with their height as a minimum, so a
 * long badge takes a second line instead of being cut.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const source = readFileSync("components/topic-page.tsx", "utf8");
const badge = /<span className=\{([^}]*BADGE_CLASS\[page\.badge\.tone\][^}]*)\}>\{page\.badge\.label\}<\/span>/.exec(source)?.[1] ?? "";
const plan = /<span className=\{?"?([^">{}]*)"?\}?>\{PLAN_LINE\[page\.plan\]\}<\/span>/.exec(source)?.[1] ?? "";
const wraps = (cls: string) => /\bwhitespace-normal\b/.test(cls) && /\bh-auto\b/.test(cls) && /\bmin-h-\[26px\]/.test(cls);

part("1.4.12: a topic page's badges wrap instead of being cut");
is("the badge is found", badge.length > 0, true);
is("the badge wraps, its height a minimum", wraps(badge), true);
is("the plan badge is found", plan.length > 0, true);
is("the plan badge wraps, its height a minimum", wraps(plan), true);

done();
