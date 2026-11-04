/**
 * Ready course structures (540 [CU1], unit 1, lib/course-templates.ts;
 * added 1 November 2026). Checked: the five structures the item names; each
 * applied through the course's own edits to an empty course gives exactly
 * its modules, lessons, opening days and certificate; an existing course is
 * never written over; limits hold; example titles are neutral and marked as
 * examples; the challenge is not tied to the challenge funnel while that
 * funnel wants a free course and a course here is always sold (unit 2's review).
 */
import { COURSE_TEMPLATES, FIT_WORDS, applyTemplate, exampleTitlesLeft, templateFits } from "@/lib/course-templates";
import { emptyCourse, type Course } from "@/lib/course";
import { readFileSync } from "node:fs";
import { FUNNEL_TYPES } from "@/lib/funnel-types";
import { done, is, part } from "./check";


part("The five structures");
is("as the item names them", COURSE_TEMPLATES.map((t) => t.name), ["Mini course", "Weekly course", "5-day challenge", "Course with quizzes and a certificate", "Start from scratch"]);
is("each says what it is in a sentence", COURSE_TEMPLATES.every((t) => t.about.length > 15 && t.about.endsWith(".")), true);

part("Applied through the course's own edits, all at once");
for (const template of COURSE_TEMPLATES.filter((t) => t.modules.length)) {
  const applied = applyTemplate(emptyCourse(), template);
  const course = applied.ok ? applied.course : emptyCourse();
  is(`${template.name}: exactly its modules, lessons, opening days and certificate, the new course's empty module gone`, [applied.ok, course.modules.map((m) => [m.title, m.lessons.map((l) => l.title), m.dripDays]), course.certificate], [true, template.modules.map((m) => [m.title, m.lessons, m.dripDays]), template.certificate]);
}
is("the challenge opens one lesson a day", COURSE_TEMPLATES.find((t) => t.id === "challenge")!.modules.map((m) => [m.lessons.length, m.dripDays]), [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]]);
is("the weekly course opens a module each week", COURSE_TEMPLATES.find((t) => t.id === "weekly")!.modules.map((m) => m.dripDays), [0, 7, 14, 21]);
const scratch = applyTemplate(emptyCourse(), COURSE_TEMPLATES.find((t) => t.id === "scratch")!);
is("start from scratch leaves the new course as it is", scratch.ok && scratch.course.modules.map((m) => m.title), ["Module 1"]);
is("each structure fits through the writing help's own caps (8 modules, 8 lessons each)", COURSE_TEMPLATES.every((t) => t.modules.length <= 8 && t.modules.every((m) => m.lessons.length <= 8)), true);

part("Never over a course the creator touched");
const touched = (change: Partial<Course> | ((c: Course) => Course)) => { const c = emptyCourse(); return typeof change === "function" ? change(c) : { ...c, ...change }; };
for (const [what, course] of [
  ["a module renamed", touched((c) => ({ ...c, modules: [{ ...c.modules[0], title: "Getting started" }] }))],
  ["an opening day set", touched((c) => ({ ...c, modules: [{ ...c.modules[0], dripDays: 3 }] }))],
  ["a second module added", touched((c) => ({ ...c, modules: [...c.modules, { ...c.modules[0], id: "x".repeat(12) }] }))],
  ["a lesson", touched((c) => ({ ...c, modules: [{ ...c.modules[0], lessons: [{ id: "l".repeat(12), title: "Mine", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }] }] }))],
  ["the certificate on", touched({ certificate: true })],
  ["a start date", touched({ startsAt: 1_800_000_000 })],
] as const) {
  is(`${what}: refused, nothing changed`, [templateFits(course), applyTemplate(course, COURSE_TEMPLATES[0]).ok], [{ ok: false, why: "not-new" }, false]);
}
is("said plainly", FIT_WORDS["not-new"].includes("stays as it is"), true);

part("Example titles left before publishing");
const fresh = applyTemplate(emptyCourse(), COURSE_TEMPLATES.find((t) => t.id === "weekly")!);
is("a new structure: every title is still an example", fresh.ok && exampleTitlesLeft(fresh.course), 16);
is("a course with its own titles: none", exampleTitlesLeft({ modules: [{ id: "m", title: "Week 1: bread", dripDays: 0, lessons: [{ id: "l", title: "Starter" }] }] } as never), 0);

part("Example titles, neutral and marked");
const titles = COURSE_TEMPLATES.flatMap((t) => t.modules.flatMap((m) => [m.title, ...m.lessons]));
is("every title says it is an example to replace", titles.every((t) => t.includes("your title here") || t.includes("add your questions here")), true);
const words = COURSE_TEMPLATES.flatMap((t) => [t.about, ...t.modules.flatMap((m) => [m.title, ...m.lessons])]).join(" ");
is("no result, promise, money, percent or testimonial", /\$|%|guarantee|results?\b|earn|income|proven|transform|testimonial|best-selling|students say/i.test(words), false);

part("Never pointed at a funnel it cannot fill");
const challengeFunnel = FUNNEL_TYPES.find((f) => f.id === "challenge");
is("the challenge funnel wants a free course", JSON.stringify(challengeFunnel).includes('"wants":"free"'), true);
is("and a course is sold, so the challenge names no funnel until a course can be free", [readFileSync("lib/store.ts", "utf8").includes("A course is sold"), COURSE_TEMPLATES.find((t) => t.id === "challenge")!.funnel], [true, null]);
done();
