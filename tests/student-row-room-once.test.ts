/**
 * A student's row in a course (lib/learn.ts, touchStudent) takes its room in
 * the store's data room once: when it is first written. Opening the course
 * for the first time in two tabs at once, or after a read of the row that
 * came back in a shape that cannot be read (CX-123 rule 24), wrote one row
 * and counted it twice, filling the store's room with bytes nothing holds.
 *
 * Real touchStudent and data room against tests/redis-stub.ts. Synthetic data only.
 */
import { touchStudent } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "d".repeat(32);
const STUDENT = "student@example.com";
const START = 1_780_000_000;

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const original = redis.pipeline;
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;

  part("A student's first visit takes the row's room; later visits take none");
  redis.clear();
  await touchStudent(COURSE, STUDENT, START, ROOM);
  const once = await used();
  is("the first visit takes some room", once > 0, true);
  await touchStudent(COURSE, STUDENT, START, ROOM);
  is("a second visit takes no more", await used(), once);

  part("First visit in two tabs at the same time: counted once");
  redis.clear();
  await Promise.all([touchStudent(COURSE, STUDENT, START, ROOM), touchStudent(COURSE, STUDENT, START, ROOM)]);
  is("the room holds one row's worth", await used(), once);

  part("The row is there, but its read came back unreadable: counted once");
  redis.clear();
  await touchStudent(COURSE, STUDENT, START, ROOM);
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "HGET") return [7];
    return original.call(redis, commands);
  };
  try {
    await touchStudent(COURSE, STUDENT, START, ROOM);
  } finally {
    redis.pipeline = original;
  }
  is("the room still holds one row's worth", await used(), once);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
