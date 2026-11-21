/**
 * The erasure counts what reading a store's dropped courses costs before it reads (#4542, Claude 1 cloud R's MÉDIO and
 * its RED test, kept as written): every byte of the dropped-course list is inside the budget.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { OWNER, makeWorld } from "./erasure-world";
import { erasureScope, erasureSize } from "@/lib/person-erasure";
import { ERASE_PER } from "@/lib/erasure-rules";
import { MAX_NOTED_LESSONS, MAX_NOTED_MODULES, REMOVED_COURSE_RECORD_BYTES, noteRemovedCourse } from "@/lib/removed-courses";
import { MAX_LESSONS, MAX_MODULES, newItemId } from "@/lib/course";
import { storeForEmail } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";

async function main(): Promise<void> {
  part("A store that dropped 100 full courses; a stranger's erasure");
  redis.clear();
  await makeWorld();
  const store = (await storeForEmail(OWNER))!;
  for (let i = 0; i < 100; i += 1) {
    const noted = await noteRemovedCourse(store.statsId, {
      productId: newItemId(),
      courseId: newItemId(),
      lessonIds: Array.from({ length: MAX_LESSONS }, () => newItemId()),
      moduleIds: Array.from({ length: MAX_MODULES }, () => newItemId()),
    });
    if (noted !== "noted") throw new Error("not noted");
  }
  const [pairs] = (await redisPipeline([["HGETALL", `nl:coursegone:${store.statsId}`]])) as unknown as [string[] | { result: string[] }];
  const list = Array.isArray(pairs) ? pairs : pairs.result;
  const read = list.reduce((sum, s) => sum + Buffer.byteLength(s), 0);
  const scope = (await erasureScope(store, "stranger@example.com"))!;
  const size = await erasureSize(scope);
  is("all 100 looked at", size.droppedCourses, 100);
  const budgeted = size.droppedCourses * ERASE_PER.droppedCourses[1];
  console.log(`  read ${read} bytes of the dropped-course list, budgeted ${budgeted}`);
  is("the bytes budgeted for the dropped-course list cover the bytes read", budgeted >= read, true);

  part("A course read whole, where the person has a record, is counted at its largest");
  is("a noted course holds at most an outline's lessons and modules", [MAX_NOTED_LESSONS, MAX_NOTED_MODULES], [MAX_LESSONS, MAX_MODULES]);
  const records = (await redisPipeline([["SCAN", "0", "MATCH", `nl:coursegone:${store.statsId}:c:*`, "COUNT", 10_000]])) as unknown as [[string, string[]]];
  const keys = records[0][1];
  const values = (await redisPipeline(keys.map((k) => ["GET", k]))) as unknown as string[];
  const largest = Math.max(...values.map((v) => Buffer.byteLength(v)));
  console.log(`  the largest course record holds ${largest} bytes, its bound ${REMOVED_COURSE_RECORD_BYTES}, counted ${ERASE_PER.droppedRecords[1]}`);
  is("every noted course's record is inside its bound", [keys.length, largest <= REMOVED_COURSE_RECORD_BYTES], [100, true]);
  is("and the erasure counts a record read at least at that bound", ERASE_PER.droppedRecords[1] >= REMOVED_COURSE_RECORD_BYTES, true);
  done();
}

void main();
