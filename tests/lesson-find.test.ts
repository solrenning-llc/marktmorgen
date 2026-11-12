/**
 * "Find a lesson" on a course's page (291 [SQ2], unit 1; lib/lesson-find-rules.ts,
 * components/course-find.tsx; added 12 November 2026). The rules with
 * synthetic titles, the real outline drawn on the server, and the course page's
 * own code:
 *
 *   - matching ignores case, accents and punctuation, and needs every word
 *     typed, each as the start of a word of the lesson's or its module's title;
 *   - an empty query matches everything, and a long one is cut;
 *   - each lesson the outline draws carries exactly its words, and each module
 *     its mark, for the box to hide;
 *   - the course page offers the box only from FIND_MIN_LESSONS lessons;
 *   - every buyer language says it, with one and many.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIND_MAX_CHARS, FIND_MIN_LESSONS, findKey, lessonMatches, queryWords } from "@/lib/lesson-find-rules";
import { CourseOutline } from "@/components/course-outline";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import type { Course } from "@/lib/course";
import { done, is, part } from "./check";

part("Matching");
{
  const match = (q: string, title: string) => lessonMatches(queryWords(q), findKey(title));
  is("case, accents and punctuation do not matter", [match("lecon", "Leçon 2"), match("Q&A", "Live Q & A"), match("PRICING", "Your pricing page")], [true, true, true]);
  is("every word typed must be there", [match("pricing page", "Your pricing page"), match("pricing email", "Your pricing page")], [true, false]);
  is("each word as the start of a word, so a stub finds it while typing", [match("pri", "Your pricing page"), match("icing", "Your pricing page")], [true, false]);
  is("an empty query keeps everything", [match("", "Anything"), match("   ", "Anything")], [true, true]);
  is(`a query is read to ${FIND_MAX_CHARS} characters`, queryWords(`${"a".repeat(FIND_MAX_CHARS)} extra`).join(" ").length <= FIND_MAX_CHARS, true);
  is("scripts other than Latin are matched too", match("урок", "Первый урок"), true);
}

part("What the outline carries");
{
  const course = {
    id: "c".repeat(32),
    modules: [
      { id: "mod000000001", title: "Getting started", dripDays: 0, lessons: [{ id: "les000000001", title: "Welcome & setup", video: null, preview: false }, { id: "les000000002", title: "Your first sale", video: null, preview: false }] },
      { id: "mod000000002", title: "Pricing", dripDays: 0, lessons: [] },
    ],
  } as unknown as Course;
  const html = renderToStaticMarkup(createElement(CourseOutline, { course, base: "/@shop/course/p", start: 0, done: new Set<string>() }));
  is("each lesson's words: its title and its module's", [...html.matchAll(/data-find="([^"]*)"/g)].map((m) => m[1]), ["welcome setup getting started", "your first sale getting started"]);
  is("each module marked, empty ones too", (html.match(/data-find-module=""/g) ?? []).length, 2);
}

part("Offered from FIND_MIN_LESSONS lessons");
{
  const page = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
  is("the course page counts the lessons and wraps the outline only then", /course\.modules\.reduce\(\(n, unit\) => n \+ unit\.lessons\.length, 0\) >= FIND_MIN_LESSONS \? \(\s*<CourseFind language=\{store\.language\}>\s*<CourseOutline/.test(page), true);
  is(`a course shorter than ${FIND_MIN_LESSONS} lessons is read at a glance`, FIND_MIN_LESSONS, 8);
}

part("Every buyer language");
{
  for (const [lang, w] of Object.entries(COURSES_WORDS)) {
    const lines = [w.findLabel, w.findMatches(1), w.findMatches(5), w.findNone("xyz")];
    is(`${lang}: the label, one, many, none`, lines.every((l) => typeof l === "string" && l.length > 3) && w.findMatches(5).includes("5") && w.findNone("xyz").includes("xyz") && w.findMatches(1) !== w.findMatches(5).replace("5", "1"), true);
    if (lang !== "en") is(`${lang}: not left in English`, [w.findLabel === COURSES_WORDS.en.findLabel, w.findMatches(5) === COURSES_WORDS.en.findMatches(5)], [false, false]);
  }
}

done();
