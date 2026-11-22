/**
 * Issue #4287, item 8 (Codex P, `P-20261112-1838-course-drip-fail-open.md`; rule 24): a module's `dripDays`
 * (lib/course.ts parseModule) that did not read as a whole number of days from 0 to MAX_DRIP_DAYS became 0, so a
 * module the creator set to open later opened at once to every buyer. The course's writers (editCourse's
 * module-edit and outline, emptyCourse) only ever write such a number, and modules saved before drips existed have
 * none; so a missing value still means no wait, and any other value makes the whole course unreadable, as a course
 * that does not parse already is (parseCourse null): buyers' pages fail closed, and the exact readers answer
 * UnknownReply (the drip gate then says "unchecked", never open).
 *
 * Synthetic records only.
 */
import { MAX_DRIP_DAYS, parseCourse, readCourseExact } from "@/lib/course";
import { UnknownReply } from "@/lib/redis-exact";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "a".repeat(32);
const lesson = { id: "lessonaaaaa1", title: "One", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null };
const stored = (drip: unknown) => {
  const module: Record<string, unknown> = { id: "moduleaaaaa1", title: "Week 2", lessons: [lesson] };
  if (drip !== undefined) module.dripDays = drip;
  return JSON.stringify({ id: ID, modules: [{ id: "moduleaaaaa0", title: "Week 1", dripDays: 0, lessons: [] }, module], certificate: false, startsAt: null });
};
const drip = (raw: unknown) => {
  const course = parseCourse(stored(raw));
  return course ? course.modules[1]?.dripDays : "unreadable";
};

async function main(): Promise<void> {
  part("As the writers write it");
  is("0 days", drip(0), 0);
  is("a week", drip(7), 7);
  is("the longest wait", drip(MAX_DRIP_DAYS), MAX_DRIP_DAYS);
  is("missing (a module from before drips): no wait", drip(undefined), 0);

  part("Any other value: the course is unreadable, never a module open at once");
  for (const [label, raw] of [["text", "abc"], ["digits as text", "3"], ["negative", -1], ["a fraction", 1.5], ["past the longest", MAX_DRIP_DAYS + 1], ["nothing", null], ["true", true], ["a list", [3]]] as const) {
    is(label, drip(raw), "unreadable");
  }

  part("The exact reader answers it as unknown");
  redis.clear();
  await redis.pipeline([["SET", `nl:course:${ID}`, stored("abc")]]);
  const answer = await readCourseExact(ID).then(() => "read", (error: unknown) => (error instanceof UnknownReply ? "unknown" : String(error)));
  is("unknown", answer, "unknown");

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
