/**
 * 560 [AS1], unit 4: the course's "Next step" right after the student marks
 * its last lesson done (point 1, its second place), never in the middle of the
 * lessons. Each case fails on the wrong behavior: shown on a lesson with one
 * after it, before every lesson is done, when the lessons done could not be
 * read, or on a lesson not marked done.
 *
 * Synthetic values only: nothing is read, written or sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { finishedNow, nextStepPlace } from "@/lib/course-next-step-rules";
import { CourseNextStepCard } from "@/components/course-next-step-card";
import { POST as noThanksRoute } from "@/app/api/store/course/no-thanks/route";

const lessons = ["lessonaaaaa1", "lessonaaaaa2", "lessonaaaaa3"];

test("the moment a student finishes: the last lesson, marked done, with every lesson done", () => {
  const all = new Set(lessons);
  assert.equal(finishedNow({ lessons, done: all, at: "lessonaaaaa3", hasNext: false }), true);
  assert.equal(finishedNow({ lessons, done: all, at: "lessonaaaaa2", hasNext: true }), false, "a lesson with one after it");
  assert.equal(finishedNow({ lessons, done: new Set(["lessonaaaaa1", "lessonaaaaa3"]), at: "lessonaaaaa3", hasNext: false }), false, "one lesson still to do");
  assert.equal(finishedNow({ lessons, done: new Set(["lessonaaaaa1", "lessonaaaaa2"]), at: "lessonaaaaa3", hasNext: false }), false, "this lesson not marked done");
  assert.equal(finishedNow({ lessons, done: null, at: "lessonaaaaa3", hasNext: false }), false, "lessons done not read: not finished");
  assert.equal(finishedNow({ lessons: [], done: new Set(), at: "lessonaaaaa3", hasNext: false }), false, "a course with no lessons");
  // A mark kept for a lesson since taken out does not stand in for one the course has now.
  assert.equal(finishedNow({ lessons, done: new Set(["lessonaaaaa1", "lessonaaaaa3", "lessongone99"]), at: "lessonaaaaa3", hasNext: false }), false);
});

test("on a lesson, the card is drawn only at that moment, read as on the course's page, under the lesson's done row", () => {
  assert.equal(nextStepPlace({ page: "lesson", finishedNow: false }), false);
  assert.equal(nextStepPlace({ page: "lesson", finishedNow: true }), true);
  const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  assert.ok(page.includes("finishedNow({ lessons: order.map((entry) => entry.lesson.id), done, at: lesson.id, hasNext: next !== null })"), "the moment, from the lessons done read exactly");
  assert.ok(page.includes('nextStepPlace({ page: "lesson", finishedNow: finishedHere })'), "nothing in the middle of the lessons");
  assert.ok(page.includes('dismissed: jar.get(nextCookie)?.value === "1"'), "a No thanks kept in the browser is read first");
  assert.ok(page.indexOf("<CourseNextStepCard") > page.indexOf("{w.previousLesson}"), "under the lesson's done row");
  // The same reads as the course's page: nothing of Stripe is asked when the card would not show (tests/as1-next-step-studio.test.ts).
  assert.ok(page.includes("await nextStepFor({ store, course, courseProductId: product.id, email: student.email,"));
});

test("No thanks on the last lesson, without script, goes back to that lesson, not to the course's home (review of #3534, LOW, 3.2.5)", async () => {
  const words = { label: "Next step", see: "See it", noThanks: "No thanks", done: "Done" };
  const card = (lessonId?: string) =>
    renderToStaticMarkup(createElement(CourseNextStepCard, { handle: "nextstep", courseId: "a".repeat(32), productId: "course000001", lessonId, href: "/x", title: "T", price: "$1", line: "", words }));
  assert.match(card("lessonaaaaa3"), /<input type="hidden" name="lesson" value="lessonaaaaa3"\/>/, "the lesson travels with the answer");
  assert.doesNotMatch(card(), /name="lesson"/, "on the course's page there is no lesson to go back to");
  const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
  assert.ok(page.slice(page.indexOf("<CourseNextStepCard")).includes("lessonId={lesson.id}"), "the lesson page passes its lesson");

  const course = "a".repeat(32);
  const post = (host: string, fields: Record<string, string>) =>
    noThanksRoute(new NextRequest(`https://${host}/api/store/course/no-thanks`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host }, body: new URLSearchParams(fields).toString() }));
  const ours = await post("marktmorgen.com", { handle: "nextstep", course, product: "course000001", lesson: "lessonaaaaa3" });
  assert.deepEqual([ours.status, ours.headers.get("location")], [303, "https://marktmorgen.com/@nextstep/course/course000001/lessonaaaaa3"]);
  const own = await post("shop.example.test", { handle: "nextstep", course, product: "course000001", lesson: "lessonaaaaa3" });
  assert.deepEqual([own.status, own.headers.get("location")], [303, "https://shop.example.test/course/course000001/lessonaaaaa3"], "on the store's own domain too");
  const home = await post("marktmorgen.com", { handle: "nextstep", course, product: "course000001" });
  assert.equal(home.headers.get("location"), "https://marktmorgen.com/@nextstep/course/course000001", "no lesson: the course's page, as before");
  const wrong = await post("marktmorgen.com", { handle: "nextstep", course, product: "course000001", lesson: "../../evil" });
  assert.deepEqual([wrong.status, Boolean(wrong.headers.get("set-cookie"))], [400, false], "a lesson not in a lesson's shape is refused and sets nothing");
});
