/**
 * A study plan for one student, with no AI (259 [KJ4], unit 1:
 * lib/study-plan-rules.ts).
 *
 * What fails here:
 *   - a plan with a lesson the student does not have;
 *   - a lesson left out, or the basics taken away from an advanced student
 *     (they come last, as a review, never dropped);
 *   - a week over the student's minutes, unless one lesson alone is longer;
 *   - a lesson whose length is not known placed as if it were (the plan is
 *     unknown instead), or a plan made from answers that do not read;
 *   - words that promise a result.
 */
import { MAX_PLAN_GOALS, MAX_WEEK_MINUTES, MIN_WEEK_MINUTES, planWords, readPlanAnswers, readPlanSetup, studyPlan } from "@/lib/study-plan-rules";
import { done, is, part } from "./check";

const course = {
  modules: [
    { id: "m1", lessons: [{ id: "l1", minutes: 20 }, { id: "l2", minutes: 30 }] },
    { id: "m2", lessons: [{ id: "l3", minutes: 40 }] },
    { id: "m3", lessons: [{ id: "l4", minutes: 25 }, { id: "l5", minutes: 15 }] },
  ],
};
const setup = { goals: [{ id: "g1", label: "Sell my first piece", first: ["m3"] }, { id: "g2", label: "Learn the basics", first: [] }], basics: ["m1"] };
const all = new Set(["l1", "l2", "l3", "l4", "l5"]);

part("The creator's setup");
is("up to 4 goals", MAX_PLAN_GOALS, 4);
is("a whole setup", readPlanSetup(setup, course), { ok: true, setup });
for (const [what, raw] of [
  ["no goal", { goals: [], basics: [] }],
  ["five goals", { goals: Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, label: "x", first: [] })), basics: [] }],
  ["a goal with no words", { goals: [{ id: "g1", label: " ", first: [] }], basics: [] }],
  ["a goal naming a module the course does not have", { goals: [{ id: "g1", label: "x", first: ["m9"] }], basics: [] }],
  ["basics naming a module the course does not have", { goals: [{ id: "g1", label: "x", first: [] }], basics: ["m9"] }],
  ["two goals with one id", { goals: [{ id: "g1", label: "a", first: [] }, { id: "g1", label: "b", first: [] }], basics: [] }],
] as [string, unknown][]) is(`refused: ${what}`, readPlanSetup(raw, course).ok, false);

part("The student's answers");
is("minutes from 30 to 1200 a week", [MIN_WEEK_MINUTES, MAX_WEEK_MINUTES], [30, 1200]);
is("whole answers", readPlanAnswers({ goal: "g1", level: "new", minutes: "60" }, setup), { ok: true, answers: { goal: "g1", level: "new", minutes: 60 } });
for (const [what, raw] of [
  ["a goal the creator did not set", { goal: "g9", level: "new", minutes: 60 }],
  ["another level", { goal: "g1", level: "expert", minutes: 60 }],
  ["too few minutes", { goal: "g1", level: "new", minutes: 10 }],
  ["too many minutes", { goal: "g1", level: "new", minutes: 5000 }],
  ["minutes that are not a number", { goal: "g1", level: "new", minutes: "lots" }],
] as [string, unknown][]) is(`refused: ${what}`, readPlanAnswers(raw, setup).ok, false);

part("The plan");
const plan = studyPlan(course, setup, { goal: "g1", level: "new", minutes: 60 }, all);
is("the goal's modules first, then the course's order", plan.known && plan.weeks.flat(), ["l4", "l5", "l1", "l2", "l3"]);
is("weeks of at most the student's minutes", plan.known && plan.weeks, [["l4", "l5", "l1"], ["l2"], ["l3"]]);
is("an advanced student: basics last, as a review, never dropped", studyPlan(course, setup, { goal: "g2", level: "advanced", minutes: 1200 }, all), { known: true, weeks: [["l3", "l4", "l5", "l1", "l2"]], review: ["l1", "l2"], lessons: 5 });
is("only what the student has", studyPlan(course, setup, { goal: "g2", level: "new", minutes: 60 }, new Set(["l1", "l3"])), { known: true, weeks: [["l1", "l3"]], review: [], lessons: 2 });
is("a lesson longer than a week: a week of its own", studyPlan({ modules: [{ id: "m1", lessons: [{ id: "a", minutes: 90 }, { id: "b", minutes: 10 }] }] }, { goals: [{ id: "g", label: "x", first: [] }], basics: [] }, { goal: "g", level: "new", minutes: 30 }, new Set(["a", "b"])), { known: true, weeks: [["a"], ["b"]], review: [], lessons: 2 });
is("a lesson whose length is not known: no plan, never a guess", studyPlan({ modules: [{ id: "m1", lessons: [{ id: "a", minutes: null }] }] }, { goals: [{ id: "g", label: "x", first: [] }], basics: [] }, { goal: "g", level: "new", minutes: 60 }, new Set(["a"])), { known: false });
is("what the student has is not known: no plan", studyPlan(course, setup, { goal: "g1", level: "new", minutes: 60 }, null), { known: false });
is("nothing they have: an empty plan", studyPlan(course, setup, { goal: "g1", level: "new", minutes: 60 }, new Set()), { known: true, weeks: [], review: [], lessons: 0 });

part("Words");
const titles = new Map([["l1", "Wedging clay"], ["l2", "Centering"], ["l3", "Trimming"], ["l4", "Pricing"], ["l5", "Your first sale"]]);
const words = planWords(plan, titles);
is("week by week", words.slice(0, 3), ["Week 1: Pricing, Your first sale, Wedging clay.", "Week 2: Centering.", "Week 3: Trimming."]);
is("a suggestion, never a promise", words.at(-1), "A suggested order for about 3 weeks at your pace. It is not a promise of any result; go at the speed that suits you.");
is("unknown says so", planWords({ known: false }, titles), ["A plan could not be made just now: a lesson's length or what you have could not be read. Every lesson is still open to you as usual."]);
is("no words promise a result", words.join(" ").match(/guarantee|will (?:sell|earn|master)|results? in/i), null);

done();
