/**
 * 291 [SQ2] unit 1: "Find a lesson" on a course's front door
 * (lib/course-search.ts, components/course-search.tsx).
 *
 * A student types a word and the course's own outline narrows to the lessons
 * whose title, or whose module's name, has every word typed. It runs in the
 * student's browser over the outline the page already drew, so it reads
 * nothing more, sends nothing and costs nothing per search; the outline keeps
 * each lesson's real state (open, locked, done, free preview). Without
 * JavaScript nothing is drawn, so no box is shown that cannot work, and the
 * whole outline is there as before. Lesson text and transcripts are unit 2.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COURSE_SEARCH_FROM_LESSONS,
  MAX_COURSE_QUERY,
  MAX_QUERY_WORDS,
  type FindNode,
  foldForSearch,
  narrowDom,
  narrowOutline,
  queryWords,
  showsCourseSearch,
} from "@/lib/course-search";
import { COURSE_SEARCH_WORDS, courseSearchWords } from "@/lib/buyer-words/course-search";
import { CourseSearch } from "@/components/course-search";
import { CourseOutline } from "@/components/course-outline";
import type { Course, Lesson } from "@/lib/course";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

part("Folding: what is typed and what is shown compare alike");
is("case and accents do not matter", foldForSearch("Crème  Brûlée"), "creme brulee");
is("a German sharp s is ss, in either case", [foldForSearch("Straße"), foldForSearch("STRAẞE")], ["strasse", "strasse"]);
is("a curly apostrophe is a straight one", foldForSearch("Don’t panic"), "don't panic");
is("spaces and line breaks collapse", foldForSearch("  one\n\ttwo  "), "one two");

part("The words of a query");
is("split, folded and each kept once", queryWords("Knife  KNIFE grip"), ["knife", "grip"]);
is("an empty or blank query has no words", [queryWords(""), queryWords("   ")], [[], []]);
is(
  "at most a few words, from at most a line of text",
  [queryWords(Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ")).length, queryWords("x".repeat(500))[0].length],
  [MAX_QUERY_WORDS, MAX_COURSE_QUERY],
);

part("Which lessons a query keeps");
const outline = [
  { name: "Module 1 Holding the knife", lessons: ["The grip · video", "The claw"] },
  { name: "Module 2 Cutting", lessons: ["Onions", "Herbs", "A whole chicken"] },
  { name: "Module 3 Sauces", lessons: [] },
];
is("no words: nothing is narrowed", narrowOutline(outline, " "), null);
is("a lesson's own title", narrowOutline(outline, "claw"), {
  modules: [
    { shown: true, lessons: [false, true] },
    { shown: false, lessons: [false, false, false] },
    { shown: false, lessons: [] },
  ],
  matches: 1,
  total: 5,
});
is("every word must be there, from the lesson or its module", narrowOutline(outline, "cutting onions")?.matches, 1);
is("a module's name keeps all its lessons", narrowOutline(outline, "module 2")?.modules[1], { shown: true, lessons: [true, true, true] });
is("a word in no title keeps nothing", narrowOutline(outline, "fillet"), {
  modules: [
    { shown: false, lessons: [false, false] },
    { shown: false, lessons: [false, false, false] },
    { shown: false, lessons: [] },
  ],
  matches: 0,
  total: 5,
});
is("a module with no lessons is not shown as a result", narrowOutline(outline, "sauces")?.modules[2].shown, false);

part("On the outline the page drew");
/** Just enough of an element: what narrowDom reads and sets. */
class Fake implements FindNode {
  hidden = false;
  constructor(
    readonly marks: string[],
    readonly own: string,
    readonly kids: Fake[] = [],
  ) {}
  get textContent(): string {
    return this.own + this.kids.map((kid) => kid.textContent).join("");
  }
  querySelectorAll(selector: string): Fake[] {
    const mark = selector.replace(/^\[|\]$/g, "");
    const found: Fake[] = [];
    const walk = (node: Fake) => {
      for (const kid of node.kids) {
        if (kid.marks.includes(mark)) found.push(kid);
        walk(kid);
      }
    };
    walk(this);
    return found;
  }
}
// The outline draws " · video" beside a title but outside its data-find-text,
// so the fake does too (the drawn markup is checked further down).
const lesson = (title: string, suffix = "") =>
  new Fake(["data-find-lesson"], "", [new Fake([], "○"), new Fake(["data-find-text"], title), new Fake([], suffix), new Fake([], " (done)")]);
const unit = (n: number, title: string, lessons: Fake[]) =>
  new Fake(["data-find-module"], "", [new Fake(["data-find-name"], `Module ${n}`), new Fake(["data-find-name"], title), new Fake([], "", lessons)]);
const root = new Fake([], "", [
  unit(1, "Holding the knife", [lesson("The grip", " · video"), lesson("The claw")]),
  unit(2, "Cutting", [lesson("Onions"), lesson("Herbs"), lesson("A whole chicken")]),
  unit(3, "Sauces", []),
]);
const visible = () =>
  root.querySelectorAll("[data-find-module]").map((m) => [m.hidden, m.querySelectorAll("[data-find-lesson]").map((l) => l.hidden)]);
is("nothing typed: nothing hidden, nothing said", [narrowDom(root, ""), visible()], [null, [[false, [false, false]], [false, [false, false, false]], [false, []]]]);
is("a word: only its lessons and their modules stay", [narrowDom(root, "CLÁW"), visible()], [
  { matches: 1, total: 5 },
  [[false, [true, false]], [true, [true, true, true]], [true, []]],
]);
is("the hidden '(done)' and the marks beside a title are not searched", narrowDom(root, "done")?.matches, 0);
is("the module's number is its name too", narrowDom(root, "module 2")?.matches, 3);
is("the ' · video' beside a title is not searched: the help says titles only", narrowDom(root, "video")?.matches, 0);
is("cleared: everything is back", [narrowDom(root, ""), visible()], [null, [[false, [false, false]], [false, [false, false, false]], [false, []]]]);

part("Shown only where it helps");
is("a short course has no search", [showsCourseSearch(COURSE_SEARCH_FROM_LESSONS - 1), showsCourseSearch(COURSE_SEARCH_FROM_LESSONS)], [false, true]);

part("Its words, in every language a store sells in");
is("every language has them", Object.keys(COURSE_SEARCH_WORDS).sort(), [...LANGUAGE_CODES].sort());
const en = courseSearchWords("en");
is("in plain US English", [en.label, en.idle, en.none, en.some(1, 40), en.some(3, 40), en.clear], [
  "Find a lesson",
  "Type a word from a lesson or module title. The list below then shows only the lessons that match.",
  "No lesson title has those words. Try another word, or clear the search.",
  "1 of 40 lessons matches. It is in the list below.",
  "3 of 40 lessons match. They are in the list below.",
  "Clear the search",
]);
for (const code of LANGUAGE_CODES) {
  const w = courseSearchWords(code);
  const texts = [w.label, w.idle, w.none, w.clear, w.some(1, 40), w.some(3, 40)];
  is(`${code}: every sentence is there and says its numbers`, [texts.every((t) => t.trim().length > 0), w.some(3, 40).includes("3"), w.some(3, 40).includes("40")], [true, true, true]);
  if (code !== "en") is(`${code}: translated, not English`, [w.label, w.idle, w.none, w.clear].some((t, i) => t === [en.label, en.idle, en.none, en.clear][i]), false);
}
is("an unknown language is English", courseSearchWords("xx").label, en.label);

part("No box that cannot work, and nothing sent");
is("without JavaScript it draws nothing", renderToStaticMarkup(createElement(CourseSearch, { outline: "course-outline", language: "en" })), "");
const component = readFileSync("components/course-search.tsx", "utf8");
is("it narrows the drawn outline and calls nothing", [component.includes("narrowDom("), /fetch\(|\/api\/|XMLHttpRequest|sendBeacon/.test(component)], [true, false]);
is(
  "a labeled search field, its result said politely, typed text bounded",
  ['type="search"', "htmlFor={field}", 'aria-live="polite"', "maxLength={MAX_COURSE_QUERY}", '"Escape"'].map((bit) => component.includes(bit)),
  [true, true, true, true, true],
);

part("The count is said once typing pauses, not at every key");
is(
  "the list narrows at once; only the spoken count waits about half a second, and each key restarts the wait",
  [
    component.includes("onChange={(e) => search(e.target.value)}"),
    /const ANNOUNCE_AFTER_MS = 500;/.test(component),
    component.includes("setTimeout(") && component.includes("ANNOUNCE_AFTER_MS"),
    component.includes("clearTimeout("),
  ],
  [true, true, true, true],
);
is("the visible help is not itself live, so a key is not read out at once", /id=\{hint\}[^>]*aria-live/.test(component), false);
is("the spoken count is in its own polite region, empty until there is something to say", /className="sr-only" aria-live="polite"/.test(component), true);

part("The outline carries the marks, the page places the box");
const make = (id: string, title: string): Lesson => ({ id, title, preview: false, video: null, files: [], link: null, hasBody: false, quiz: null });
const clip = { pathname: "private/clip.mp4", name: "clip.mp4", bytes: 1, contentType: "video/mp4", addedAt: "2026-11-07T00:00:00.000Z" };
const course: Course = {
  id: "c".repeat(32),
  certificate: false,
  startsAt: null,
  modules: [
    { id: "m1aaaaaaaaaa", title: "Holding the knife", dripDays: 0, lessons: [{ ...make("l1aaaaaaaaaa", "The grip"), video: clip }, make("l2aaaaaaaaaa", "The claw")] },
    { id: "m2aaaaaaaaaa", title: "Cutting", dripDays: 30, lessons: [make("l3aaaaaaaaaa", "Onions")] },
  ],
};
const drawn = renderToStaticMarkup(createElement(CourseOutline, { course, base: "/@shop/course/p1", start: 0, done: new Set<string>(), language: "en" }));
const count = (mark: string) => drawn.split(mark).length - 1;
is(
  "one mark per module, per module name line, per lesson and per lesson title, locked ones too",
  [count("data-find-module"), count("data-find-name"), count("data-find-lesson"), count("data-find-text")],
  [2, 4, 3, 3],
);
const searched = [...drawn.matchAll(/data-find-text=""[^>]*>([^<]*)</g)].map((m) => m[1]);
is(
  "only the title is searched; ' · video' is still drawn beside it, outside the searched text",
  [searched, drawn.replace(/<[^>]+>/g, "").includes("The grip · video")],
  [["The grip", "The claw", "Onions"], true],
);
const page = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
is(
  "the course page shows it above its outline, only on a course long enough",
  [page.includes("showsCourseSearch(total) ?"), page.includes('<CourseSearch outline="course-outline"'), page.includes('id="course-outline"')],
  [true, true, true],
);

done();
