/**
 * Points for posts, comments and finished lessons (112 [E2-POINTS], unit 1;
 * added 10 November 2026): the rules, on synthetic values only. Nothing here
 * reads or writes.
 */
import {
  DEFAULT_DAILY_CAP,
  MAX_ACTION_POINTS,
  MAX_DAILY_POINTS,
  NO_ACTION_POINTS,
  POINT_ACTIONS,
  factKey,
  parsePointRules,
  pointRulesWords,
  pointsToAward,
  readPointRulesInput,
  shouldTakeBack,
  takeBack,
  type PointAction,
} from "@/lib/community-point-rules";
import { done, is, part } from "./check";

const ON = { post: 2, comment: 1, lesson: 3, dailyCap: 10 };

part("Off until the creator turns it on");
is("by default only likes make points, as today", NO_ACTION_POINTS, { post: 0, comment: 0, lesson: 0, dailyCap: DEFAULT_DAILY_CAP });
is("nothing stored, or nothing readable, is the default", [parsePointRules(undefined), parsePointRules(null), parsePointRules("{"), parsePointRules([1, 2])], Array(4).fill(NO_ACTION_POINTS));
is("the three actions", POINT_ACTIONS, ["post", "comment", "lesson"]);
is("the bounds", [MAX_ACTION_POINTS, MAX_DAILY_POINTS, DEFAULT_DAILY_CAP], [5, 50, 10]);

part("What the creator chose, read back");
is("kept as saved, from an object or from its JSON", [parsePointRules(ON), parsePointRules(JSON.stringify(ON))], [ON, ON]);
is(
  "a field out of bounds goes back to its own default, never to more",
  parsePointRules({ post: 9, comment: -1, lesson: 2.5, dailyCap: 500 }),
  { post: 0, comment: 0, lesson: 0, dailyCap: DEFAULT_DAILY_CAP },
);
is(
  "the studio's form: whole numbers in bounds, from numbers or digits",
  readPointRulesInput({ post: "2", comment: 1, lesson: "3", dailyCap: "10" }),
  { ok: true, rules: ON },
);
is(
  "the form is refused, never quietly changed",
  [
    readPointRulesInput({ post: 6, comment: 1, lesson: 1, dailyCap: 10 }),
    readPointRulesInput({ post: 1, comment: "a", lesson: 1, dailyCap: 10 }),
    readPointRulesInput({ post: 1, comment: 1, lesson: -1, dailyCap: 10 }),
    readPointRulesInput({ post: 1, comment: 1, lesson: 1, dailyCap: 0 }),
    readPointRulesInput({ post: 1, comment: 1, lesson: 1, dailyCap: MAX_DAILY_POINTS + 1 }),
    readPointRulesInput({ post: 1, comment: 1, lesson: 1 }),
    readPointRulesInput(null),
  ].map((r) => (r.ok ? "ok" : r.why)),
  ["points", "points", "points", "cap", "cap", "cap", "points"],
);
is("all three off is a valid choice", readPointRulesInput({ post: 0, comment: 0, lesson: 0, dailyCap: 1 }), { ok: true, rules: { post: 0, comment: 0, lesson: 0, dailyCap: 1 } });

part("One award per fact, never per click");
is(
  "a post, a comment, a lesson of a product",
  [factKey("post", { id: "a1b2c3d4e5f6" }), factKey("comment", { id: "c0ffee12" }), factKey("lesson", { id: "intro-1", product: "prod01" })],
  ["p:a1b2c3d4e5f6", "c:c0ffee12", "l:prod01:intro-1"],
);
is(
  "no key, so no award, for an id that is not one",
  [factKey("post", { id: "" }), factKey("comment", { id: "a:b" }), factKey("lesson", { id: "intro" }), factKey("lesson", { id: "intro", product: "NOPE" }), factKey("post", { id: "x".repeat(65) })],
  [null, null, null, null, null],
);

part("How many points a fact makes");
const fresh = { earnedToday: 0, alreadyAwarded: false, byCreator: false };
is("a post, a comment, a lesson", POINT_ACTIONS.map((action) => pointsToAward(ON, { ...fresh, action })), [{ give: 2, why: "ok" }, { give: 1, why: "ok" }, { give: 3, why: "ok" }]);
is("an action the creator left at 0 makes none", pointsToAward({ ...ON, comment: 0 }, { ...fresh, action: "comment" }), { give: 0, why: "off" });
is("the creator collects no points: the board is for members", pointsToAward(ON, { ...fresh, action: "post", byCreator: true }), { give: 0, why: "creator" });
is("the same fact twice makes points once", pointsToAward(ON, { ...fresh, action: "lesson", alreadyAwarded: true }), { give: 0, why: "repeat" });
is("the day's cap: what is left of it, then nothing", [pointsToAward(ON, { ...fresh, action: "lesson", earnedToday: 8 }), pointsToAward(ON, { ...fresh, action: "post", earnedToday: 10 }), pointsToAward(ON, { ...fresh, action: "post", earnedToday: 12 })], [{ give: 2, why: "partial" }, { give: 0, why: "cap" }, { give: 0, why: "cap" }]);
is(
  "today's count or the fact's record could not be read: unknown, never points",
  [
    pointsToAward(ON, { ...fresh, action: "post", earnedToday: Number.NaN }),
    pointsToAward(ON, { ...fresh, action: "post", earnedToday: -1 }),
    pointsToAward(ON, { ...fresh, action: "post", earnedToday: 1.5 }),
    pointsToAward(ON, { ...fresh, action: "post", earnedToday: null as unknown as number }),
    pointsToAward(ON, { ...fresh, action: "post", alreadyAwarded: null }),
  ],
  Array(5).fill({ give: 0, why: "unknown" }),
);
is("rules out of bounds are never trusted as they are", pointsToAward({ post: 99, comment: 1, lesson: 1, dailyCap: 999 }, { ...fresh, action: "post" }), { give: 0, why: "off" });

part("Taking back exactly what was given");
is("removed posts and comments, refunded lessons", [shouldTakeBack("post", "deleted"), shouldTakeBack("comment", "removed"), shouldTakeBack("lesson", "refunded")], [true, true, true]);
is("a lesson marked unfinished keeps its points: marking again gives nothing (one award per fact)", shouldTakeBack("lesson", "unmarked"), false);
is("a post edited keeps its points", shouldTakeBack("post", "edited"), false);
is("what was recorded with the fact, not today's rule", [takeBack({ found: true, amount: 3 }), takeBack({ found: true, amount: 0 })], [{ take: 3 }, { take: 0 }]);
is("nothing recorded, read exactly: nothing to take back", takeBack({ found: false }), { take: 0 });
is(
  "the record could not be read, or is not a number in bounds: unknown, never zero",
  [takeBack(null), takeBack({ found: true, amount: "3" }), takeBack({ found: true, amount: MAX_ACTION_POINTS + 1 }), takeBack({ found: true, amount: -2 })],
  Array(4).fill({ take: null, why: "unknown" }),
);

part("Said on the leaderboard, with nothing hidden");
is("only likes, by default", pointRulesWords(NO_ACTION_POINTS), ["A like on your post or comment from someone else: 1 point."]);
is(
  "every action the creator turned on, and the day's cap",
  pointRulesWords(ON),
  [
    "A like on your post or comment from someone else: 1 point.",
    "A new post: 2 points.",
    "A comment: 1 point.",
    "A lesson you finish: 3 points.",
    "Posts, comments and lessons give at most 10 points a day.",
  ],
);

part("A stored cap that does not read never raises the cap (Codex G on #3656, LEVE)");
is("a cap of 2 damaged into text gives nothing more, never the default 10", [parsePointRules({ ...ON, dailyCap: "2" }).dailyCap, pointsToAward({ ...ON, dailyCap: "2" }, { action: "post", byCreator: false, earnedToday: 0, alreadyAwarded: false }).give], [0, 0]);
is("a fractional cap too", parsePointRules({ ...ON, dailyCap: 2.5 }).dailyCap, 0);
is("control: no cap stored yet is the default", parsePointRules({ post: 2, comment: 1, lesson: 3 }).dailyCap, DEFAULT_DAILY_CAP);

part("An action that is not one is refused, never read off another field (Codex G on #3656, LEVE)");
for (const action of ["__proto__", "constructor", "dailyCap", "toString"]) {
  const odd = action as unknown as PointAction;
  is(`${action}: no points`, pointsToAward(ON, { action: odd, byCreator: false, earnedToday: 0, alreadyAwarded: false }), { give: 0, why: "unknown" });
  is(`${action}: never taken back, never a throw`, shouldTakeBack(odd, "deleted"), false);
  is(`${action}: no key`, factKey(odd, { id: "abc", product: "abcdef" }), null);
}

done();
