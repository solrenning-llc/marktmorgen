// 289 [H4-3], unit 1: the rule of the weekly progress summary a student may
// choose to get. Pure: what goes in, and whether anything goes out at all.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Course, Lesson } from "../lib/course";
import {
  BASELINE_FRESH_SECONDS,
  MAX_COURSES,
  MAX_DONE_LISTED,
  MAX_EVENTS,
  WEEK_SECONDS,
  type CourseWeek,
  type WeeklyInput,
  weekOf,
  weeklyProgress,
} from "../lib/weekly-progress-rules";

const DAY = 86_400;
// Wednesday 11 November 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 10, 11, 12) / 1000;

const lesson = (id: string, extra: Partial<Lesson> = {}): Lesson => ({
  id,
  title: `Lesson ${id}`,
  preview: false,
  video: null,
  files: [],
  link: null,
  hasBody: true,
  quiz: null,
  ...extra,
});

function course(id: string, modules: { drip?: number; lessons: Lesson[] }[], startsAt: number | null = null): Course {
  return {
    id,
    modules: modules.map((m, i) => ({ id: `m${i}`, title: `Module ${i + 1}`, dripDays: m.drip ?? 0, lessons: m.lessons })),
    certificate: false,
    startsAt,
  };
}

const basic = () => course("c1", [{ lessons: ["a", "b", "c", "d"].map((id) => lesson(id)) }]);

function week(over: Partial<CourseWeek> = {}): CourseWeek {
  return {
    courseId: "c1",
    title: "Course one",
    course: basic(),
    joinedSeconds: NOW - 60 * DAY,
    done: new Set<string>(),
    passed: new Set<string>(),
    doneBefore: new Set<string>(),
    lastSummarySeconds: NOW - WEEK_SECONDS,
    ...over,
  };
}

function input(over: Partial<WeeklyInput> = {}): WeeklyInput {
  return { storeOn: true, studentChose: true, wroteThisWeek: false, courses: [week()], events: [], nowSeconds: NOW, ...over };
}

const event = (id: string, inDays: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Event ${id}`,
  start: (NOW + inDays * DAY) * 1000,
  minutes: 60,
  cancelled: false,
  ...extra,
});

test("off by default: nothing goes out unless the store allows it and the student chose it", () => {
  assert.deepEqual(weeklyProgress(input({ storeOn: false })), { send: false, why: "off", baseline: [] });
  assert.deepEqual(weeklyProgress(input({ studentChose: false })), { send: false, why: "not chosen", baseline: [] });
});

test("a week with nothing new sends nothing, and the baseline still moves to now", () => {
  const out = weeklyProgress(input({ courses: [week({ done: new Set(["a"]), doneBefore: new Set(["a"]) })] }));
  assert.deepEqual(out, { send: false, why: "no news", baseline: [{ courseId: "c1", done: ["a"] }] });
});

test("lessons marked done since the last summary are this week's, in course order, with the next lesson", () => {
  const out = weeklyProgress(input({ courses: [week({ done: new Set(["c", "a", "b"]), doneBefore: new Set(["a"]) })] }));
  assert.equal(out.send, true);
  if (!out.send) return;
  assert.equal(out.week, "2026-11-09");
  assert.deepEqual(out.courses, [
    {
      courseId: "c1",
      title: "Course one",
      doneThisWeek: [
        { id: "b", title: "Lesson b" },
        { id: "c", title: "Lesson c" },
      ],
      moreDone: 0,
      doneCount: 3,
      total: 4,
      finished: false,
      next: { id: "d", title: "Lesson d" },
      opened: 0,
      heldBy: null,
      nextOpensAt: null,
    },
  ]);
  assert.deepEqual(out.baseline, [{ courseId: "c1", done: ["a", "b", "c"] }]);
  assert.deepEqual(out.events, []);
  assert.equal(out.moreEvents, 0);
  assert.equal(out.moreCourses, 0);
});

test("unmarking a lesson is not news, and a lesson no longer in the course is never counted", () => {
  const unmarked = weeklyProgress(input({ courses: [week({ done: new Set(["a"]), doneBefore: new Set(["a", "b"]) })] }));
  assert.equal(unmarked.send, false);
  const gone = weeklyProgress(input({ courses: [week({ done: new Set(["a", "zz"]), doneBefore: new Set(["a"]) })] }));
  assert.deepEqual(gone, { send: false, why: "no news", baseline: [{ courseId: "c1", done: ["a"] }] });
});

test("with no baseline, or one too old, 'this week' is not known: never claimed and never news by itself", () => {
  const first = weeklyProgress(input({ courses: [week({ done: new Set(["a", "b"]), doneBefore: null, lastSummarySeconds: null })] }));
  assert.deepEqual(first, { send: false, why: "no news", baseline: [{ courseId: "c1", done: ["a", "b"] }] });
  const old = weeklyProgress(
    input({ courses: [week({ done: new Set(["a", "b"]), doneBefore: new Set(), lastSummarySeconds: NOW - BASELINE_FRESH_SECONDS - 1 })] }),
  );
  assert.equal(old.send, false);
  // With an event coming, it goes out, but says nothing about lessons done this week.
  const withEvent = weeklyProgress(
    input({ courses: [week({ done: new Set(["a", "b"]), doneBefore: null, lastSummarySeconds: null })], events: [event("e1", 2)] }),
  );
  assert.equal(withEvent.send, true);
  if (!withEvent.send) return;
  assert.equal(withEvent.courses[0].doneThisWeek, null);
  assert.equal(withEvent.courses[0].doneCount, 2);
  assert.deepEqual(withEvent.events, [{ id: "e1", title: "Event e1", start: (NOW + 2 * DAY) * 1000 }]);
});

test("a baseline from the future or not a number is not known either", () => {
  for (const at of [NOW + 10, Number.NaN, Number.POSITIVE_INFINITY]) {
    const out = weeklyProgress(input({ courses: [week({ done: new Set(["a"]), doneBefore: new Set(), lastSummarySeconds: at })] }));
    assert.equal(out.send, false, String(at));
  }
});

test("events: only coming ones, not cancelled, starting within the next seven days, soonest first, at most a few", () => {
  const events = [
    event("late", 8),
    event("past", -1),
    event("off", 1, { cancelled: true }),
    event("e3", 3),
    event("e1", 1),
    event("e2", 2),
    event("e4", 4),
    event("e5", 5),
  ];
  const out = weeklyProgress(input({ events }));
  assert.equal(out.send, true);
  if (!out.send) return;
  assert.deepEqual(
    out.events?.map((e) => e.id),
    ["e1", "e2", "e3"].slice(0, MAX_EVENTS),
  );
  assert.equal(out.moreEvents, 5 - MAX_EVENTS);
  // An event alone is news; a course with nothing new is then left out of the email.
  assert.deepEqual(out.courses, []);
});

test("events that could not be read are never said to be none: no news is then unknown, and news goes out without them", () => {
  assert.deepEqual(weeklyProgress(input({ events: null })), { send: false, why: "unknown", baseline: [{ courseId: "c1", done: [] }] });
  const out = weeklyProgress(input({ events: null, courses: [week({ done: new Set(["a"]) })] }));
  assert.equal(out.send, true);
  if (!out.send) return;
  assert.equal(out.events, null);
  assert.equal(out.moreEvents, 0);
});

test("one email a week per person: nothing when the store already wrote this week, and unknown is not 'no'", () => {
  const news = { courses: [week({ done: new Set(["a"]) })] };
  assert.deepEqual(weeklyProgress(input({ ...news, wroteThisWeek: true })), {
    send: false,
    why: "already written",
    baseline: [{ courseId: "c1", done: ["a"] }],
  });
  assert.deepEqual(weeklyProgress(input({ ...news, wroteThisWeek: null })), {
    send: false,
    why: "unknown",
    baseline: [{ courseId: "c1", done: ["a"] }],
  });
});

test("the next lesson is one the student can open: not before its module opens, not behind a quiz still to pass", () => {
  const dripped = course("c1", [{ lessons: [lesson("a")] }, { drip: 30, lessons: [lesson("b")] }]);
  const waiting = weeklyProgress(
    input({ courses: [week({ course: dripped, joinedSeconds: NOW - 10 * DAY, done: new Set(["a"]), doneBefore: new Set() })] }),
  );
  assert.equal(waiting.send, true);
  if (!waiting.send) return;
  assert.equal(waiting.courses[0].next, null);
  assert.equal(waiting.courses[0].nextOpensAt, NOW + 20 * DAY);
  assert.equal(waiting.courses[0].heldBy, null);

  const quizzed = course("c1", [
    { lessons: [lesson("a", { quiz: { questions: 3, passPercent: 80, attempts: 3, required: true } }), lesson("b")] },
  ]);
  const held = weeklyProgress(input({ courses: [week({ course: quizzed, done: new Set(["a"]), doneBefore: new Set() })] }));
  assert.equal(held.send, true);
  if (!held.send) return;
  assert.equal(held.courses[0].next, null);
  assert.deepEqual(held.courses[0].heldBy, { id: "a", title: "Lesson a" });

  const passed = weeklyProgress(
    input({ courses: [week({ course: quizzed, done: new Set(["a"]), passed: new Set(["a"]), doneBefore: new Set() })] }),
  );
  assert.equal(passed.send, true);
  if (!passed.send) return;
  assert.deepEqual(passed.courses[0].next, { id: "b", title: "Lesson b" });
  assert.equal(passed.courses[0].heldBy, null);
});

test("finishing this week says so, with no next lesson", () => {
  const out = weeklyProgress(input({ courses: [week({ done: new Set(["a", "b", "c", "d"]), doneBefore: new Set(["a", "b", "c"]) })] }));
  assert.equal(out.send, true);
  if (!out.send) return;
  assert.equal(out.courses[0].finished, true);
  assert.equal(out.courses[0].next, null);
  assert.equal(out.courses[0].nextOpensAt, null);
});

test("lessons that opened for the student this week are news; a module open since they joined is not", () => {
  const dripped = course("c1", [{ lessons: [lesson("a")] }, { drip: 7, lessons: [lesson("b"), lesson("c")] }]);
  const opened = weeklyProgress(
    input({ courses: [week({ course: dripped, joinedSeconds: NOW - 10 * DAY, done: new Set(["a"]), doneBefore: new Set(["a"]) })] }),
  );
  assert.equal(opened.send, true);
  if (!opened.send) return;
  assert.equal(opened.courses[0].opened, 2);
  assert.deepEqual(opened.courses[0].doneThisWeek, []);
  assert.deepEqual(opened.courses[0].next, { id: "b", title: "Lesson b" });

  const longAgo = weeklyProgress(
    input({ courses: [week({ course: dripped, joinedSeconds: NOW - 40 * DAY, done: new Set(["a"]), doneBefore: new Set(["a"]) })] }),
  );
  assert.equal(longAgo.send, false);

  // A cohort that begins this week, bought before it: its first module opening is news.
  const cohort = course("c1", [{ lessons: [lesson("a")] }], NOW - 2 * DAY);
  const began = weeklyProgress(input({ courses: [week({ course: cohort, joinedSeconds: NOW - 20 * DAY, doneBefore: new Set() })] }));
  assert.equal(began.send, true);
  if (!began.send) return;
  assert.equal(began.courses[0].opened, 1);
  // A late joiner to the same cohort found it already open: not news.
  const late = weeklyProgress(input({ courses: [week({ course: cohort, joinedSeconds: NOW - DAY, doneBefore: new Set() })] }));
  assert.equal(late.send, false);
});

test("one email for every course of the store, the ones with news only, and long lists are cut with a count", () => {
  const many = Array.from({ length: MAX_DONE_LISTED + 3 }, (_, i) => lesson(`l${i}`));
  const big = course("c2", [{ lessons: many }]);
  const courses = [
    week({ done: new Set(["a"]) }),
    week({ courseId: "c2", title: "Course two", course: big, done: new Set(many.map((l) => l.id)) }),
    week({ courseId: "c3", title: "Quiet", done: new Set(["a"]), doneBefore: new Set(["a"]) }),
    ...Array.from({ length: MAX_COURSES }, (_, i) => week({ courseId: `x${i}`, title: `X${i}`, done: new Set(["a"]) })),
  ];
  const out = weeklyProgress(input({ courses }));
  assert.equal(out.send, true);
  if (!out.send) return;
  assert.equal(out.courses.length, MAX_COURSES);
  assert.equal(out.moreCourses, MAX_COURSES + 2 - MAX_COURSES);
  assert.ok(!out.courses.some((c) => c.courseId === "c3"));
  const two = out.courses.find((c) => c.courseId === "c2");
  assert.equal(two?.doneThisWeek?.length, MAX_DONE_LISTED);
  assert.equal(two?.moreDone, 3);
  assert.equal(two?.doneCount, MAX_DONE_LISTED + 3);
  // Every course read is in the baseline, the quiet one and those past the cut too.
  assert.equal(out.baseline.length, courses.length);
});

test("the week is named by its Monday, in UTC", () => {
  assert.equal(weekOf(Date.UTC(2026, 10, 9, 0, 0, 0) / 1000), "2026-11-09");
  assert.equal(weekOf(Date.UTC(2026, 10, 15, 23, 59, 59) / 1000), "2026-11-09");
  assert.equal(weekOf(Date.UTC(2026, 10, 16, 0, 0, 0) / 1000), "2026-11-16");
});

test("a clock that is not a time sends nothing", () => {
  assert.deepEqual(weeklyProgress(input({ nowSeconds: Number.NaN, courses: [week({ done: new Set(["a"]) })] })), {
    send: false,
    why: "unknown",
    baseline: [],
  });
});

test("honest by shape: no streak, rank, praise, urgency or comparison field anywhere in what goes out", () => {
  const out = weeklyProgress(input({ courses: [week({ done: new Set(["a"]) })], events: [event("e1", 1)] }));
  assert.equal(out.send, true);
  if (!out.send) return;
  assert.deepEqual(Object.keys(out).sort(), ["baseline", "courses", "events", "moreCourses", "moreEvents", "send", "week"]);
  assert.deepEqual(Object.keys(out.courses[0]).sort(), [
    "courseId",
    "doneCount",
    "doneThisWeek",
    "finished",
    "heldBy",
    "moreDone",
    "next",
    "nextOpensAt",
    "opened",
    "title",
    "total",
  ]);
  assert.deepEqual(Object.keys(out.events?.[0] ?? {}).sort(), ["id", "start", "title"]);
});
