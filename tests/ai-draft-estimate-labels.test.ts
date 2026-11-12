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
is("lesson, module, day, part, chapter, email and session labels are not estimates",
  unsourcedNumbers(["Lesson 4 covers it. Module 2 starts. Day 7 recap. Part 3. Chapter 9. Email 5 of the sequence. Session 6."], "", "en"), []);
is("control: a figure beside a label is still listed", unsourcedNumbers(["Week 1: lose 10 pounds"], "", "en"), ["10"]);
is("control: a figure with no label is still listed", unsourcedNumbers(["Join 5,000 bakers"], "", "en"), ["5,000"]);
is("control: a number before the word is a figure ('3 weeks')", unsourcedNumbers(["Done in 3 weeks"], "", "en"), ["3"]);

const source = readFileSync("components/ai-draft-review.tsx", "utf8");
is("the estimates list is never keyed by the written figure alone", /key=\{figure\}/.test(source), false);
const twice = renderToStaticMarkup(createElement(AiDraftReview, { checks: [false], onToggle: () => {}, estimates: ["10m", "10m"] }));
is("control: both rows are still drawn", (twice.match(/>10m</g) ?? []).length, 2);

done();
