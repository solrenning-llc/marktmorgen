/**
 * A cohort course: one clock for the whole room.
 *
 * Every course here ran to each student's own joining day — buy in March and
 * you are in week one in March; buy in July and you are in week one in July.
 * A cohort is the other kind: one date, set once, and everybody moves through
 * the weeks together from it.
 *
 * The whole difference is where the clock starts, so these check the clock
 * and nothing else. The cases that matter are the ones nobody would catch by
 * looking at a screen: a student who bought three weeks early must not be
 * able to open module one, and a student who joins late must not be made to
 * wait out the weeks again from their own joining day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Course,
  type CourseModule,
  EARLIEST_START,
  beforeStart,
  dripStart,
  isCohort,
  isOpen,
  latestStart,
  opensAt,
  editCourse,
  emptyCourse,
  parseCourse,
} from "@/lib/course";

const DAY = 86_400;
const MARCH = 1_772_496_000; // 2026-03-03, a Tuesday
const unit = (dripDays: number): CourseModule => ({ id: "a1b2c3d4e5f6", title: "Week", dripDays, lessons: [] });

function course(startsAt: number | null): Course {
  return { id: "f".repeat(32), modules: [], certificate: false, startsAt };
}

const rolling = course(null);
const cohort = course(MARCH);

test("without a date, nothing changes: the clock starts when the student does", () => {
  assert.equal(isCohort(rolling), false);
  const joined = MARCH + 40 * DAY;
  assert.equal(dripStart(rolling, joined), joined);
  assert.equal(opensAt(rolling, unit(7), joined), joined + 7 * DAY);

  assert.equal(isOpen(rolling, unit(0), joined, joined), true, "no wait means open at once");
  assert.equal(isOpen(rolling, unit(7), joined, joined + 6 * DAY), false);
  assert.equal(isOpen(rolling, unit(7), joined, joined + 7 * DAY), true);
});

test("with a date, the clock is the course's and the joining day is ignored", () => {
  assert.equal(isCohort(cohort), true);
  for (const joined of [MARCH - 30 * DAY, MARCH, MARCH + 30 * DAY]) {
    assert.equal(dripStart(cohort, joined), MARCH, "every student has the same clock");
    assert.equal(opensAt(cohort, unit(14), joined), MARCH + 14 * DAY);
  }
});

test("buying early does not open the course early", () => {
  const early = MARCH - 21 * DAY;
  // This is the one that would be invisible on a screenshot: on the old rule
  // a module with no wait was open the moment a student was in, so somebody
  // who bought three weeks before the course began could read week one.
  assert.equal(isOpen(cohort, unit(0), early, early), false, "day one is a day, not 'at once'");
  assert.equal(isOpen(cohort, unit(0), early, MARCH - 1), false, "still shut the night before");
  assert.equal(isOpen(cohort, unit(0), early, MARCH), true, "and open on the morning itself");
  assert.equal(beforeStart(cohort, early), true);
  assert.equal(beforeStart(cohort, MARCH), false);
});

test("joining late finds everything up to now already open, and waits with the rest", () => {
  const late = MARCH + 20 * DAY;
  assert.equal(isOpen(cohort, unit(0), late, late), true, "week one is behind them and open");
  assert.equal(isOpen(cohort, unit(14), late, late), true, "so is week three");
  assert.equal(isOpen(cohort, unit(28), late, late), false, "week five is not, for anybody");
  assert.equal(
    isOpen(cohort, unit(28), late, MARCH + 28 * DAY),
    true,
    "and it opens on the course's day, not 28 days after this student joined",
  );
});

test("a rolling course and a cohort disagree exactly where they should", () => {
  const joined = MARCH + 50 * DAY;
  const now = joined + 3 * DAY;
  assert.equal(isOpen(rolling, unit(21), joined, now), false, "rolling: 3 days in, week four is shut");
  assert.equal(isOpen(cohort, unit(21), joined, now), true, "cohort: the room is past week four already");
});

test("the date a student is shown does not depend on when they joined", () => {
  const shown = new Set([
    opensAt(cohort, unit(7), MARCH - 10 * DAY),
    opensAt(cohort, unit(7), MARCH + 10 * DAY),
    opensAt(cohort, unit(7), 0),
  ]);
  assert.equal(shown.size, 1, "one date for everyone, so the outline can show it before anybody buys");
  assert.equal([...shown][0], MARCH + 7 * DAY);
});

test("a date typed in the wrong unit is refused rather than stored", () => {
  const base = emptyCourse();
  // Milliseconds where seconds were meant: the year 56000-odd, course shut forever.
  const tooFar = editCourse(base, { op: "start", at: MARCH * 1000 });
  assert.equal(tooFar.ok, false);
  assert.equal(tooFar.ok === false && tooFar.reason, "start");

  // Seconds where milliseconds were meant: 1970, everything open at once.
  const tooEarly = editCourse(base, { op: "start", at: EARLIEST_START - 1 });
  assert.equal(tooEarly.ok, false);

  for (const bad of ["2026-03-03", Number.NaN, Infinity, {}, undefined]) {
    assert.equal(editCourse(base, { op: "start", at: bad }).ok, false, `refused: ${String(bad)}`);
  }
});

test("a real date is kept, and a past one is allowed: that is a course already running", () => {
  const base = emptyCourse();
  const set = editCourse(base, { op: "start", at: MARCH });
  assert.equal(set.ok, true);
  assert.equal(set.ok && set.course.startsAt, MARCH);

  const past = editCourse(base, { op: "start", at: EARLIEST_START + DAY });
  assert.equal(past.ok, true, "a course that began last year still takes late joiners");

  assert.ok(latestStart(MARCH) > MARCH, "and a date some way out is fine");
  const soon = editCourse(base, { op: "start", at: Math.floor(Date.now() / 1000) + 90 * DAY });
  assert.equal(soon.ok, true);
});

test("taking the date off puts every student back on their own clock", () => {
  const set = editCourse(emptyCourse(), { op: "start", at: MARCH });
  assert.equal(set.ok, true);
  const off = set.ok ? editCourse(set.course, { op: "start", at: null }) : null;
  assert.equal(off?.ok, true);
  assert.equal(off?.ok === true && off.course.startsAt, null);
  assert.equal(off?.ok === true && isCohort(off.course), false);
});

test("a course saved before any of this existed is a rolling one", () => {
  assert.equal(emptyCourse().startsAt, null);
});

test("a kept date is read only when it is one the studio could have saved (Claude 5's LEVE on #3653)", () => {
  // The studio keeps a whole number of seconds from 2020-01-01 on (editCourse "start"). A record damaged into a
  // negative, fractional, far-off or non-numeric date reads as no date: never a cohort that began in 1969 (every
  // module open at once) nor one in the year 33658 (nothing ever opens).
  const kept = (startsAt: unknown) => parseCourse(JSON.stringify({ ...emptyCourse(), startsAt }))?.startsAt;
  const real = EARLIEST_START + 400 * 86_400;
  assert.equal(kept(real), real, "a date the studio saved reads back");
  assert.equal(kept(EARLIEST_START), EARLIEST_START, "the earliest date reads back");
  for (const damaged of [-1, 0, EARLIEST_START - 1, real + 0.5, 1e15, Number.MAX_SAFE_INTEGER, "1700000000", true]) {
    assert.equal(kept(damaged), null, `a kept start of ${String(damaged)} reads as no date`);
  }
});
