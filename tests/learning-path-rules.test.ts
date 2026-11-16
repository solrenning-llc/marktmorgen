/**
 * A learning path: several of a store's courses in order (249 [ST2], unit 1:
 * lib/learning-path-rules.ts).
 *
 * What fails here:
 *   - a path kept that is not 2 to 10 distinct courses of the store, or with
 *     no name;
 *   - in a path in sequence, a course a student has kept waiting on a course
 *     they do not have, a finished course not counted, or anything counted
 *     as finished or complete from what is not known (rule 24) or from a
 *     path that is not one;
 *   - a course shown open to somebody who does not have it;
 *   - words that do not say what to do next.
 */
import { MAX_PATH_COURSES, MIN_PATH_COURSES, pathProgress, pathWords, readPathInput } from "@/lib/learning-path-rules";
import { done, is, part } from "./check";

const store = new Set(["c1", "c2", "c3", "c4"]);
const titles = new Map([["c1", "Clay basics"], ["c2", "Wheel throwing"], ["c3", "Glazing"]]);

part("The path");
is("2 to 10 courses", [MIN_PATH_COURSES, MAX_PATH_COURSES], [2, 10]);
is("a whole path", readPathInput({ name: " Become a potter ", courses: ["c1", "c2", "c3"], order: "sequence" }, store), { ok: true, path: { name: "Become a potter", courses: ["c1", "c2", "c3"], order: "sequence" } });
is("in any order", readPathInput({ name: "Kiln set", courses: ["c3", "c1"], order: "free" }, store), { ok: true, path: { name: "Kiln set", courses: ["c3", "c1"], order: "free" } });
for (const [what, raw, problem] of [
  ["no name", { name: " ", courses: ["c1", "c2"], order: "sequence" }, "name"],
  ["a name too long", { name: "x".repeat(81), courses: ["c1", "c2"], order: "sequence" }, "name"],
  ["one course", { name: "P", courses: ["c1"], order: "sequence" }, "courses"],
  ["eleven courses", { name: "P", courses: Array.from({ length: 11 }, (_, i) => `c${i}`), order: "sequence" }, "courses"],
  ["a course twice", { name: "P", courses: ["c1", "c1"], order: "sequence" }, "courses"],
  ["a course not in the store", { name: "P", courses: ["c1", "c9"], order: "sequence" }, "courses"],
  ["a course id that is not one", { name: "P", courses: ["c1", "c 2"], order: "sequence" }, "courses"],
  ["no order", { name: "P", courses: ["c1", "c2"] }, "order"],
  ["another order", { name: "P", courses: ["c1", "c2"], order: "random" }, "order"],
  ["nothing", null, "name"],
] as [string, unknown, string][]) is(`refused: ${what}`, readPathInput(raw, store), { ok: false, problem });

part("In sequence");
const seq = { name: "Become a potter", courses: ["c1", "c2", "c3"], order: "sequence" as const };
const all = new Set(["c1", "c2", "c3"]);
is("nothing finished: the first open, the rest wait their turn", pathProgress(seq, { has: all, finished: new Set() }), {
  courses: [{ id: "c1", state: "open" }, { id: "c2", state: "waiting", after: "c1" }, { id: "c3", state: "waiting", after: "c1" }],
  finished: 0, total: 3, complete: false,
});
is("the first finished: the second is next", pathProgress(seq, { has: all, finished: new Set(["c1"]) }).courses.map((c) => c.state), ["done", "open", "waiting"]);
is("finished out of order: what is finished stays finished and counts (review #3674)", pathProgress(seq, { has: all, finished: new Set(["c2"]) }), {
  courses: [{ id: "c1", state: "open" }, { id: "c2", state: "done" }, { id: "c3", state: "waiting", after: "c1" }],
  finished: 1, total: 3, complete: false,
});
is("the last two finished before the path existed: both done, the first is next", pathProgress(seq, { has: all, finished: new Set(["c2", "c3"]) }).courses.map((c) => c.state), ["open", "done", "done"]);
is("all finished: complete", pathProgress(seq, { has: all, finished: all }), {
  courses: [{ id: "c1", state: "done" }, { id: "c2", state: "done" }, { id: "c3", state: "done" }],
  finished: 3, total: 3, complete: true,
});
is("what is finished is not known: nothing opens, nothing is done", pathProgress(seq, { has: all, finished: null }), {
  courses: [{ id: "c1", state: "unknown" }, { id: "c2", state: "unknown" }, { id: "c3", state: "unknown" }],
  finished: null, total: 3, complete: false,
});
is("what they have is not known: nothing opens", pathProgress(seq, { has: null, finished: new Set(["c1"]) }).courses.map((c) => c.state), ["unknown", "unknown", "unknown"]);
is("a course they do not have: never open or finished, finished or not", pathProgress(seq, { has: new Set(["c1", "c3"]), finished: new Set(["c1", "c2"]) }).courses.map((c) => c.state), ["done", "not_owned", "open"]);
is("a course they do not have is never complete", pathProgress(seq, { has: new Set(["c1", "c3"]), finished: new Set(["c1", "c2", "c3"]) }).complete, false);

part("No dead end for what a student paid for (review #3674, MEDIUM)");
is("only the last course bought: it is open, never waiting on courses they do not have", pathProgress(seq, { has: new Set(["c3"]), finished: new Set() }).courses.map((c) => c.state), ["not_owned", "not_owned", "open"]);
is("the middle course gone from what they have: the next one waits only on courses they have", pathProgress(seq, { has: new Set(["c1", "c3"]), finished: new Set(["c1"]) }).courses, [{ id: "c1", state: "done" }, { id: "c2", state: "not_owned" }, { id: "c3", state: "open" }]);
is("a course waits on the nearest course before it that they have and have not finished", pathProgress({ ...seq, courses: ["c1", "c2", "c3", "c4"] }, { has: new Set(["c1", "c3", "c4"]), finished: new Set(["c1"]) }).courses.at(-1), { id: "c4", state: "waiting", after: "c3" });

part("A path that is not one, or progress that is not a set (review #3674, LEVE)");
const odd = (path: { name: string; courses: string[]; order: "sequence" | "free" }, has: unknown, finished: unknown) => pathProgress(path, { has: has as ReadonlySet<string>, finished: finished as ReadonlySet<string> });
is("no course: unknown, never complete", odd({ ...seq, courses: [] }, all, all), { courses: [], finished: null, total: 0, complete: false });
is("one course twice: unknown, never complete", odd({ ...seq, courses: ["c1", "c1"] }, all, all).complete, false);
is("and never counted twice", odd({ ...seq, courses: ["c1", "c1"] }, all, all).finished, null);
is("one course alone: never complete", odd({ ...seq, courses: ["c1"] }, all, all).complete, false);
is("progress that is a list, not a set: unknown, never a throw", odd(seq, ["c1", "c2", "c3"], ["c1"]).courses.map((c) => c.state), ["unknown", "unknown", "unknown"]);

part("Names");
is("control and invisible characters are taken out of a name", readPathInput({ name: "Pot\u0000ter\u200b path\u0007", courses: ["c1", "c2"], order: "free" }, store), { ok: true, path: { name: "Potter path", courses: ["c1", "c2"], order: "free" } });
is("a name of only invisible characters is no name", readPathInput({ name: "\u200b\u200b", courses: ["c1", "c2"], order: "free" }, store), { ok: false, problem: "name" });
const throwing = Object.defineProperty({ courses: ["c1", "c2"], order: "free" }, "name", { get() { throw new Error("boom"); }, enumerable: true });
is("a value that throws when read is refused, never thrown", readPathInput(throwing, store), { ok: false, problem: "name" });

part("In any order");
const free = { ...seq, order: "free" as const };
is("every course they have is open", pathProgress(free, { has: all, finished: new Set(["c2"]) }).courses.map((c) => c.state), ["open", "done", "open"]);
is("complete when all are finished", pathProgress(free, { has: all, finished: all }).complete, true);

part("Words for the student");
is("a course that waits names the one to finish first, and says it can be opened now", pathWords(seq, pathProgress(seq, { has: all, finished: new Set() }), titles), [
  "Clay basics: start here.",
  "Wheel throwing: next after Clay basics. You can open it any time.",
  "Glazing: next after Clay basics. You can open it any time.",
  "0 of 3 courses finished.",
]);
is("complete: says the courses are finished, and promises no certificate (VR)", pathWords(seq, pathProgress(seq, { has: all, finished: all }), titles).at(-1), "All 3 courses finished.");
is("not known: says so, never a guess", pathWords(seq, pathProgress(seq, { has: all, finished: null }), titles), ["Your progress could not be read just now. Nothing here is marked finished because of it; try again in a moment."]);
is("not owned: says it is not included, and nothing after it waits on it", pathWords(seq, pathProgress(seq, { has: new Set(["c1", "c3"]), finished: new Set(["c1"]) }), titles), [
  "Clay basics: finished.",
  "Wheel throwing: not included in what you have.",
  "Glazing: open now.",
  "1 of 3 courses finished.",
]);

done();
