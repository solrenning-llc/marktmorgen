/**
 * What the site and the studio say about the drip email, since its window is seven days (docs/drip-due-index.md):
 * a module opens on its day, and its email can come up to seven days later when many open at once. No text may
 * promise the email on the day the module opens (VR: nothing shown that does not happen). The email itself says only
 * that the module is now open, which stays true.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const FILES = [
  "app/mission/page.tsx",
  "app/studio/course/[product]/page.tsx",
  "lib/feature-pages.ts",
  "lib/help-content.ts",
  "lib/site-pages.ts",
  "lib/course-templates.ts",
];
// Same-day promises about the drip email, as they were written before the seven-day window.
const PROMISES = [
  /email the day (it does|each one opens|a lesson opens|a module opens)/i,
  /email\s+the day it does/i,
  /opening on its day, with an email/i,
  /already get when a module opens/i,
  /email[^."]{0,40}(right away|at once|immediately|the same day)[^."]{0,40}(module|lesson)/i,
];

part("No text promises the drip email on the day a module opens");
for (const file of FILES) {
  const text = readFileSync(file, "utf8");
  is(`${file}: no same-day promise`, PROMISES.filter((p) => p.test(text)).map(String), []);
}

part("Where the drip email is described, it says it can come up to seven days later");
const told = (file: string, needle: RegExp) => needle.test(readFileSync(file, "utf8"));
const LATER = /email[^"]{0,120}up to seven days later/i;
is("the course feature page", told("lib/feature-pages.ts", LATER), true);
is("the help answer", told("lib/help-content.ts", LATER), true);
is("the studio's course page", told("app/studio/course/[product]/page.tsx", /email[\s\S]{0,160}up to seven days\s+later/i), true);
is("the mission page", told("app/mission/page.tsx", LATER), true);
is("the course templates", told("lib/course-templates.ts", LATER), true);

done();
