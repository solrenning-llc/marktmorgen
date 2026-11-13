/**
 * Reading what removing several assignments forgets reads the course's list of
 * work handed in once, not once per assignment (Claude 3's studio performance
 * audit, 13 November 2026).
 *
 * readTaskDrop reads the course's whole index of work handed in
 * (ZRANGEBYSCORE over every lesson) to find one lesson's. Removing a module
 * (app/api/store/course, module-remove) and deleting a course
 * (readCourseTaskDrops) asked it once per assignment, one after another, so a
 * course with many assignments and much work read the same index that many
 * times. Checked with Redis stubbed: the index is read once, and each drop
 * still holds its own lesson's work only.
 */
import { readCourseTaskDrops } from "@/lib/assignment";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COURSE = "crs_oneindex";
const LESSONS = ["lsn_a", "lsn_b", "lsn_c", "lsn_d"];
const allKey = `nl:course:${COURSE}:tasks:all`;

async function main(): Promise<void> {
  redis.clear();
  // Work handed in for two of the four assignments, and for a lesson that is not among them.
  await redis.pipeline([
    ["ZADD", allKey, 1, "lsn_a|who1", 2, "lsn_a|who2", 3, "lsn_c|who3", 4, "lsn_z|who4"],
    ["SET", `nl:course:${COURSE}:task:lsn_a`, JSON.stringify({ prompt: "Write" })],
  ]);
  const original = redis.pipeline.bind(redis);
  let indexReads = 0;
  redis.pipeline = async (batch) => {
    for (const command of batch) if (command[0] === "ZRANGEBYSCORE" && command[1] === allKey) indexReads += 1;
    return original(batch);
  };
  try {
    part("Deleting a course with four assignments");
    const course = { id: COURSE, modules: [{ lessons: LESSONS.map((id) => ({ id, task: { prompt: "x" } })) }] };
    const drops = await readCourseTaskDrops(course);
    is("the course's list of work is read once, not once per assignment", indexReads, 1);
    is("each assignment still holds only its own lesson's work", drops.map((d) => [d.lessonId, d.gone]), [["lsn_a", ["lsn_a|who1", "lsn_a|who2"]], ["lsn_b", []], ["lsn_c", ["lsn_c|who3"]], ["lsn_d", []]]);

  } finally {
    redis.pipeline = original;
  }
  done();
}

void main();
