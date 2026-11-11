import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * WCAG 2.2 1.3.1 Info and Relationships and 2.4.6 Headings and Labels (274
 * [AX1]): every state of a buyer's membership pages has a level-one heading.
 *
 * Found by a browser audit (11 November 2026, Chromium, axe-core 4.13,
 * page-has-heading-one, a local build of main 7b04206e): opened without a
 * valid link, /@store/manage/leave showed "This link has expired" and
 * /@store/manage/switch "This membership cannot switch" as bold paragraphs,
 * and neither page had any heading. A screen reader user moving by headings
 * found nothing to say what happened. Each notice's title is now the page's
 * h1, with the same classes, so it looks the same.
 */
const leave = readFileSync("app/[handle]/manage/leave/page.tsx", "utf8");
const change = readFileSync("app/[handle]/manage/switch/page.tsx", "utf8");

test("/manage/leave: the expired link's title and the gone membership's line are h1", () => {
  assert.match(leave, /<h1 [^>]*>\{m\.manageNotices\.expired\.title\}<\/h1>/);
  assert.match(leave, /<h1 [^>]*>\{m\.leaveGone\}<\/h1>/);
});

test("/manage/switch: both problem notices' titles are h1", () => {
  assert.match(change, /<h1 [^>]*>\{m\.switchProblems\[result\.reason\]\.title\}<\/h1>/);
  assert.match(change, /<h1 [^>]*>\{problem\.title\}<\/h1>/);
});
