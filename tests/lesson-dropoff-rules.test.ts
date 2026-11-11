/**
 * Where students stop in a course (96 [D2-LESSON-DROPOFF], unit 1;
 * lib/lesson-dropoff-rules.ts; added 10 November 2026). Pure: nothing is read
 * here, every student is synthetic. Checked:
 *
 *   - each lesson says how many of the students who opened the course marked
 *     it done, out of all of them;
 *   - a student "stopped" at the first lesson in the course's order they did
 *     not mark done, only once they have not been seen for STOPPED_AFTER_DAYS
 *     and have not finished; one seen since is still going, never stopped;
 *   - a student who marked every lesson done finished, whatever the order;
 *   - lessons no longer in the course do not count, and a lesson added later
 *     is not done by anyone;
 *   - the lesson where most stopped is named only when at least
 *     MIN_STOPPED_FOR_PATTERN stopped, the earliest on a tie, and the words
 *     say where, never why;
 *   - an unreadable student (a time that is not a number) is not counted in
 *     any way, and is counted as unread.
 */
import { MIN_STOPPED_FOR_PATTERN, STOPPED_AFTER_DAYS, dropoffLines, lessonDropoff } from "@/lib/lesson-dropoff-rules";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12);
const lessons = [
  { id: "l1", title: "Welcome" },
  { id: "l2", title: "Setting up" },
  { id: "l3", title: "First project" },
  { id: "l4", title: "Wrapping up" },
];
const away = NOW - (STOPPED_AFTER_DAYS + 1) * DAY;
const recent = NOW - 2 * DAY;
const student = (doneIds: string[], lastSeen: number) => ({ done: doneIds, lastSeen });

part("Each lesson: how many marked it done, out of everyone who opened the course");
{
  const map = lessonDropoff(lessons, [student(["l1", "l2"], away), student(["l1"], recent), student([], away), student(["l1", "l2", "l3", "l4"], away)], NOW);
  is("the students counted", [map.students, map.unread], [4, 0]);
  is("done counts in the course's order", map.lessons.map((row) => [row.id, row.done]), [["l1", 3], ["l2", 2], ["l3", 1], ["l4", 1]]);
  is("each out of everyone who opened it", map.lessons.map((row) => row.of), [4, 4, 4, 4]);
  is("finished, still going and stopped", [map.finished, map.going, map.stopped], [1, 1, 2]);
  is("stopped at the first lesson not done", map.lessons.map((row) => row.stoppedHere), [1, 0, 1, 0]);
}

part("Stopped only once not seen for STOPPED_AFTER_DAYS; seen since is still going");
{
  const edge = NOW - STOPPED_AFTER_DAYS * DAY;
  const map = lessonDropoff(lessons, [student(["l1"], edge), student(["l1"], edge - 1), student(["l1"], NOW + DAY)], NOW);
  is("exactly STOPPED_AFTER_DAYS ago is still going; a moment more is stopped; a time ahead is still going", [map.going, map.stopped], [2, 1]);
  is("STOPPED_AFTER_DAYS is two weeks", STOPPED_AFTER_DAYS, 14);
}

part("The first lesson not done, in the course's order, whatever order they were done in");
{
  const map = lessonDropoff(lessons, [student(["l1", "l3"], away), student(["l4", "l3", "l2", "l1"], recent)], NOW);
  is("a gap: stopped at l2, the first not done", map.lessons.map((row) => row.stoppedHere), [0, 1, 0, 0]);
  is("every lesson done in another order is finished", map.finished, 1);
}

part("Lessons no longer in the course do not count; a new one is done by nobody");
{
  const map = lessonDropoff([...lessons, { id: "l5", title: "Bonus" }], [student(["l1", "l2", "l3", "l4", "gone"], away)], NOW);
  is("the removed lesson is not counted anywhere", map.lessons.map((row) => row.id), ["l1", "l2", "l3", "l4", "l5"]);
  is("the new lesson: nobody has done it, and the student stopped there", [map.lessons[4].done, map.lessons[4].stoppedHere, map.finished], [0, 1, 0]);
}

part("A course with no lessons, or no students");
{
  is("no lessons: nobody finished, nobody stopped", (() => {
    const map = lessonDropoff([], [student([], away)], NOW);
    return [map.lessons.length, map.finished, map.stopped, map.going];
  })(), [0, 0, 0, 1]);
  const none = lessonDropoff(lessons, [], NOW);
  is("no students: every count is 0, nothing named", [none.students, none.lessons.map((row) => row.done), none.most], [0, [0, 0, 0, 0], null]);
}

part("The lesson where most stopped: named only with enough stopped, the earliest on a tie");
{
  const few = lessonDropoff(lessons, Array.from({ length: MIN_STOPPED_FOR_PATTERN - 1 }, () => student(["l1"], away)), NOW);
  is("fewer than MIN_STOPPED_FOR_PATTERN stopped: nothing named", few.most, null);
  const many = lessonDropoff(lessons, [
    ...Array.from({ length: 3 }, () => student(["l1"], away)),
    ...Array.from({ length: 3 }, () => student(["l1", "l2", "l3"], away)),
    student([], away),
  ], NOW);
  is("a tie goes to the earlier lesson", many.most, "l2");
  is("MIN_STOPPED_FOR_PATTERN is five", MIN_STOPPED_FOR_PATTERN, 5);
}

part("Students that cannot be read are counted apart, never as anything else");
{
  const map = lessonDropoff(lessons, [
    student(["l1"], away),
    { done: ["l1"], lastSeen: Number.NaN },
    { done: "l1" as unknown as string[], lastSeen: away },
    { done: [1, 2] as unknown as string[], lastSeen: away },
    null as unknown as { done: string[]; lastSeen: number },
  ], NOW);
  is("one read, four unread", [map.students, map.unread], [1, 4]);
  is("the unread add to no lesson", map.lessons[0].done, 1);
}

part("The words: where, never why, and every count out of its whole");
{
  const map = lessonDropoff(lessons, [
    ...Array.from({ length: 5 }, () => student(["l1"], away)),
    student(["l1", "l2", "l3", "l4"], away),
    student(["l1"], recent),
  ], NOW);
  const lines = dropoffLines(map);
  is("a line per lesson, out of everyone", lines.lessons, [
    "Welcome: 7 of 7 students marked it done.",
    "Setting up: 1 of 7 students marked it done. 5 stopped here.",
    "First project: 1 of 7 students marked it done.",
    "Wrapping up: 1 of 7 students marked it done.",
  ]);
  is("the summary", lines.summary, "Of 7 students, 1 finished, 1 is still going and 5 stopped (not seen for 14 days).");
  is("the lesson named, and that the map says where, not why", lines.most, "Students stopped most often at \"Setting up\". This shows where they stopped, not why.");
  const tied = dropoffLines(lessonDropoff(lessons, [...Array.from({ length: 3 }, () => student(["l1"], away)), ...Array.from({ length: 3 }, () => student(["l1", "l2", "l3"], away))], NOW));
  is("a tie is said, the earliest named", tied.most, "Students stopped most often at \"Setting up\", as often as at 1 other lesson. This shows where they stopped, not why.");
  const words = JSON.stringify(lines).toLowerCase();
  is("no word of cause", ["because", "caused", "due to", "boring", "too hard", "too long"].filter((word) => words.includes(word)), []);
  const one = dropoffLines(lessonDropoff(lessons, [student(["l1"], recent)], NOW));
  is("one student, in the singular; nothing named", [one.lessons[0], one.summary, one.most], [
    "Welcome: 1 of 1 student marked it done.",
    "Of 1 student, 0 finished, 1 is still going and 0 stopped (not seen for 14 days).",
    "",
  ]);
  const unread = dropoffLines(lessonDropoff(lessons, [student([], away), { done: [], lastSeen: Number.NaN }], NOW));
  is("unread students are said, never hidden", unread.unread, "1 student could not be read, so is not counted here.");
  is("none unread: nothing said", one.unread, "");
}

part("A clock or a time that cannot be right is never read as a result");
{
  // Claude 3 (6795042817), Claude 1 (6799237269) and review 6804098197: an unreadable now made everyone "still going",
  // and an impossible lastSeen (negative, zero, fractional or in the future) counted someone as stopped or going.
  let threw = 0;
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5]) {
    try {
      lessonDropoff(lessons, [{ done: [], lastSeen: NOW - DAY }], bad);
    } catch {
      threw += 1;
    }
  }
  is("an unreadable clock is refused, never a confident map", threw, 5);
  const odd = lessonDropoff(lessons, [{ done: ["l1"], lastSeen: -1 }, { done: ["l1"], lastSeen: 0 }, { done: ["l1"], lastSeen: NOW - 2.5 }, { done: ["l1"], lastSeen: NOW + 30 * DAY }, { done: ["l1"], lastSeen: NOW - 20 * DAY }], NOW);
  is("impossible times are unread, not stopped or going", [odd.unread, odd.stopped, odd.going, odd.students], [4, 1, 0, 1]);
}

done();
