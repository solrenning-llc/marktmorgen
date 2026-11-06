/**
 * 650 [WG10], unit 1: a lesson video remembers where the student stopped, on
 * their own device (lib/lesson-position-rules.ts, components/lesson-player.tsx).
 * Checked: the rules as written; the player drawn for real with nothing
 * offered before the browser reads the device; the lesson page giving it the
 * signed-in student's own key only; the course page forgetting the places
 * once access is not open; and the words in every language.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonPlayer } from "@/components/lesson-player";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import {
  END_MARGIN_SECONDS,
  KEEP_DAYS,
  SAVE_EVERY_SECONDS,
  SPEED_KEY,
  clockOf,
  forgetCoursePlaces,
  keptSpeed,
  positionKey,
  readPlace,
  readSpeed,
  resumeFrom,
  saveDue,
  writePlace,
} from "@/lib/lesson-position-rules";
import { done, is, part } from "./check";

const ADA = "a".repeat(32);
const BEN = "b".repeat(32);
const NOW = 1_800_000_000_000;

part("Where a place is kept: the course, the lesson and the student's own key");
is("a place for one student in one lesson", positionKey("c1", "l1", ADA), `mm:lp:c1:l1:${ADA}`);
is("another student on the same device has another key", positionKey("c1", "l1", BEN) === positionKey("c1", "l1", ADA), false);
is("no key without a learner key (the creator, a visitor), or with an address instead of one", [positionKey("c1", "l1", ""), positionKey("c1", "l1", "ada@example.com")], [null, null]);
is("no key for ids we do not make", [positionKey("c:1", "l1", ADA), positionKey("c1", "l 1", ADA)], [null, null]);

part("Read back whole, or nothing");
is("what was written reads back", readPlace(writePlace(40.7, NOW), NOW + 1_000), { seconds: 40, at: NOW });
is("nothing kept, not JSON, not an object", [readPlace(null, NOW), readPlace("40", NOW), readPlace("[40]", NOW)], [null, null, null]);
is("a time that is not whole, negative, or from the future", [readPlace('{"s":4.5,"t":1}', NOW), readPlace('{"s":-1,"t":1}', NOW), readPlace(JSON.stringify({ s: 40, t: NOW + 3_600_000 }), NOW)], [null, null, null]);
is(`kept ${KEEP_DAYS} days after it was written, not a day more`, [readPlace(writePlace(40, NOW), NOW + KEEP_DAYS * 86_400_000)?.seconds, readPlace(writePlace(40, NOW), NOW + KEEP_DAYS * 86_400_000 + 1)], [40, null]);

part("What is offered back");
is("40 seconds in: continue at 40", resumeFrom({ seconds: 40, at: NOW }, 600), 40);
is("before the length is known, still offered", resumeFrom({ seconds: 40, at: NOW }, null), 40);
is("a few seconds in: nothing to continue", resumeFrom({ seconds: 4, at: NOW }, 600), null);
is(`within ${END_MARGIN_SECONDS} seconds of the end: watched, nothing offered`, [resumeFrom({ seconds: 590, at: NOW }, 600), resumeFrom({ seconds: 589, at: NOW }, 600)], [null, 589]);

part(`At most one write every ${SAVE_EVERY_SECONDS} seconds while playing`);
is("the first one, then not before the time, then again", [saveDue(null, NOW), saveDue(NOW, NOW + 14_999), saveDue(NOW, NOW + 15_000)], [true, false, true]);

part("The time as a player shows it");
is("minutes and seconds, and hours past an hour", [clockOf(40), clockOf(760), clockOf(3723), clockOf(-3)], ["0:40", "12:40", "1:02:03", "0:00"]);

part("The speed kept for the next lessons");
is("a speed from the list reads back; anything else is the normal speed", [readSpeed("1.5"), readSpeed(null), readSpeed("9"), readSpeed("fast")], [1.5, 1, 1, 1]);
is("only speeds from the list are kept", [keptSpeed(1.25), keptSpeed(3)], [true, false]);
is("its key is the device's, not a student's", SPEED_KEY, "mm:lp-speed");

part("Forgetting a course on this device: only that student's places in it");
const keys = new Map<string, string>([
  [`mm:lp:c1:l1:${ADA}`, "x"], [`mm:lp:c1:l2:${ADA}`, "x"], [`mm:lp:c1:l1:${BEN}`, "x"], [`mm:lp:c2:l1:${ADA}`, "x"], [SPEED_KEY, "1.5"], ["other", "x"],
]);
const device = {
  get length() { return keys.size; },
  key: (i: number) => [...keys.keys()][i] ?? null,
  removeItem: (k: string) => void keys.delete(k),
};
is("two removed", forgetCoursePlaces(device, "c1", ADA), 2);
is("the other student's, the other course's, the speed and the rest stay", [...keys.keys()].sort(), [`mm:lp:c1:l1:${BEN}`, `mm:lp:c2:l1:${ADA}`, "mm:lp-speed", "other"].sort());

part("The player as drawn");
const words = { label: "Where you stopped", stopped: (at: string) => `You stopped at ${at} last time.`, resume: (at: string) => `Continue at ${at}`, startOver: "Start over" };
const html = renderToStaticMarkup(createElement(LessonPlayer, { courseId: "c1", lessonId: "l1", learner: ADA, words, src: "/v.mp4", controls: true, preload: "metadata", className: "w-full" }));
is("the same video, with its own controls", /<video[^>]*src="\/v\.mp4"[^>]*controls=""/.test(html), true);
is("nothing offered before the browser has read the device", html.includes("Continue at"), false);

part("The lesson page: hosted video through the player, with the signed-in student's own key only");
const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
is("both hosted players use it", (page.match(/<LessonPlayer\b/g) ?? []).length, 2);
is("no bare hosted <video> left", /<video\b/.test(page), false);
is("the key is the student's (never the creator or a visitor): `who`", (page.match(/learner=\{student \? who : null\}/g) ?? []).length, 2);

part("The course page: places forgotten once the student's access is not open");
const coursePage = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
is("drawn for a signed-in student whose access is not open (refund, lost dispute, ended, taken off)", /access\.state !== "open" && access\.learner && !access\.learner\.owner \? \(\s*<ForgetLessonPositions courseId=\{course\.id\} learner=\{emailKey\(access\.learner\.email\)\} \/>/.test(coursePage), true);

part("The words, in every language");
for (const [code, w] of Object.entries(COURSES_WORDS)) {
  is(`${code}: the time in both sentences, and the rest written`, [w.resumeStopped("12:40").includes("12:40"), w.resumeContinue("12:40").includes("12:40"), w.resumeStartOver.length > 0, w.resumeLabel.length > 0], [true, true, true, true]);
}

done();
