/**
 * "What a student sees" in the course editor (399 [SL3], unit 3; added
 * 2 November 2026): the course on a chosen day, by the course page's own
 * rules, on synthetic courses only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { CourseDayPreview } from "@/components/course-day-preview";
import { type Course, type CourseModule, type Lesson, isOpen } from "@/lib/course";
import { heldBack } from "@/lib/quiz";
import { courseOnDay, dayWords, lastOpeningDay, lessonStateWords, previewMatters } from "@/lib/course-preview";
import { done, is, part } from "./check";

const lesson = (id: string, extra: Partial<Lesson> = {}): Lesson => ({ id, title: `Lesson ${id}`, preview: false, video: null, files: [], link: null, hasBody: true, quiz: null, ...extra });
const unit = (id: string, dripDays: number, lessons: Lesson[]): CourseModule => ({ id, title: `Module ${id}`, dripDays, lessons });
const course = (modules: CourseModule[], startsAt: number | null = null): Course => ({ id: "c1", modules, certificate: false, startsAt });
const quiz = { questions: 3, passPercent: 70, attempts: 0, required: true };

const weekly = course([unit("m1", 0, [lesson("a"), lesson("b")]), unit("m2", 7, [lesson("c"), lesson("d", { preview: true })]), unit("m3", 14, [lesson("e")])]);
const states = (c: Course, day: number) => courseOnDay(c, day).map((m) => [m.open, m.lessons.map((l) => l.state)]);

part("A course whose modules open days after each student joins");
is("day 0: only the first module, and a free preview lesson anywhere", states(weekly, 0), [[true, ["open", "open"]], [false, ["waits", "free"]], [false, ["waits"]]]);
is("day 6: still the first", states(weekly, 6).map(([open]) => open), [true, false, false]);
is("day 7: the second opens", states(weekly, 7).map(([open]) => open), [true, true, false]);
is("day 14: everything", states(weekly, 14).map(([open]) => open), [true, true, true]);
is("each module says the day it opens", courseOnDay(weekly, 0).map((m) => m.opensOnDay), [0, 7, 14]);
is("the days run to the last opening", lastOpeningDay(weekly), 14);
is("a count for the day, and from when everything is open", [dayWords(courseOnDay(weekly, 0), 0, 14), dayWords(courseOnDay(weekly, 14), 14, 14), dayWords(courseOnDay(weekly, 30), 30, 14)], ["3 of 5 lessons open.", "5 of 5 lessons open. Every module is open from day 14.", "5 of 5 lessons open. Every module is open from day 14."]);
is("a day that cannot be read is day 0; a part of a day counts as the whole days before it", [states(weekly, -3), states(weekly, Number.NaN), states(weekly, 7.5)], [states(weekly, 0), states(weekly, 0), states(weekly, 7)]);
is("a lesson waiting for its module says the day", lessonStateWords(courseOnDay(weekly, 0)[1].lessons[0]), "Opens on day 7, with its module");

part("The same rule as the course page");
// The page asks isOpen(course, unit, joinedSeconds, now); here a student joined at 0 and it is `day` days later.
is("open exactly as isOpen says, every module and day", [0, 1, 6, 7, 13, 14, 30].every((d) => weekly.modules.every((m, i) => courseOnDay(weekly, d)[i].open === isOpen(weekly, m, 0, d * 86_400))), true);
const start = Date.UTC(2026, 10, 9) / 1000;
const cohort = course([unit("m1", 0, [lesson("a")]), unit("m2", 7, [lesson("b")])], start);
is("a cohort counts from its start date", [states(cohort, 0), states(cohort, 7)], [[[true, ["open"]], [false, ["waits"]]], [[true, ["open"]], [true, ["open"]]]]);
is("as isOpen says on that date, for a student who joined before or after the start alike", [0, 6, 7].every((d) => cohort.modules.every((m, i) => [start - 5 * 86_400, start + 3 * 86_400].every((joined) => courseOnDay(cohort, d)[i].open === isOpen(cohort, m, joined, start + d * 86_400)))), true);

part("Lessons a quiz or an assignment holds shut");
const gated = course([unit("m1", 0, [lesson("a"), lesson("q", { title: "Check yourself", quiz }), lesson("b"), lesson("f", { preview: true })]), unit("m2", 0, [lesson("c"), lesson("t", { title: "Your plan", task: { review: false, gate: true, file: false } })])]);
is("after an unpassed required quiz, the rest waits for it; the quiz lesson itself is open", courseOnDay(gated, 0).flatMap((m) => m.lessons.map((l) => l.state)), ["open", "open", "held", "free", "held", "held"]);
is("held as heldBack says for a student who passed nothing", courseOnDay(gated, 0).flatMap((m) => m.lessons.filter((l) => l.state === "held").map((l) => l.id)), [...heldBack(gated, new Set()).keys()].filter((id) => id !== "f"));
is("each says what it waits for, in words", courseOnDay(gated, 0)[0].lessons.map(lessonStateWords), ["Open", "Open", "Opens once the quiz in “Check yourself” is passed", "Free preview: open to anyone"]);
const task = course([unit("m1", 0, [lesson("t", { title: "Your plan", task: { review: false, gate: true, file: false } }), lesson("b")])]);
is("an assignment that must be handed in", lessonStateWords(courseOnDay(task, 0)[0].lessons[1]), "Opens once the work in “Your plan” is handed in");
const reviewed = course([unit("m1", 0, [lesson("t", { title: "Your plan", task: { review: true, gate: true, file: false } }), lesson("b")])]);
is("an assignment the creator reviews: approved, not just handed in", lessonStateWords(courseOnDay(reviewed, 0)[0].lessons[1]), "Opens once you approve the work handed in for “Your plan”");
is("an assignment that does not hold the rest holds nothing", courseOnDay(course([unit("m1", 0, [lesson("t", { task: { review: true, gate: false, file: false } }), lesson("b")])]), 0)[0].lessons.map((l) => l.state), ["open", "open"]);
const later = course([unit("m1", 0, [lesson("q", { quiz })]), unit("m2", 7, [lesson("c")]), unit("m3", 0, [])]);
is("a held lesson in a module not open yet waits for the module first; a module with no lessons is said", [courseOnDay(later, 0)[1].lessons[0].state, courseOnDay(later, 7)[1].lessons[0].state, courseOnDay(later, 0)[2].lessons], ["waits", "held", []]);
is("a quiz that is not required holds nothing", courseOnDay(course([unit("m1", 0, [lesson("q", { quiz: { ...quiz, required: false } }), lesson("b")])]), 0)[0].lessons.map((l) => l.state), ["open", "open"]);

part("Shown only when something depends on the day or a quiz");
is("not for a course where everything opens at once", [previewMatters(course([unit("m1", 0, [lesson("a")])])), previewMatters(weekly), previewMatters(cohort), previewMatters(gated), previewMatters(task)], [false, true, true, true, true]);
is("nothing drawn then", renderToStaticMarkup(createElement(CourseDayPreview, { course: course([unit("m1", 0, [lesson("a")])]) })), "");

part("On the page");
const html = renderToStaticMarkup(createElement(CourseDayPreview, { course: weekly }));
is("a heading, a labeled field, and the day's summary read with the field, never announced on its own", [html.includes('<h2 id="course-day-title"'), html.includes('<label for="course-day"'), html.includes('min="0"'), html.includes('aria-describedby="course-day-hint course-day-summary"'), html.includes('id="course-day-summary"'), /aria-live|role="status"/.test(html)], [true, true, true, true, true, false]);
is("the hint says where the days count from and when the last module opens", html.includes("Day 0 is the day they join. The last module opens on day 14."), true);
const atOnce = renderToStaticMarkup(createElement(CourseDayPreview, { course: course([unit("m1", 0, [lesson("q", { quiz }), lesson("b")])]) }));
is("with nothing waiting for a day, no field: only day 0", [atOnce.includes('id="course-day"'), atOnce.includes("Every module opens the day a student joins."), atOnce.includes("Day 0: 1 of 2 lessons open.")], [false, true, true]);
const cohortHtml = renderToStaticMarkup(createElement(CourseDayPreview, { course: cohort }));
is("a cohort says what happens before its start, and the date of the day", [cohortHtml.includes("Before the start date, only free preview lessons open."), cohortHtml.includes("Day 0 (November 9 (UTC))")], [true, true]);
is("what each lesson is is said in words, never by color or a sign alone", ["— Open", "— Opens on day 7, with its module", "— Free preview: open to anyone", "Opens on day 7"].every((w) => html.includes(w)), true);
is("the field says where the days count from", [html.includes("Days after a student joins"), cohortHtml.includes("Days after the course starts")], [true, true]);
const editor = readFileSync("components/course-editor.tsx", "utf8");
is("the editor draws it from its modules and the start date the server last drew", editor.includes("<CourseDayPreview course={{ ...course, startsAt: initial.startsAt }} />"), true);
is("it reads, writes and sends nothing", /fetch\(|run\(|router|toast/.test(readFileSync("components/course-day-preview.tsx", "utf8")), false);

done();
