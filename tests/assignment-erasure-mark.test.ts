/**
 * #4271 (from Codex L, hidden #4034): a first hand-in (lib/assignment.ts handIn) that read "no work yet" before the student's
 * erasure writes after it: HAND_IN_WRITE_IF compares "" with "" and writes, so the student's text and their places in
 * the course's lists come back after forgetTasksPerson reported nothing left. Synthetic only (in-memory Redis stand-in).
 */
import { forgetTasksPerson, handIn } from "@/lib/assignment";
import type { Task } from "@/lib/assignment-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "crs_zz4271";
const LESSON = "lsnzzaaaaaaa";
const WHO = "fedcba9876543210";
const subKey = `nl:course:${COURSE}:task:${LESSON}:sub:${WHO}`;
const allKey = `nl:course:${COURSE}:tasks:all`;
const waitingKey = `nl:course:${COURSE}:tasks:waiting`;
const TASK: Task = { prompt: "Write it.", review: true, gate: false, file: false };

async function main(): Promise<void> {
  redis.clear();
  part("the student's first hand-in is in flight when their erasure completes");
  const original = redis.pipeline.bind(redis);
  let erased: { records: number } | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!erased && commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:hand-in-write-if:v1")) {
      erased = await forgetTasksPerson(COURSE, [LESSON], WHO, null);
    }
    return original(commands);
  }) as typeof redis.pipeline;
  const result = await handIn({ data: ROOM, courseId: COURSE, lessonId: LESSON, who: WHO, email: "student@example.com", task: TASK, text: "My personal answer.", file: null }).then(
    (r) => r.state,
    (error: unknown) => (error instanceof Error ? error.name : "thrown"),
  );
  redis.pipeline = original;
  is("(control) the erasure ran between the hand-in's read and its write and found nothing yet", (erased as { records: number } | null)?.records, 0);
  is("after completed erasure, the hand-in is not written", result === "waiting" || result === "approved", false);
  is("after completed erasure, no work record holds the student's text", redis.run(["GET", subKey]), null);
  is("after completed erasure, the student is not in the course's list of work", redis.run(["ZSCORE", allKey, `${LESSON}|${WHO}`]), null);
  is("after completed erasure, the student is not in the waiting list", redis.run(["ZSCORE", waitingKey, `${LESSON}|${WHO}`]), null);

  part("a hand-in that starts after the erasure is written as usual");
  const later = await handIn({ data: ROOM, courseId: COURSE, lessonId: LESSON, who: WHO, email: "student@example.com", task: TASK, text: "A new answer.", file: null });
  is("the later hand-in is waiting for review", later.state, "waiting");
  is("its record is kept", typeof redis.run(["GET", subKey]), "string");
  is("it is in the waiting list", redis.run(["ZSCORE", waitingKey, `${LESSON}|${WHO}`]) !== null, true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
