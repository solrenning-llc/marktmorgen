/**
 * The free students' video ceiling (541 [FC4], unit 1,
 * lib/free-course-video-rules.ts; added 1 November 2026). Checked: the
 * owner's 20% maximum and the creator's lower choice, nothing above it; the
 * share of the store's own limit as playback reads it, a trial's hour
 * included; both ceilings before a free lesson's video; "off" when the
 * creator gave none, never "comes back"; anything unknown frames nothing;
 * plain words, with minutes under an hour. What measured figures alone
 * cannot promise (the rest held for students who paid, against the
 * meter's hour of delay) is the next unit's reservation, and is not claimed.
 */
import { readFileSync } from "node:fs";
import { FREE_VIDEO_MAX_PERCENT, freeVideoAdmission, freeVideoSeconds, freeVideoWords, readFreeVideoPercent } from "@/lib/free-course-video-rules";
import { PAID_VIDEO_HOURS, TRIAL_VIDEO_SECONDS, paidVideoSeconds } from "@/lib/video-admission-rules";
import { done, is, part } from "./check";

part("The owner's maximum and the creator's choice");
is("20% at most, by the owner's decision of 1 November 2026", FREE_VIDEO_MAX_PERCENT, 20);
is("not chosen yet: the maximum, so a free course works without a setting", readFreeVideoPercent(undefined), 20);
is("a lower choice is kept", [readFreeVideoPercent(10), readFreeVideoPercent("5"), readFreeVideoPercent(0), readFreeVideoPercent("0")], [10, 5, 0, 0]);
is("nothing above the maximum", [readFreeVideoPercent(21), readFreeVideoPercent(100), readFreeVideoPercent("80")], [20, 20, 20]);
is("anything that is not a whole percent is none, never more", [readFreeVideoPercent(-1), readFreeVideoPercent(12.5), readFreeVideoPercent("lots"), readFreeVideoPercent(null), readFreeVideoPercent(""), readFreeVideoPercent("0x14"), readFreeVideoPercent("1e1")], [0, 0, 0, 0, 0, 0, 0]);

part("The share of the store's own limit");
is("Studio's 32 hours at 20%: 6.4 hours", freeVideoSeconds(paidVideoSeconds("pro"), 20), Math.floor(PAID_VIDEO_HOURS.pro * 3600 * 0.2));
is("a store in its free trial: a fifth of its hour, 12 minutes, never a fifth of the paid plan", freeVideoSeconds(Math.min(paidVideoSeconds("pro"), TRIAL_VIDEO_SECONDS), 20), 12 * 60);
is("rounded down", freeVideoSeconds(7, 20), 1);
is("a limit not known: none", [freeVideoSeconds(null, 20), freeVideoSeconds(-5, 20), freeVideoSeconds(1.5, 20)], [null, null, null]);
is("the limit is the one playback reads, written down where the next unit wires it", readFileSync("lib/free-course-video-rules.ts", "utf8").includes("lib/plan-standing.ts, videoLimitFor"), true);

part("Before a free lesson's video, on the measured figures");
const limit = paidVideoSeconds("pro");
const cap = freeVideoSeconds(limit, 20)!;
is("room in both: it plays", freeVideoAdmission({ limitSeconds: limit, percent: 20, watchedAll: 1000, watchedFree: cap - 1 }), "play");
is("the free share used: paused, though the store has room", freeVideoAdmission({ limitSeconds: limit, percent: 20, watchedAll: cap, watchedFree: cap }), "paused");
is("the store's whole limit used: paused too", freeVideoAdmission({ limitSeconds: limit, percent: 20, watchedAll: limit, watchedFree: 0 }), "paused");
is("a creator who gave free students no video: off, never \"comes back\"", [freeVideoAdmission({ limitSeconds: limit, percent: 0, watchedAll: 0, watchedFree: 0 }), freeVideoAdmission({ limitSeconds: 0, percent: 20, watchedAll: 0, watchedFree: 0 })], ["off", "off"]);
is("a figure that could not be read: nothing framed", [freeVideoAdmission({ limitSeconds: limit, percent: 20, watchedAll: null, watchedFree: 0 }), freeVideoAdmission({ limitSeconds: limit, percent: 20, watchedAll: 0, watchedFree: null }), freeVideoAdmission({ limitSeconds: null, percent: 20, watchedAll: 0, watchedFree: 0 })], ["unknown", "unknown", "unknown"]);

part("In the studio's words");
is("hours, in each period of the plan", freeVideoWords(limit, 20), "Students of free courses can watch up to 6.4 hours of video in each period of your plan, 20% of your plan's video. The rest is for students who paid.");
is("under an hour, in minutes: Store's 4 hours at 5%", freeVideoWords(paidVideoSeconds("creator"), 5), "Students of free courses can watch up to 12 minutes of video in each period of your plan, 5% of your plan's video. The rest is for students who paid.");
is("a share too small for a minute, or none: no video, said plainly", [freeVideoWords(paidVideoSeconds("creator"), 0), freeVideoWords(100, 20)], ["Students of free courses see each lesson's text and files, without the video.", "Students of free courses see each lesson's text and files, without the video."]);
is("one hour, singular", freeVideoWords(5 * 3600, 20), "Students of free courses can watch up to 1 hour of video in each period of your plan, 20% of your plan's video. The rest is for students who paid.");
is("no claim here that the rest is held for students who paid against the meter's delay", /always (stays|reserved)/i.test(readFileSync("lib/free-course-video-rules.ts", "utf8")), false);
done();
