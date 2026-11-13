/**
 * Claude 1's two LOW findings on #3437 at fab09f5266. (1) Numbering that labels a part of a draft ("Week 1:",
 * "Step 2.", "Module 3") is not a figure and is not listed as an estimate; a figure is still listed (controls).
 * (2) Two estimates written the same ("10m" minutes and "10m" millions) never share a React key.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { unsourcedNumbers } from "@/lib/ai-draft-review";
import { AiDraftReview } from "@/components/ai-draft-review";
import { done, is } from "./check";

const outline = "Week 1: Getting started\nWeek 2: Your first loaf\nWeek 3: Shaping";
is("week labels are not estimates", unsourcedNumbers([outline], "A course on sourdough", "en"), []);
is("step labels are not estimates", unsourcedNumbers(["Step 1. Mix\nStep 2. Rest"], "", "en"), []);
is("part, chapter and session labels that end their sentence are not estimates",
  unsourcedNumbers(["Part 3. Chapter 9. Session 6."], "", "en"), []);
// Since Codex L's MEDIUM: a label followed by more words in its sentence is read as a claim and listed, on the
// side of a prompt to check ("Lesson 4 covers it" is listed as "Each lesson 45 minutes" must be).
is("a label followed by words in the same sentence is listed for the creator to check",
  unsourcedNumbers(["Lesson 4 covers it. Module 2 starts. Day 7 recap. Email 5 of the sequence."], "", "en"), ["4", "2", "7", "5"]);
is("control: a figure beside a label is still listed", unsourcedNumbers(["Week 1: lose 10 pounds"], "", "en"), ["10"]);
is("control: a figure with no label is still listed", unsourcedNumbers(["Join 5,000 bakers"], "", "en"), ["5,000"]);
is("control: a number before the word is a figure ('3 weeks')", unsourcedNumbers(["Done in 3 weeks"], "", "en"), ["3"]);

// Review of #3437 at 3bf5cddbaa (Claude 3 cloud O, Codex X5): a plural before digits is a count followed by a
// claim, never a part label, so the figure after it stays listed for the creator to check.
is("a plural word before digits is a count, so the figure after it is still listed",
  [
    unsourcedNumbers(["12 lessons 40 minutes each"], "", "en"),
    unsourcedNumbers(["Over 30 days 500 students joined"], "", "en"),
    unsourcedNumbers(["Results in 4 weeks 10 pounds lighter"], "", "en"),
  ],
  [["12", "40"], ["30", "500"], ["4", "10"]]);

// Codex L on #3437 at 62373a0f99 (MEDIUM): only a label shaped as a heading or a list item numbers a part. A
// singular word before a figure in a sentence ("Each lesson 45 minutes", "by day 30") is a claim, still listed.
is("a figure after a singular word inside a sentence is still listed",
  unsourcedNumbers(["Each lesson 45 minutes. The session 90 minutes long. Reach the goal by day 30."], "", "en"), ["45", "90", "30"]);
is("control: heading and list labels are still not estimates",
  unsourcedNumbers(["Week 1: Getting started\nStep 2. Rest\nModule 3 — Practice\n- Lesson 4: Shaping\n## Day 5\nPart 6.\nChapter 7)"], "", "en"), []);

const source = readFileSync("components/ai-draft-review.tsx", "utf8");
is("the estimates list is never keyed by the written figure alone", /key=\{figure\}/.test(source), false);
const twice = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false], onToggle: () => {}, estimates: ["10m", "10m"] }));
is("control: both rows are still drawn", (twice.match(/>10m</g) ?? []).length, 2);

done();
