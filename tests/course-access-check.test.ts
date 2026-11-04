/**
 * 98 [D2-COMPLIANCE-REVIEW] unit 2: "Can everyone follow your lessons?" in
 * the course editor (lib/course-access-check.ts, AX274 Part A item 6: the
 * studio warns about a video with no captions and offers the fix; it never
 * changes the creator's content). Read only from what the course page
 * already reads: the course, each video's state and its caption languages.
 *
 * Checked: a course with no video gets nothing; a lesson video that can take
 * captions and has none is named, in course order, with a link that opens
 * that lesson at its captions; one with captions, or with captions being
 * written, is not named; a video still uploading or that failed is left to
 * its own state; a video kept where captions cannot be added is counted
 * apart and never called fine; nothing claims the course is accessible.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { CourseAccessCheck } from "@/components/course-access-check";
import { captionsAnchor, lessonCaptionCheck } from "@/lib/course-access-check";
import type { Course } from "@/lib/course";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const folder = "f".repeat(32);
const sv = (lesson: string, n: number) => `stream/${folder}/${lesson}/${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
const file = (pathname: string) => ({ pathname, name: "lesson.mp4", bytes: 10, contentType: "video/mp4", addedAt: "2026-10-31T00:00:00.000Z" });
const lesson = (id: string, title: string, video: string | null) => ({ id, title, video: video ? file(video) : null }) as unknown as Course["modules"][number]["lessons"][number];
const course = (lessons: ReturnType<typeof lesson>[][]) =>
  ({ id: "c1", modules: lessons.map((list, i) => ({ id: `m${i}`, title: `Module ${i + 1}`, dripDays: 0, lessons: list })), certificate: false, startsAt: null }) as unknown as Course;

function main(): void {
  part("Nothing to say about a course with no video");
  is("no lesson video: no check", lessonCaptionCheck(course([[lesson("aaaaaaaaaaaa", "Welcome", null)]]), {}, {}, {}), null);

  part("Who is named, and who is not");
  const a = sv("aaaaaaaaaaaa", 1);
  const b = sv("bbbbbbbbbbbb", 2);
  const c = sv("cccccccccccc", 3);
  const d = sv("dddddddddddd", 4);
  const e = sv("eeeeeeeeeeee", 5);
  const full = course([
    [lesson("aaaaaaaaaaaa", "Getting started", a), lesson("bbbbbbbbbbbb", "Your first loaf", b)],
    [lesson("cccccccccccc", "Shaping", c), lesson("dddddddddddd", "Scoring", d), lesson("eeeeeeeeeeee", "Baking", e), lesson("ffffffffffff", "Old upload", `files/${folder}/old.mp4`)],
  ]);
  const states = { [a]: "ready", [b]: "working", [c]: "ready", [d]: "upload", [e]: "ready" } as const;
  const captions = { [c]: [{ lang: "en", label: "English" }] };
  const writing = { [e]: ["en"] };
  const check = lessonCaptionCheck(full, states, captions, writing);
  is("a ready or preparing video with no captions is named, in course order, with where it is", check?.missing, [{ id: "aaaaaaaaaaaa", title: "Getting started", module: 1, lesson: 1 }, { id: "bbbbbbbbbbbb", title: "Your first loaf", module: 1, lesson: 2 }]);
  is("one with captions, or with captions being written, is not; one still uploading is counted apart", [check?.writing, check?.notReady, check?.done], [1, 1, false]);
  is("a video kept where captions cannot be added is named apart, never as fine", check?.elsewhere, [{ id: "ffffffffffff", title: "Old upload", module: 2, lesson: 4 }]);
  const all = lessonCaptionCheck(full, { ...states, [d]: "ready" }, { [a]: [{ lang: "en", label: "English" }], [b]: [{ lang: "es", label: "Español" }], [c]: [{ lang: "en", label: "English" }], [d]: [{ lang: "en", label: "English" }] }, writing);
  is("every video that can take captions has them: not done while one is kept elsewhere", [all?.missing, all?.done, all?.elsewhere.length], [[], false, 1]);
  // A video still uploading, or that could not be prepared, is never covered by "every lesson video has captions" (independent review, 31/10/2026).
  const pending = lessonCaptionCheck(course([[lesson("aaaaaaaaaaaa", "Getting started", a), lesson("bbbbbbbbbbbb", "Your first loaf", b)]]), { [a]: "ready", [b]: "failed" }, { [a]: [{ lang: "en", label: "English" }] }, {});
  is("one captioned and one that failed: not done", [pending?.done, pending?.notReady], [false, 1]);
  const clean = lessonCaptionCheck(course([[lesson("aaaaaaaaaaaa", "Getting started", a)]]), { [a]: "ready" }, { [a]: [{ lang: "en", label: "English" }] }, {});
  is("only captioned videos: done", [clean?.done, clean?.missing], [true, []]);

  part("What the creator sees");
  const hrefOf = (id: string) => `/studio/course/p1?store=s1&lesson=${id}#${captionsAnchor(id)}`;
  const draw = (c: typeof check, o: Partial<{ canWrite: boolean; canReupload: boolean }> = {}) =>
    renderToStaticMarkup(CourseAccessCheck({ check: c, productId: "p1", hrefOf, canWrite: o.canWrite ?? true, canReupload: o.canReupload ?? true }));
  const html = draw(check);
  is("a heading that asks the question", html.includes("<h2") && html.includes("Can everyone follow your lessons?"), true);
  is("each lesson named, with a link that keeps the store and opens it at its captions", [html.includes("Getting started"), html.includes(`href="/studio/course/p1?store=s1&amp;lesson=aaaaaaaaaaaa#${captionsAnchor("aaaaaaaaaaaa")}"`), html.includes("Add captions to “Getting started” (module 1, lesson 1)")], [true, true, true]);
  is("AI captions offered only to who can have them", [html.includes("have them written for you there"), draw(check, { canWrite: false }).includes("have them written")], [true, false]);
  is("upload again only where it reaches the video service, naming the lesson and the button", [/Replace the video/.test(html), html.includes("Old upload"), /Replace the video/.test(draw(check, { canReupload: false }))], [true, true, false]);
  is("a video still uploading or not prepared is said, so done is never claimed over it", /still uploading or could not be prepared/.test(html), true);
  is("the list says it is as of when the page opened", /when this page opened/.test(html), true);
  is("a title is never markup", draw({ ...check!, missing: [{ id: "aaaaaaaaaaaa", title: "<b>x</b>", module: 1, lesson: 1 }] }).includes("<b>x</b>"), false);
  is("what is being written, and what is kept elsewhere, said plainly", [/being written/.test(html), /cannot be added/.test(html)], [true, true]);
  is("no claim the course is accessible or compliant", /\b(accessible|compliant|WCAG|AAA)\b/i.test(html.replace("Can everyone follow your lessons?", "")), false);
  const doneHtml = draw(clean);
  is("done says so", doneHtml.includes("Every lesson video has captions"), true);
  is("no check, nothing drawn", draw(null), "");
  // Never the id of the Captions part's language menu (`captions-<lesson>`), which its label names (independent review, 31/10/2026).
  is("the anchor is a stable id of its own for the lesson's captions", [captionsAnchor("aaaaaaaaaaaa"), captionsAnchor("aaaaaaaaaaaa") !== "captions-aaaaaaaaaaaa"], ["lesson-captions-aaaaaaaaaaaa", true]);

  part("Where it is drawn");
  const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  const editor = readFileSync("components/course-editor.tsx", "utf8");
  is("the course page draws it from what it already read, with no read more", /<CourseAccessCheck\s+check=\{lessonCaptionCheck\(course, streams, captions, writing\)\}/.test(page), true);
  is("its links keep the store, as every studio link does", /hrefOf=\{\(id\) => `\$\{studioPath\(store, `lesson=\$\{encodeURIComponent\(id\)\}`, `course\/\$\{product\.id\}`\)\}#\$\{captionsAnchor\(id\)\}`\}/.test(page), true);
  is("the language menu keeps its own id, and the anchor is the Captions title, which takes focus", [/const selectId = `captions-\$\{lessonId\}`/.test(editor), /<p id=\{captionsAnchor\(lessonId\)\} tabIndex=\{-1\} className="field-label">Captions<\/p>/.test(editor)], [true, true]);
  is("and opens the lesson linked to, only when it is one of this course's", /openFirst=\{typeof query\.lesson === "string" && lessonsInOrder\(course\)\.some\(\(\{ lesson \}\) => lesson\.id === query\.lesson\) \? query\.lesson : null\}/.test(page), true);
  is("the editor starts with that lesson open", /useState<string \| null>\(openFirst\)/.test(editor), true);
  done();
}

main();
