/**
 * The weekly progress summary a student may choose to get from a store
 * (289 [H4-3]; unit 1 of 7 November 2026): the rule only, pure. What goes in
 * one week's email, and whether anything goes out at all.
 *
 * Off unless both said yes: the store allows it, and the student chose it
 * (off by default). Then, once a week, one email per person per store, with
 * every course of that store that has news:
 *
 *   - the lessons they marked done since the last summary, in course order,
 *     only when that summary is recent enough (BASELINE_FRESH_SECONDS) for
 *     "this week" to be true; otherwise the email says nothing about them;
 *   - how many lessons of the course they have done, of how many;
 *   - the next lesson they can open now, as the course page picks it (the
 *     first not done that is open and not held behind a quiz still to pass);
 *     when none is open yet, when the next one opens, or which quiz holds
 *     the rest; when they finished, that;
 *   - lessons that opened for them this week (a module's drip day, or a
 *     cohort's start), never a module already open when they joined;
 *   - and, once for the email, the community events of the store starting in
 *     the next seven days, soonest first, canceled ones left out.
 *
 * News is a lesson done this week, a lesson opened this week or an event
 * coming. The next lesson alone is not news: a week with nothing new sends
 * nothing, so a student who stopped is not written to every week (the
 * come-back email, lib/member-nudge.ts, is the one for them). A store that
 * already wrote to the person this week (that come-back email, or a summary)
 * sends nothing more that week. Unknown is never taken for "no": events that
 * could not be read are left out and never said to be none, and a week whose
 * only possible news is unknown sends nothing.
 *
 * `baseline` is what the next week's "done this week" is counted from: every
 * course read, with its lessons done now, in course order. It moves every
 * week the rule runs for a student who chose the summary, sent or not, so a
 * lesson done in a quiet week is never called this week's later.
 *
 * Honest by shape: no streak, rank, score, praise, urgency or comparison with
 * other students is a field here (tests/h4-3-weekly-progress.test.ts).
 *
 * Not built yet: the student's choice and the store's switch (unit 2), and
 * the email itself, in the store's buyer languages, inside the plan's email
 * allowance checked before sending, with the one-click unsubscribe (unit 3).
 */
import { type Course, type CourseModule, isOpen, lessonsInOrder, opensAt } from "@/lib/course";
import { heldBack } from "@/lib/quiz";
import { hasFinished } from "@/lib/certificate";

/** A week, in seconds: the summary's period and the events' window. */
export const WEEK_SECONDS = 7 * 86_400;
/** How old the last summary may be for the lessons done since to be called this week's: a week and a day of slack for a late run. */
export const BASELINE_FRESH_SECONDS = WEEK_SECONDS + 86_400;
/** Courses in one email; past it, a count. */
export const MAX_COURSES = 5;
/** Lessons done this week named per course; past it, a count. */
export const MAX_DONE_LISTED = 10;
/** Events in one email; past it, a count. */
export const MAX_EVENTS = 3;

export type CourseWeek = {
  courseId: string;
  /** The course's name, as the store shows it. */
  title: string;
  course: Course;
  /** When the student's clock in this course started, in seconds. */
  joinedSeconds: number;
  /** Lessons marked done now. */
  done: ReadonlySet<string>;
  /** Required quizzes passed and assignments done (lib/quiz.ts). */
  passed: ReadonlySet<string>;
  /** Lessons marked done when the last summary was made for this course; null when none was. */
  doneBefore: ReadonlySet<string> | null;
  /** When that was, in seconds; null when never. */
  lastSummarySeconds: number | null;
};

/** A community event as lib/community-events.ts keeps it: `start` in milliseconds. */
export type WeekEvent = { id: string; title: string; start: number; minutes: number; cancelled?: boolean };

export type WeeklyInput = {
  /** The store allows the summary. */
  storeOn: boolean;
  /** The student chose to get it. */
  studentChose: boolean;
  /** Whether the store already wrote to this person this week (come-back email or summary); null when that could not be read. */
  wroteThisWeek: boolean | null;
  courses: CourseWeek[];
  /** The store's community events; null when they could not be read. */
  events: WeekEvent[] | null;
  nowSeconds: number;
};

export type LessonRef = { id: string; title: string };

export type CourseSummary = {
  courseId: string;
  title: string;
  /** Lessons done this week, at most MAX_DONE_LISTED; null when "this week" is not known. */
  doneThisWeek: LessonRef[] | null;
  /** Lessons done this week past the ones named. */
  moreDone: number;
  doneCount: number;
  total: number;
  finished: boolean;
  next: LessonRef | null;
  /** Lessons that opened for the student this week. */
  opened: number;
  /** The lesson whose quiz must be passed first, when that is what holds the rest. */
  heldBy: LessonRef | null;
  /** When the next lesson opens, in seconds, when none is open yet. */
  nextOpensAt: number | null;
};

export type Baseline = { courseId: string; done: string[] };

export type WeeklyDecision =
  | { send: false; why: "off" | "not chosen" | "already written" | "no news" | "unknown"; baseline: Baseline[] }
  | {
      send: true;
      /** The week, named by its Monday (UTC): one summary per person per store per week. */
      week: string;
      courses: CourseSummary[];
      moreCourses: number;
      /** null: not read, so not mentioned. */
      events: { id: string; title: string; start: number }[] | null;
      moreEvents: number;
      baseline: Baseline[];
    };

/** The week a moment is in, named by its Monday, in UTC. */
export function weekOf(nowSeconds: number): string {
  const day = new Date(Math.floor(nowSeconds) * 1000);
  const back = (day.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - back)).toISOString().slice(0, 10);
}

const ref = (lesson: { id: string; title: string }): LessonRef => ({ id: lesson.id, title: lesson.title });

function freshBaseline(week: CourseWeek, now: number): ReadonlySet<string> | null {
  const at = week.lastSummarySeconds;
  if (!week.doneBefore || at === null || !Number.isFinite(at) || at > now || now - at > BASELINE_FRESH_SECONDS) return null;
  return week.doneBefore;
}

function summarize(week: CourseWeek, now: number): { summary: CourseSummary; news: boolean; baseline: Baseline } {
  const { course } = week;
  const all = lessonsInOrder(course);
  const doneNow = all.filter(({ lesson }) => week.done.has(lesson.id));
  const before = freshBaseline(week, now);
  const doneThisWeek = before ? doneNow.filter(({ lesson }) => !before.has(lesson.id)).map(({ lesson }) => ref(lesson)) : null;

  const held = heldBack(course, new Set(week.passed));
  const reachable = (unit: CourseModule, id: string) => isOpen(course, unit, week.joinedSeconds, now) && !held.has(id);
  const finished = hasFinished(course, new Set(week.done), new Set(week.passed));
  const undone = all.filter(({ lesson }) => !week.done.has(lesson.id));
  const nextEntry = finished ? undefined : undone.find(({ lesson, unit }) => reachable(unit, lesson.id));
  let heldBy: LessonRef | null = null;
  let nextOpensAt: number | null = null;
  if (!finished && !nextEntry) {
    const blocked = undone.find(({ lesson }) => held.has(lesson.id));
    const blocker = blocked ? all.find(({ lesson }) => lesson.id === held.get(blocked.lesson.id)) : undefined;
    if (blocker) heldBy = ref(blocker.lesson);
    const later = undone.map(({ unit }) => opensAt(course, unit, week.joinedSeconds)).filter((at) => at > now);
    if (!heldBy && later.length) nextOpensAt = Math.min(...later);
  }

  // Opened this week: its opening fell in the last week and came after the student joined.
  const opened = all.filter(({ unit }) => {
    const at = opensAt(course, unit, week.joinedSeconds);
    return at > now - WEEK_SECONDS && at <= now && at > week.joinedSeconds;
  }).length;

  const summary: CourseSummary = {
    courseId: week.courseId,
    title: week.title,
    doneThisWeek: doneThisWeek ? doneThisWeek.slice(0, MAX_DONE_LISTED) : null,
    moreDone: doneThisWeek ? Math.max(0, doneThisWeek.length - MAX_DONE_LISTED) : 0,
    doneCount: doneNow.length,
    total: all.length,
    finished,
    next: nextEntry ? ref(nextEntry.lesson) : null,
    opened,
    heldBy,
    nextOpensAt,
  };
  return {
    summary,
    news: (doneThisWeek?.length ?? 0) > 0 || opened > 0,
    baseline: { courseId: week.courseId, done: doneNow.map(({ lesson }) => lesson.id) },
  };
}

/** Whether this week's summary goes out to one student of one store, and what it says. */
export function weeklyProgress(input: WeeklyInput): WeeklyDecision {
  if (!input.storeOn) return { send: false, why: "off", baseline: [] };
  if (!input.studentChose) return { send: false, why: "not chosen", baseline: [] };
  const now = input.nowSeconds;
  if (!Number.isFinite(now)) return { send: false, why: "unknown", baseline: [] };

  const read = input.courses.map((week) => summarize(week, now));
  const baseline = read.map((r) => r.baseline);
  const newsCourses = read.filter((r) => r.news).map((r) => r.summary);

  const end = (now + WEEK_SECONDS) * 1000;
  const coming = input.events
    ? input.events
        .filter((e) => !e.cancelled && e.start >= now * 1000 && e.start < end)
        .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
    : null;

  if (input.wroteThisWeek === null) return { send: false, why: "unknown", baseline };
  if (input.wroteThisWeek) return { send: false, why: "already written", baseline };
  if (!newsCourses.length && !coming?.length) return { send: false, why: coming === null ? "unknown" : "no news", baseline };

  return {
    send: true,
    week: weekOf(now),
    courses: newsCourses.slice(0, MAX_COURSES),
    moreCourses: Math.max(0, newsCourses.length - MAX_COURSES),
    events: coming ? coming.slice(0, MAX_EVENTS).map((e) => ({ id: e.id, title: e.title, start: e.start })) : null,
    moreEvents: coming ? Math.max(0, coming.length - MAX_EVENTS) : 0,
    baseline,
  };
}
