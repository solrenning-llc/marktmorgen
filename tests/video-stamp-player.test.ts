/**
 * 602 [WP1], unit 2: the buyer's mark drawn over lesson videos
 * (components/video-stamp.tsx), only for a course whose creator switched it
 * on (Course.stampVideo, off by default) and only with the signed-in
 * student's own email. Rendered for real; the page's rule is read from its
 * source, as the other lesson page checks do.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoStamp } from "@/components/video-stamp";
import { emptyCourse, parseCourse } from "@/lib/course";
import { STAMP_SPOTS } from "@/lib/video-stamp";
import { done, is, part } from "./check";

part("The course's switch: off unless switched on");
const course = emptyCourse();
is("a new course has it off", course.stampVideo, undefined);
is("a course saved before it existed reads off", parseCourse(JSON.stringify(course))?.stampVideo, undefined);
is("switched on reads on", parseCourse(JSON.stringify({ ...course, stampVideo: true }))?.stampVideo, true);
is("anything but true reads off", parseCourse(JSON.stringify({ ...course, stampVideo: "yes" }))?.stampVideo, undefined);

part("The mark as drawn");
const html = renderToStaticMarkup(createElement(VideoStamp, { text: "maya@example.com · Sep 26, 2026", seed: "c1:maya" }));
is("its words", html.includes("maya@example.com · Sep 26, 2026"), true);
is("hidden from screen readers", html.includes('aria-hidden="true"'), true);
is("never in the way of a click", html.includes("pointer-events-none"), true);
is("still before the browser says otherwise (server render), in the first place", html.includes(`top:${STAMP_SPOTS[0].top}%`) && html.includes("left:3%"), true);
is("nothing focusable inside", /<(a|button|input)\b|tabindex/i.test(html), false);

part("The lesson page: only the signed-in student's own email, only when switched on");
const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
is("drawn only when the course switched it on and a student is signed in", /const stamp = course\.stampVideo === true && student && start !== null \? videoStampText\(student\.email, "", new Date\(start \* 1000\)\) : null;/.test(page), true);
is("the student is the signed-in one, never the creator", /const student = access\.state === "open" && !access\.learner\.owner \? access\.learner : null;/.test(page), true);
is("both players carry it, and nothing else draws an email over a video", (page.match(/\{stamp \? <VideoStamp text=\{stamp\}/g) ?? []).length, 2);
is("no other email reaches the mark", (page.match(/videoStampText\(/g) ?? []).length, 1);

done();
