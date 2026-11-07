/**
 * Chapters a student can jump to in a lesson video (382 [TB8], unit 1; added
 * 7 November 2026).
 *
 * The creator writes them in the lesson's own text, one line each, the way
 * people already write them under a video: "0:00 Welcome", "2:15 Setup". The
 * lesson page lists them under a video uploaded as a file, and each one moves
 * that video to its time. Nothing new is stored, read or sent: the text is
 * the one the page already reads, and the list is worked out from it.
 *
 * Videos played by the video service (lib/stream.ts) get no list yet: its
 * player is in another site's frame, and moving it needs that service's own
 * documented way, which is unit 2. Until then neither the page nor the
 * studio says chapters work there.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type Chapter,
  LESSON_VIDEO_ID,
  MAX_CHAPTERS,
  MAX_CHAPTER_TITLE,
  chapterTime,
  chaptersWithin,
  currentChapter,
  formatChapterTime,
  jumpTo,
  lessonChapters,
} from "@/lib/lesson-chapters";
import { LessonChapters } from "@/components/lesson-chapters";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import { done, is, part } from "./check";

const F = "`".repeat(3);

async function main(): Promise<void> {
  part("A time, as typed");
  is("m:ss", chapterTime("2:15"), 135);
  is("mm:ss", chapterTime("12:05"), 725);
  is("h:mm:ss", chapterTime("1:02:03"), 3723);
  is("0:00 is the start", chapterTime("0:00"), 0);
  is("seconds past 59 are not a time", chapterTime("0:60"), null);
  is("one digit of seconds is not a time", chapterTime("0:5"), null);
  is("minutes past 59 are written with hours", chapterTime("75:00"), null);
  is("minutes under an hour need two digits", chapterTime("1:5:00"), null);
  is("a day or more is not a time in a lesson", chapterTime("24:00:00"), null);
  is("nothing but digits and colons", chapterTime("1:0a"), null);
  is("written back the short way", [0, 135, 600, 3723, 36_000].map(formatChapterTime), ["0:00", "2:15", "10:00", "1:02:03", "10:00:00"]);

  part("Chapters in a lesson's text");
  const plain = ["What this lesson covers.", "", "0:00 Welcome", "2:15 Setup", "1:02:03 - Wrap up"].join("\n");
  is("one per line, from 0:00, in order", lessonChapters(plain), [
    { at: 0, time: "0:00", title: "Welcome" },
    { at: 135, time: "2:15", title: "Setup" },
    { at: 3723, time: "1:02:03", title: "Wrap up" },
  ]);
  is("as a list too", lessonChapters("- 0:00 Welcome\n- 0:30 Next"), [
    { at: 0, time: "0:00", title: "Welcome" },
    { at: 30, time: "0:30", title: "Next" },
  ]);
  is("a blank line between them does not end them", lessonChapters("0:00 One\n\n0:40 Two").length, 2);
  is("a dash, an en dash, an em dash or a bar may sit between time and title", lessonChapters("0:00 - A\n0:10 – B\n0:20 — C\n0:30 | D").map((c) => c.title), ["A", "B", "C", "D"]);
  is("a title's spaces are tidied", lessonChapters("0:00   Big    start\n0:10 Next")[0]?.title, "Big start");
  is("a title is kept to its length", lessonChapters(`0:00 ${"x".repeat(300)}\n0:10 Next`)[0]?.title.length, MAX_CHAPTER_TITLE);
  is("one line alone is not a list of chapters", lessonChapters("0:00 Welcome"), []);
  is("they start at 0:00, or there are none", lessonChapters("0:10 One\n0:40 Two"), []);
  is("a time that goes back makes the whole list wrong, so none is shown", lessonChapters("0:00 A\n0:40 B\n0:30 C"), []);
  is("two at the same time, the same", lessonChapters("0:00 A\n0:40 B\n0:40 C"), []);
  is("a line of other words between them ends the list", lessonChapters("0:00 A\nThen we start.\n0:10 B"), []);
  is("a time with nothing after it is not a chapter", lessonChapters("0:00\n0:10 B"), []);
  is("a meeting time in a sentence is not a chapter", lessonChapters("Live call today.\n3:15 pm in the community room."), []);
  is("the first good list is taken", lessonChapters("0:10 x\n0:20 y\n\n0:00 A\n0:05 B").map((c) => c.title), ["A", "B"]);
  is("never inside code", lessonChapters([F, "0:00 A", "0:10 B", F].join("\n")), []);
  is("a block of code ends a list", lessonChapters(["0:00 A", F, "x", F, "0:10 B"].join("\n")), []);
  const many = Array.from({ length: 60 }, (_, i) => `${formatChapterTime(i * 10)} Part ${i + 1}`).join("\n");
  is(`at most ${MAX_CHAPTERS}`, lessonChapters(many).length, MAX_CHAPTERS);
  is("no text, no chapters", lessonChapters(""), []);

  part("Against the video's own length, once the browser knows it");
  const three: Chapter[] = lessonChapters(plain);
  is("an unknown length keeps them all", chaptersWithin(three, Number.NaN).length, 3);
  is("an endless stream keeps them all", chaptersWithin(three, Number.POSITIVE_INFINITY).length, 3);
  is("a chapter after the end is not offered", chaptersWithin(three, 600).map((c) => c.title), ["Welcome", "Setup"]);
  is("with fewer than two left, none is", chaptersWithin(three, 100), []);
  is("where the video is now", [0, 10, 135, 200, 5000].map((t) => currentChapter(three, t)), [0, 0, 1, 1, 2]);
  is("before anything is known, nothing is marked", currentChapter(three, Number.NaN), -1);

  part("Jumping");
  // A refused play() is a rejected promise: jumpTo must take its refusal, so
  // the page never shows an error for a browser that would not play.
  let refused: Promise<void> | null = null;
  let taken = false;
  const video = {
    currentTime: 0,
    played: 0,
    play() {
      this.played += 1;
      const answer = Promise.reject(new Error("blocked by the browser"));
      refused = answer;
      const own = answer.catch.bind(answer);
      answer.catch = ((fn: (reason: unknown) => unknown) => { taken = true; return own(fn); }) as typeof answer.catch;
      return answer;
    },
  };
  jumpTo(video, 135);
  if (!taken && refused) (refused as Promise<void>).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  is("moves the video to the chapter and plays it", [video.currentTime, video.played], [135, 1]);
  is("a browser that refuses to play is taken quietly", taken, true);
  jumpTo(video, Number.NaN);
  jumpTo(video, -5);
  is("never to a time that is not one", video.currentTime, 135);

  part("On the lesson page");
  const announce = three.map((c) => COURSES_WORDS.en.nowAt(c.time, c.title));
  const html = renderToStaticMarkup(createElement(LessonChapters, { chapters: three, videoId: LESSON_VIDEO_ID, heading: COURSES_WORDS.en.chapters, announce }));
  is("a named section with its own heading", [html.includes(`<nav aria-labelledby="${LESSON_VIDEO_ID}-chapters"`), html.includes(`<h2 id="${LESSON_VIDEO_ID}-chapters"`), html.includes(">Chapters</h2>")], [true, true, true]);
  is("in order, one button each", [html.includes("<ol"), (html.match(/<button type="button"/g) ?? []).length], [true, 3]);
  is("each button says its time and its title", [html.includes(">2:15<"), html.includes(">Setup<")], [true, true]);
  is("each button is at least 44 pixels high", (html.match(/min-h-11/g) ?? []).length, 3);
  is("a quiet place that says where the video went", html.includes('role="status"'), true);
  const odd = renderToStaticMarkup(createElement(LessonChapters, { chapters: lessonChapters("0:00 <b>Hi</b>\n0:10 Next"), videoId: LESSON_VIDEO_ID, heading: "Chapters", announce: ["", ""] }));
  is("a title is text, never markup", [odd.includes("&lt;b&gt;Hi&lt;/b&gt;"), odd.includes("<b>")], [true, false]);
  is("nothing at all with fewer than two", renderToStaticMarkup(createElement(LessonChapters, { chapters: three.slice(0, 1), videoId: LESSON_VIDEO_ID, heading: "Chapters", announce })), "");

  const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  is("both players of an uploaded file carry the id the list moves", (page.match(/<video\s[^>]*id=\{LESSON_VIDEO_ID\}/g) ?? []).length, 2);
  is("no frame of the video service carries it", (page.match(/<iframe\s[^>]*LESSON_VIDEO_ID/g) ?? []).length, 0);
  is("chapters only for an uploaded file, from the text already read", /const chapters = video\?\.kind === "file" \? lessonChapters\(body\) : \[\];/.test(page), true);
  is("shown once, under the video", (page.match(/<LessonChapters\b/g) ?? []).length, 1);

  part("In every language of a store");
  for (const [code, words] of Object.entries(COURSES_WORDS)) {
    const said = words.nowAt("2:15", "Setup");
    is(`${code}: a heading and a line that names the time and the title`, [Boolean(words.chapters.trim()), said.includes("2:15"), said.includes("Setup")], [true, true, true]);
  }

  part("In the studio");
  const editor = readFileSync("components/course-editor.tsx", "utf8");
  const hint = editor.indexOf('"0:00 Welcome"');
  is("the lesson text says how to write chapters", hint > 0, true);
  is("only under a video uploaded as a file, where they work", editor.slice(Math.max(0, hint - 400), hint).includes("lesson.video && !isStreamPath(lesson.video.pathname)"), true);

  part("Nothing stored, read or sent");
  const lib = readFileSync("lib/lesson-chapters.ts", "utf8");
  const parts = readFileSync("components/lesson-chapters.tsx", "utf8");
  is("no storage and no network in either", [/redis|store-data|fetch\(/.test(lib), /redis|store-data|fetch\(/.test(parts)], [false, false]);
}

void main().then(done, (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
