/**
 * The course page's student counts are never a part shown as the whole
 * (Claude 3's studio performance audit, 13 November 2026; VR item 2).
 *
 * The page reads every student's row but what each marked done only for the
 * 500 seen most recently (studentsOf, lib/learn.ts). It showed "opened it"
 * from every student and "finished a lesson" and "finished it all" from those
 * 500 alone, side by side, as if both were the whole course. studentSummary
 * says which part the lesson counts come from, so the page says so, and reads
 * nothing more.
 */
import { studentSummary, type Student } from "@/lib/learn";
import { done, is, part } from "./check";

const student = (i: number, doneLessons: number): Student => ({ email: `s${i}@example.test`, since: 1, lastSeen: 1_000_000 - i, done: doneLessons, blocked: false });

function main(): void {
  part("A course with more students than the page reads");
  // 500 read (the newest), 1,200 in all; 40 of the 500 finished, 300 started.
  const shown = Array.from({ length: 500 }, (_, i) => student(i, i < 40 ? 5 : i < 300 ? 1 : 0));
  const summary = studentSummary({ students: shown, total: 1_200 }, 5);
  is("everyone who opened it is counted", summary.opened, 1_200);
  is("the lesson counts are from the students read", [summary.started, summary.finished], [300, 40]);
  is("and say they are from the 500 most recent, not the whole course", summary.among, 500);

  part("A course whose students are all read");
  const all = Array.from({ length: 12 }, (_, i) => student(i, i < 3 ? 5 : i < 7 ? 2 : 0));
  const whole = studentSummary({ students: all, total: 12 }, 5);
  is("the counts are the whole course, said as such", [whole.opened, whole.started, whole.finished, whole.among], [12, 7, 3, null]);

  part("A course with no lessons yet");
  is("nobody has finished it all", studentSummary({ students: all, total: 12 }, 0).finished, 0);

  done();
}

main();
