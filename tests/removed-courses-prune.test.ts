/**
 * A full list of dropped courses makes room only by an entry whose erasure can no longer be asked for (C7, follow-up
 * to #4542, privacy review LOW 1).
 *
 * Before: the list (lib/removed-courses.ts) never shrank, so after MAX_REMOVED_COURSES drops in a store's life every
 * further removal of a course product was refused. Now, when it is full, an entry leaves it only when both hold:
 *   - at least FINISH_KEEP_SECONDS (400 days, the keep already registered for the course's start and finish marks,
 *     the only course records not counted in the store's data room) have gone by since the drop; and
 *   - nothing of the course is left: no data-room slot of its people's records (cd: students and lessons done, ct:
 *     quiz tries and passes, cc: certificates, ca: tasks, lc: comments), no student row and no certificate in its
 *     indexes, so even a slot given back too early never lets a kept record lose its way to the erasure.
 * An entry with no drop time (noted before it was kept) never leaves.
 *
 * Synthetic: the in-memory Redis stand-in.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { MAX_REMOVED_COURSES, noteRemovedCourse, removedCourses } from "@/lib/removed-courses";
import { dataKey } from "@/lib/store-data";
import { FINISH_KEEP_SECONDS } from "@/lib/course-finish";
import { courseIndexes } from "@/lib/certificate";

const STATS = "statsprune0001";
const room = { sid: "sidprune0001", statsId: STATS, handle: "prune" };
const list = `nl:coursegone:${STATS}`;
const roomKey = dataKey(room)!;
const now = () => Math.floor(Date.now() / 1000);
const old = () => now() - FINISH_KEEP_SECONDS - 86_400;
const record = (t?: number) => JSON.stringify({ p: "", l: [], m: [], ...(t === undefined ? {} : { t }) });

/** A full list: the course under test first, then old entries each still holding a certificate slot. */
function fill(first: string, t?: number): void {
  redis.clear();
  redis.run(["HSET", list, first, record(t)]);
  for (let i = 1; i < MAX_REMOVED_COURSES; i += 1) {
    const id = `kept${i}`;
    redis.run(["HSET", list, id, record(old())]);
    redis.run(["HSET", roomKey, `cc:${id}`, "100"]);
  }
}
const next = () => noteRemovedCourse(STATS, { productId: "pnew", courseId: "cnew", lessonIds: [], moduleIds: [] }, room, courseIndexes);
const listed = async (id: string) => (await removedCourses(STATS)).some((c) => c.courseId === id);

async function main(): Promise<void> {
  part("A full list with an old entry that holds nothing any more");
  fill("cgone", old());
  is("the new drop is noted", await next(), "noted");
  is("the old, empty entry left the list", await listed("cgone"), false);
  is("the new one is on it", await listed("cnew"), true);

  part("An old entry whose course still has people's records in the data room stays");
  for (const slot of ["cd", "ct", "cc", "ca", "lc"]) {
    fill("cheld", old());
    redis.run(["HSET", roomKey, `${slot}:cheld`, "64"]);
    is(`${slot}: the list stays full`, await next(), "full");
    is(`${slot}: the entry is kept`, await listed("cheld"), true);
  }

  part("A recent entry stays, even with nothing left");
  fill("crecent", now() - 86_400);
  is("the list stays full", await next(), "full");
  is("the entry is kept", await listed("crecent"), true);

  part("A slot given back too early: a certificate still there keeps the entry");
  fill("ccert", old());
  redis.run(["HSET", roomKey, "cc:ccert", "0"]);
  redis.run(["HDEL", roomKey, "cc:ccert"]);
  redis.run(["SADD", "nl:course:ccert:certs:all", "abcdefabcdef0123"]);
  is("the list stays full", await next(), "full");
  is("the entry is kept", await listed("ccert"), true);

  part("A student row still there keeps the entry, whatever the room says");
  fill("crow", old());
  redis.run(["HSET", "nl:course:crow:students", "somebody", JSON.stringify({ e: "a@example.com", s: 1, l: 1 })]);
  is("the list stays full", await next(), "full");
  is("the entry is kept", await listed("crow"), true);

  part("An entry noted before the drop time was kept never leaves");
  fill("cuntimed");
  is("the list stays full", await next(), "full");
  is("the entry is kept", await listed("cuntimed"), true);

  part("A drop is noted with its time");
  redis.clear();
  await noteRemovedCourse(STATS, { productId: "p1", courseId: "c1", lessonIds: [], moduleIds: [] }, room, courseIndexes);
  const kept = JSON.parse(String(redis.run(["HGET", list, "c1"]))) as { t?: number };
  is("its time is kept, in seconds", typeof kept.t === "number" && Math.abs(kept.t - now()) <= 5, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
