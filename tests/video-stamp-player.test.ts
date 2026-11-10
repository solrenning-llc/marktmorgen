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
import { StampedPlayer, VideoStamp } from "@/components/video-stamp";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
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
is("both players carry it, and nothing else draws an email over a video", (page.match(/stamp \? \(\s*<StampedPlayer text=\{stamp\}/g) ?? []).length, 2);
is("the page draws the mark only through the stamped player", page.includes("<VideoStamp"), false);

part("Full screen keeps the mark: the stamped player");
const player = renderToStaticMarkup(
  createElement(StampedPlayer, { text: "maya@example.com · Sep 26, 2026", seed: "c1:maya", enter: "Full screen", exit: "Exit full screen" }, createElement("video", { src: "/v.mp4" })),
);
is("the mark and the video in one box, the one put in full screen", /^<div data-stamped-player=""[^>]*><div class="relative overflow-hidden rounded-2xl bg-black"><span aria-hidden="true" data-video-stamp=""[^>]*>[^<]*<\/span><video src="\/v\.mp4"><\/video><\/div>/.test(player), true);
is("its own button, named for what it does", player.includes('<button type="button" class="btn st-btn">Full screen</button>'), true);
is("the button is hidden until the browser says it can go full screen", player.includes('<div data-full-screen-row="" class="hidden"><button'), true);
const component = readFileSync("components/video-stamp.tsx", "utf8");
is("shown only where full screen is supported", /document\.fullscreenEnabled === true && typeof HTMLElement\.prototype\.requestFullscreen === "function"/.test(component) && component.includes('className={can ? "mt-2 flex justify-end" : "hidden"}'), true);
is("it puts the whole box in full screen, never the video alone", component.includes("box.current?.requestFullscreen()") && !/video[^\n]*requestFullscreen/.test(component), true);
is("its name follows the state, from the browser's own event", component.includes('addEventListener("fullscreenchange"') && component.includes("{full ? exit : enter}"), true);
is("a refused request does not break the page", (component.match(/\.catch\(\(\) => \{\}\)/g) ?? []).length, 2);
is("its words in every buyer language, and the two never the same", Object.values(COURSES_WORDS).every((w) => w.fullScreen.trim() !== "" && w.exitFullScreen.trim() !== "" && w.fullScreen !== w.exitFullScreen), true);
is("the page passes those words", (page.match(/enter=\{w\.fullScreen\} exit=\{w\.exitFullScreen\}/g) ?? []).length, 2);

part("Stamped players give up their own full screen; plain ones are as before");
const [streamStamped, streamPlain] = page.slice(page.indexOf('video?.kind === "stream"'), page.indexOf('video?.kind === "file"')).split(") : (");
const [fileStamped, filePlain] = page.slice(page.indexOf('video?.kind === "file"'), page.indexOf('video?.kind === "preparing"')).split(") : (");
is("stamped file player: no full screen, no download, no picture in picture", fileStamped.includes('controlsList="nodownload nofullscreen"') && fileStamped.includes("disablePictureInPicture"), true);
is("stamped service frame: given neither full screen nor picture in picture", streamStamped.includes("<iframe") && !/allowFullScreen|fullscreen|picture-in-picture/.test(streamStamped.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")), true);
is("plain file player unchanged", filePlain.includes('controlsList="nodownload"') && !filePlain.includes("nofullscreen") && !filePlain.includes("disablePictureInPicture") && filePlain.includes('className="mx-auto block max-h-[75vh] w-full object-contain"'), true);
is("plain service frame unchanged", streamPlain.includes('allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen"') && streamPlain.includes("allowFullScreen") && streamPlain.includes("maxWidth: `calc(75vh * ${video.width} / ${video.height})`"), true);
is("plain players have no button and no mark", /StampedPlayer|VideoStamp|fullScreen/.test(filePlain + streamPlain), false);
is("no other email reaches the mark", (page.match(/videoStampText\(/g) ?? []).length, 1);

done();
