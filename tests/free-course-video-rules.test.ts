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
import { PLAYER_SECONDS } from "@/lib/stream";
import { FREE_PLAYER_ROOM_SECONDS, FREE_PLAYER_UNKNOWN_SECONDS, FREE_PLAYER_MAX_SECONDS, FREE_VIDEO_MAX_PERCENT, freePlayerGrant, freeVideoAdmission, freeVideoSeconds, freeVideoWords, readFreeVideoPercent } from "@/lib/free-course-video-rules";
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

part("How long one free player may run (unit 2a)");
const H = 3600;
const g = (o: Partial<Parameters<typeof freePlayerGrant>[0]>) => freePlayerGrant({ limitSeconds: 4 * H, percent: 20, watchedAll: 0, reservedFree: 0, periodLeft: 20 * 24 * H, videoSeconds: 10 * 60, ...o });
is("the video's length and room to pause, from an untouched share", g({}), { kind: "play", seconds: 10 * 60 + FREE_PLAYER_ROOM_SECONDS, short: false });
is("no length known: a set time", g({ videoSeconds: null }), { kind: "play", seconds: FREE_PLAYER_UNKNOWN_SECONDS, short: false });
is("never more than a paid player's time, and said short when the video is longer", g({ limitSeconds: 1000 * H, videoSeconds: 10 * H }), { kind: "play", seconds: FREE_PLAYER_MAX_SECONDS, short: true });
is("the same time a paid player is signed for", FREE_PLAYER_MAX_SECONDS, PLAYER_SECONDS);
is("a length with a part of a second is rounded up, not taken for unknown", g({ videoSeconds: 600.5 }), { kind: "play", seconds: 601 + FREE_PLAYER_ROOM_SECONDS, short: false });
is("never past the end of the period, so the next period's share starts whole", [g({ periodLeft: 5 * 60 }), g({ periodLeft: 60 })], [{ kind: "play", seconds: 5 * 60, short: true }, { kind: "paused" }]);
// Store's 4 hours at 20%: 48 minutes for free students.
is("never more than what is left of the free share, and said short", g({ reservedFree: 40 * 60 }), { kind: "play", seconds: 8 * 60, short: true });
is("never more than what is left of the whole limit after what was measured and what free players hold", g({ watchedAll: 4 * H - 20 * 60, reservedFree: 10 * 60 }), { kind: "play", seconds: 10 * 60, short: true });
is("too little left: paused, as the share used up", [g({ reservedFree: 48 * 60 - 60 }), g({ watchedAll: 4 * H })], [{ kind: "paused" }, { kind: "paused" }]);
is("the creator gave free students none: off", g({ percent: 0 }), { kind: "off" });
is("any figure that cannot be read: unknown, no player", [g({ limitSeconds: null }), g({ watchedAll: null }), g({ reservedFree: -1 }), g({ reservedFree: 1.5 }), g({ periodLeft: null })], [{ kind: "unknown" }, { kind: "unknown" }, { kind: "unknown" }, { kind: "unknown" }, { kind: "unknown" }]);
// The guarantee the reservation gives: grants taken one after another never add up past the free share.
let held = 0;
let grants = 0;
for (let i = 0; i < 100; i += 1) {
  const r = g({ reservedFree: held, videoSeconds: 7 * 60 });
  if (r.kind !== "play") break;
  held += r.seconds;
  grants += 1;
}
is("grants made one after another never add up past the free share (what is granted, not what is watched)", [held <= 48 * 60, grants > 1], [true, true]);
const source = readFileSync("lib/free-course-video-rules.ts", "utf8");
is("the rule for a video also in a paid lesson is written down", source.includes("counted, all\n * of it, as watched by free students"), true);
is("no claim that playing cannot outlast a grant, nor that any number of players is bounded", /cannot outlast|however many players/i.test(source), false);
is("what a grant does not bound is said", ["several tabs or devices", "playing faster than real time", "each reload taking a new grant", "free preview lesson"].every((w) => source.includes(w)), true);

done();
