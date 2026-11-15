/**
 * AX274 Part A / 310 [AX2] (WCAG 1.4.10 Reflow, 1.4.12 Text Spacing), found in the measured browser sweep outside
 * the studio (Claude 4 cloud AA, 15 November 2026): some help answers hold a word longer than a phone is wide, such
 * as an address with its path or a tracking tag (`utm_source={{site_source_name}}&utm_campaign={{campaign.name}}.`).
 * A word does not break on its own, and each section's answers sit in a box that clips (`overflow-hidden`, for its
 * rounded corners). On a production build at 320 px, the end of two answers was cut off by 40 and 83 px. With the
 * text spacing of 1.4.12 (letters 0.12em, words 0.16em, lines 1.5), four sections were cut by 15 to 160 px.
 *
 * The help center's answers now break a long word where it has to (`wrap-anywhere`: overflow-wrap anywhere), and
 * break nowhere else.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { HELP_SECTIONS } from "@/lib/help-content";

part("why: the help center holds words longer than a 320 px phone line");
const words = HELP_SECTIONS.flatMap((section) => section.items.flatMap((item) => item.a.flatMap((paragraph) => paragraph.split(/\s+/))));
const longest = words.reduce((a, b) => (b.length > a.length ? b : a), "");
// About 25 characters of the answers' text fit across a 320 px screen inside the box's padding.
is("an answer holds a word of 30 characters or more", longest.length >= 30, true);

part("1.4.10: the help center's answers break a word longer than the line");
const page = readFileSync("app/help/page.tsx", "utf8");
const answer = /<p key=\{paragraph\} className="([^"]*)"/.exec(page);
is("the answer paragraph is found", Boolean(answer), true);
is("it breaks a long word (wrap-anywhere)", /(?<![\w-])wrap-anywhere\b/.test(answer?.[1] ?? ""), true);
is("it still sits in the clipping box, so the break is what keeps the end of a word in view", /divide-y divide-line overflow-hidden/.test(page), true);

done();
