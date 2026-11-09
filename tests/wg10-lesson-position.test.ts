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
  placeToRemove,
  positionKey,
  readPlace,
  readSpeed,
  resumeFrom,
  saveDue,
  writePlace,
} from "@/lib/lesson-position-rules";
import { devicePlaceKey } from "@/lib/lesson-position";
import { emailKey } from "@/lib/learn";
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

part("A place past its days, or not one we wrote, is removed as it is read (Claude 4 on #2728)");
is("too old, broken: removed; ours and fresh, or nothing there: left", [placeToRemove(writePlace(40, NOW), NOW + KEEP_DAYS * 86_400_000 + 1), placeToRemove("{broken", NOW), placeToRemove(writePlace(40, NOW), NOW + 1_000), placeToRemove(null, NOW)], [true, true, false, false]);
is("the player removes it when it reads it", /if \(placeToRemove\(raw, now\)\) \{\s*try \{\s*store\.removeItem\(key\);/.test(readFileSync("components/lesson-player.tsx", "utf8")), true);

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
const words = { label: "Where you stopped", stopped: "You stopped at {at} last time.", resume: "Continue at {at}", startOver: "Start over" };
const html = renderToStaticMarkup(createElement(LessonPlayer, { courseId: "c1", lessonId: "l1", learner: ADA, words, src: "/v.mp4", controls: true, preload: "metadata", className: "w-full" }));
is("the same video, with its own controls", /<video[^>]*src="\/v\.mp4"[^>]*controls=""/.test(html), true);
is("nothing offered before the browser has read the device", html.includes("Continue at"), false);

part("The lesson page: hosted video through the player, with the signed-in student's own key only");
const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
is("both hosted players use it", (page.match(/<LessonPlayer\b/g) ?? []).length, 2);
is("no bare hosted <video> left", /<video\b/.test(page), false);
is("the key is made for the signed-in student only (never the creator or a visitor)", /const placeKey = student \? devicePlaceKey\(course\.id, student\.email\) : null;/.test(page), true);
is("both players get that key", (page.match(/learner=\{placeKey\}/g) ?? []).length, 2);

part("The course page: places forgotten once the student's access is not open");
const coursePage = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
is("drawn for a signed-in student whose access is not open (refund, lost dispute, ended, taken off), never on a check that could not be made (24 [E7])", /const forgetKey = access\.state !== "open" && access\.state !== "unchecked" && access\.learner && !access\.learner\.owner \? devicePlaceKey\(course\.id, access\.learner\.email\) : null;/.test(coursePage) && /\{forgetKey \? <ForgetLessonPositions courseId=\{course\.id\} learner=\{forgetKey\} \/> : null\}/.test(coursePage), true);

part("The device key cannot be worked out from an address (Revisor 1 on #2728)");
const dataKey = process.env.NIMBUS_DATA_KEY;
const stripeKey = process.env.STRIPE_SECRET_KEY;
delete process.env.NIMBUS_DATA_KEY;
delete process.env.STRIPE_SECRET_KEY;
is("no server key: no device key, so nothing is kept", devicePlaceKey("c1", "ada@example.com"), null);
process.env.NIMBUS_DATA_KEY = "tests-only-not-a-real-deployment-secret";
const k1 = devicePlaceKey("c1", "Ada@Example.com");
is("made from the course and the address as typed any way, 32 hex", [k1 === devicePlaceKey("c1", "ada@example.com"), /^[0-9a-f]{32}$/.test(k1 ?? "")], [true, true]);
is("not the learner key anyone can compute from the address", k1 === emailKey("ada@example.com"), false);
is("another course, another key; another person, another key", [k1 === devicePlaceKey("c2", "ada@example.com"), k1 === devicePlaceKey("c1", "ben@example.com")], [false, false]);
process.env.NIMBUS_DATA_KEY = "another-tests-only-secret";
is("another server key, another device key", k1 === devicePlaceKey("c1", "ada@example.com"), false);
if (dataKey === undefined) delete process.env.NIMBUS_DATA_KEY; else process.env.NIMBUS_DATA_KEY = dataKey;
if (stripeKey !== undefined) process.env.STRIPE_SECRET_KEY = stripeKey;

part("Said in the privacy policy, and in the person-data registry");
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
is("the policy says places go also when access could not be checked, not only when it ended (Claude 5, LEVE on #2728)", [/because it ended,\s+or\s+because it could not be checked at that moment/.test(privacy), /Once their access to the course ends/.test(privacy)], [true, false]);
is("the policy names both keys, the 90 days, and that nothing is sent to us", [privacy.includes('<p id="lesson-places">'), privacy.includes("<code>mm:lp:</code>"), privacy.includes("<code>mm:lp-speed</code>"), /older than\s+90 days is never used, and is removed the next time that lesson is\s+opened/.test(privacy) && /course page opens in\s+that\s+browser without confirming their access/.test(privacy), /never sent to\s+us/.test(privacy)], [true, true, true, true, true]);
is("the registry line", readFileSync("lib/person-data.ts", "utf8").includes('{ file: "lib/lesson-position.ts", how: "none"'), true);

part("The words, in every language");
for (const [code, w] of Object.entries(COURSES_WORDS)) {
  is(`${code}: the time in both sentences, and the rest written`, [w.resumeStopped("12:40").includes("12:40"), w.resumeContinue("12:40").includes("12:40"), w.resumeStartOver.length > 0, w.resumeLabel.length > 0], [true, true, true, true]);
}

done();
