/**
 * Deleting a person from a store's courses (lib/learn.ts, forgetLearnerPerson)
 * gives back to the store's data room what their course records took: the
 * lessons they marked done (markLesson) and their row in each course
 * (touchStudent), as deleting their lesson comments does
 * (lib/lesson-comments.ts). It deleted them and kept their room counted for
 * good, so every erased student left the store's room a little fuller.
 *
 * Real course writers, erasure and data room against tests/redis-stub.ts. Synthetic data only.
 */
import { forgetLearnerPerson, markLesson, touchStudent } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "d".repeat(32);
const OTHER = "e".repeat(32);
const STORE = { ...ROOM, email: "school@example.com", statsId: "a".repeat(32) } as unknown as Store;

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  redis.clear();
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const now = Math.floor(Date.now() / 1000);

  part("A student's lessons and rows in two courses, beside another student's");
  await touchStudent(COURSE, "ben@example.com", now, ROOM);
  await markLesson(COURSE, "ben@example.com", "lessonone001", true, ROOM);
  const bens = await used();
  await touchStudent(COURSE, "ana@example.com", now, ROOM);
  await markLesson(COURSE, "ana@example.com", "lessonone001", true, ROOM);
  await markLesson(COURSE, "ana@example.com", "lessontwo002", true, ROOM);
  await touchStudent(OTHER, "ana@example.com", now, ROOM);
  await markLesson(OTHER, "ana@example.com", "lessonone001", true, ROOM);
  is("Ana's records take room", (await used()) > bens, true);

  const removed = await forgetLearnerPerson(STORE, "ana@example.com", [
    { courseId: COURSE, moduleIds: ["module000001"] },
    { courseId: OTHER, moduleIds: ["module000001"] },
  ]);
  is("her records are deleted", removed >= 4, true);
  is("exactly their room is given back", await used(), bens);

  part("A second deletion gives back nothing more");
  await forgetLearnerPerson(STORE, "ana@example.com", [{ courseId: COURSE, moduleIds: [] }, { courseId: OTHER, moduleIds: [] }]);
  is("Ben's room is untouched", await used(), bens);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
