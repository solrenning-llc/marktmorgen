/**
 * A study plan for one student, with no AI (259 [KJ4], unit 1: the rules
 * only; nothing keeps, asks or shows a plan yet).
 *
 * The creator sets, for a course, up to MAX_PLAN_GOALS goals in plain words,
 * each with the modules that come first for it, and may mark modules as the
 * basics. The student picks a goal, says whether they are new to the topic or
 * advanced, and how many minutes a week they have. They get a suggested
 * order of the lessons they have, week by week, by each lesson's length:
 *
 *   - the goal's modules first, then the course's own order;
 *   - for an advanced student the basics come last, as a review, never
 *     taken away;
 *   - a week holds at most the student's minutes, except a single lesson
 *     longer than that, which is a week of its own;
 *   - only lessons the student has; a lesson whose length is not known, or
 *     what the student has not known, makes no plan (rule 24), never a guess;
 *   - it is a suggestion, said so, never a promise of a result.
 *
 * Every lesson stays open as the course opens it: a plan changes no access.
 * Pure: no storage, no network, no model.
 */

export const MAX_PLAN_GOALS = 4;
export const MAX_GOAL_LABEL = 80;
export const MIN_WEEK_MINUTES = 30;
export const MAX_WEEK_MINUTES = 1200;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export type PlanCourse = { modules: { id: string; lessons: { id: string; minutes: number | null }[] }[] };
export type PlanGoal = { id: string; label: string; first: string[] };
export type PlanSetup = { goals: PlanGoal[]; basics: string[] };
export type PlanLevel = "new" | "advanced";
export type PlanAnswers = { goal: string; level: PlanLevel; minutes: number };

/** The creator's goals and basics, checked against the course's own modules. */
export function readPlanSetup(raw: unknown, course: PlanCourse): { ok: true; setup: PlanSetup } | { ok: false } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const value = raw as Record<string, unknown>;
  const modules = new Set(course.modules.map((m) => m.id));
  const moduleList = (list: unknown): string[] | null =>
    Array.isArray(list) && list.every((id) => typeof id === "string" && modules.has(id)) && new Set(list).size === list.length ? [...list] as string[] : null;
  if (!Array.isArray(value.goals) || value.goals.length < 1 || value.goals.length > MAX_PLAN_GOALS) return { ok: false };
  const goals: PlanGoal[] = [];
  for (const raw of value.goals) {
    if (!raw || typeof raw !== "object") return { ok: false };
    const goal = raw as Record<string, unknown>;
    const label = typeof goal.label === "string" ? goal.label.replace(/\s+/g, " ").trim() : "";
    const first = moduleList(goal.first);
    if (typeof goal.id !== "string" || !ID.test(goal.id) || goals.some((g) => g.id === goal.id) || !label || label.length > MAX_GOAL_LABEL || !first) return { ok: false };
    goals.push({ id: goal.id, label, first });
  }
  const basics = moduleList(value.basics ?? []);
  if (!basics) return { ok: false };
  return { ok: true, setup: { goals, basics } };
}

/** The student's answers, checked against the creator's goals. */
export function readPlanAnswers(raw: unknown, setup: PlanSetup): { ok: true; answers: PlanAnswers } | { ok: false } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const value = raw as Record<string, unknown>;
  const minutes = typeof value.minutes === "string" && /^\d{1,4}$/.test(value.minutes) ? Number(value.minutes) : value.minutes;
  if (typeof value.goal !== "string" || !setup.goals.some((g) => g.id === value.goal)) return { ok: false };
  if (value.level !== "new" && value.level !== "advanced") return { ok: false };
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < MIN_WEEK_MINUTES || minutes > MAX_WEEK_MINUTES) return { ok: false };
  return { ok: true, answers: { goal: value.goal, level: value.level, minutes } };
}

export type StudyPlan = { known: true; weeks: string[][]; review: string[]; lessons: number } | { known: false };

/** The suggested order, week by week, of the lessons the student has (`has`, null when it could not be read). */
export function studyPlan(course: PlanCourse, setup: PlanSetup, answers: PlanAnswers, has: ReadonlySet<string> | null): StudyPlan {
  if (!has) return { known: false };
  const goal = setup.goals.find((g) => g.id === answers.goal);
  if (!goal) return { known: false };
  const byId = new Map(course.modules.map((m) => [m.id, m]));
  const basics = new Set(answers.level === "advanced" ? setup.basics : []);
  const order: string[] = [];
  for (const id of goal.first) if (!basics.has(id)) order.push(id);
  for (const m of course.modules) if (!order.includes(m.id) && !basics.has(m.id)) order.push(m.id);
  const reviewModules = course.modules.filter((m) => basics.has(m.id)).map((m) => m.id);
  const lessons = [...order, ...reviewModules].flatMap((id) => byId.get(id)?.lessons ?? []).filter((l) => has.has(l.id));
  if (lessons.some((l) => typeof l.minutes !== "number" || !Number.isFinite(l.minutes) || l.minutes <= 0)) return { known: false };
  const weeks: string[][] = [];
  let week: string[] = [];
  let used = 0;
  for (const lesson of lessons) {
    const minutes = lesson.minutes as number;
    if (week.length && used + minutes > answers.minutes) {
      weeks.push(week);
      week = [];
      used = 0;
    }
    week.push(lesson.id);
    used += minutes;
  }
  if (week.length) weeks.push(week);
  const review = reviewModules.flatMap((id) => byId.get(id)?.lessons ?? []).filter((l) => has.has(l.id)).map((l) => l.id);
  return { known: true, weeks, review, lessons: lessons.length };
}

/** The plan in plain words for the student: week by week, and what it is. */
export function planWords(plan: StudyPlan, titles: ReadonlyMap<string, string>): string[] {
  if (!plan.known) return ["A plan could not be made just now: a lesson's length or what you have could not be read. Every lesson is still open to you as usual."];
  const title = (id: string) => titles.get(id) ?? "A lesson";
  const lines = plan.weeks.map((week, i) => `Week ${i + 1}: ${week.map(title).join(", ")}.`);
  if (plan.review.length) lines.push(`At the end, as a review: ${plan.review.map(title).join(", ")}.`);
  lines.push(`A suggested order for about ${plan.weeks.length} ${plan.weeks.length === 1 ? "week" : "weeks"} at your pace. It is not a promise of any result; go at the speed that suits you.`);
  return lines;
}
