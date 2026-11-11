/**
 * A learning path: several of a store's courses in order (249 [ST2], unit 1:
 * lib/learning-path-rules.ts).
 *
 * What fails here:
 *   - a path kept that is not 2 to 10 distinct courses of the store, or with
 *     no name;
 *   - in a path in sequence, a course open before the one before it is
 *     finished, or one counted as finished, or the path's certificate given,
 *     from anything not known (rule 24);
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
is("nothing finished: the first open, the rest wait", pathProgress(seq, { has: all, finished: new Set() }), {
  courses: [{ id: "c1", state: "open" }, { id: "c2", state: "locked", after: "c1" }, { id: "c3", state: "locked", after: "c2" }],
  finished: 0, total: 3, complete: false,
});
is("the first finished: the second opens", pathProgress(seq, { has: all, finished: new Set(["c1"]) }).courses.map((c) => c.state), ["done", "open", "locked"]);
is("finished out of order: still waits for the one before", pathProgress(seq, { has: all, finished: new Set(["c2"]) }).courses.map((c) => c.state), ["open", "locked", "locked"]);
is("all finished: complete, so the certificate is due", pathProgress(seq, { has: all, finished: all }), {
  courses: [{ id: "c1", state: "done" }, { id: "c2", state: "done" }, { id: "c3", state: "done" }],
  finished: 3, total: 3, complete: true,
});
is("what is finished is not known: nothing opens, nothing is done", pathProgress(seq, { has: all, finished: null }), {
  courses: [{ id: "c1", state: "unknown" }, { id: "c2", state: "unknown" }, { id: "c3", state: "unknown" }],
  finished: null, total: 3, complete: false,
});
is("what they have is not known: nothing opens", pathProgress(seq, { has: null, finished: new Set(["c1"]) }).courses.map((c) => c.state), ["unknown", "unknown", "unknown"]);
is("a course they do not have: never open, finished or not", pathProgress(seq, { has: new Set(["c1", "c3"]), finished: new Set(["c1"]) }).courses.map((c) => c.state), ["done", "not_owned", "locked"]);
is("a course they do not have is never complete", pathProgress(seq, { has: new Set(["c1", "c3"]), finished: new Set(["c1", "c2", "c3"]) }).complete, false);

part("In any order");
const free = { ...seq, order: "free" as const };
is("every course they have is open", pathProgress(free, { has: all, finished: new Set(["c2"]) }).courses.map((c) => c.state), ["open", "done", "open"]);
is("complete when all are finished", pathProgress(free, { has: all, finished: all }).complete, true);

part("Words for the student");
is("a course that waits names the one before", pathWords(seq, pathProgress(seq, { has: all, finished: new Set() }), titles), [
  "Clay basics: start here.",
  "Wheel throwing: opens when you finish Clay basics.",
  "Glazing: opens when you finish Wheel throwing.",
  "0 of 3 courses finished.",
]);
is("complete", pathWords(seq, pathProgress(seq, { has: all, finished: all }), titles).at(-1), "All 3 courses finished. Your certificate for the path is ready.");
is("not known: says so, never a guess", pathWords(seq, pathProgress(seq, { has: all, finished: null }), titles), ["Your progress could not be read just now. Nothing here is locked or finished because of it; try again in a moment."]);
is("not owned: says it is not included", pathWords(seq, pathProgress(seq, { has: new Set(["c1", "c3"]), finished: new Set() }), titles)[1], "Wheel throwing: not included in what you have.");

done();
