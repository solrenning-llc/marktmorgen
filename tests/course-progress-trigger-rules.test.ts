/**
 * 287 [H4-1], unit 1: an automation that starts when a student reaches a
 * share of a course, as pure rules (lib/course-progress-trigger-rules.ts).
 * The creator picks the share (1 to 100%); the share done is only progress
 * measured on the server (lessons marked done, quizzes and assignments
 * passed, over all the course counts), rounded down; a student fires each
 * share once per course. Anything that cannot be read never fires. Nothing
 * is wired yet.
 */
import { progressOnceName, progressShare, readTriggerShare, reachedShare } from "@/lib/course-progress-trigger-rules";
import { done, is, part } from "./check";

part("The creator's share: a whole percent from 1 to 100");
for (const ok of [1, 25, 80, 100]) is(`${ok}%`, readTriggerShare(ok), ok);
is("as text from a form", readTriggerShare("50"), 50);
for (const bad of [0, 101, 33.3, -5, "half", "", null, undefined]) is(`refused: ${JSON.stringify(bad)}`, readTriggerShare(bad), null);

part("The share done, from what the server measured, rounded down");
is("none of 10", progressShare(0, 10), 0);
is("3 of 10", progressShare(3, 10), 30);
is("2 of 3 is 66, never 67", progressShare(2, 3), 66);
is("all of them", progressShare(7, 7), 100);
for (const [label, doneCount, total] of [
  ["a course with nothing in it", 0, 0],
  ["more done than the course has", 11, 10],
  ["a negative count", -1, 10],
  ["a count that is not whole", 1.5, 10],
  ["a count that is not a number", Number.NaN, 10],
] as const) is(`unknown: ${label}`, progressShare(doneCount, total), null);

part("Reached: crossing the share, said once");
is("70% to 80% reaches 80%", reachedShare(70, 80, 80), "yes");
is("70% to 90% reaches 80%", reachedShare(70, 90, 80), "yes");
is("80% to 90% does not reach it again", reachedShare(80, 90, 80), "no");
is("still under", reachedShare(50, 70, 80), "no");
is("from nothing straight to all", reachedShare(0, 100, 80), "yes");
is("a share that is not one", reachedShare(70, 90, 0), "unknown");
is("a progress that could not be read", reachedShare(null, 90, 80), "unknown");
is("progress going back is not a crossing", reachedShare(90, 70, 80), "no");

part("Once per student per course per share");
const name = progressOnceName("flow_1", "course_1", "contact-hash-a", 80);
is("the same: the same name", name, progressOnceName("flow_1", "course_1", "contact-hash-a", 80));
is("another share: another name", name === progressOnceName("flow_1", "course_1", "contact-hash-a", 50), false);
is("another course: another name", name === progressOnceName("flow_1", "course_2", "contact-hash-a", 80), false);
is("never an address", progressOnceName("flow_1", "course_1", "a@b.c", 80), null);
is("a share that is not one: no name", progressOnceName("flow_1", "course_1", "contact-hash-a", 0), null);
done();
