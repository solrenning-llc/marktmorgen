/**
 * A lesson marked done takes its room in the store's data room once
 * (lib/learn.ts, markLesson), however it is marked: from two tabs at the same
 * time, or after a "is it done already?" read that came back in a shape that
 * cannot be read (CX-123 rule 24). The set of lessons done holds the lesson
 * once, so the room it takes must be counted once; counted twice, the store's
 * room fills with bytes nothing holds, and is never given back when the
 * lesson is unmarked (that gives back one lesson's worth).
 *
 * Real markLesson and data room against tests/redis-stub.ts. Synthetic data only.
 */
import { markLesson } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "c".repeat(32);
const LESSON = "lessonone001";
const STUDENT = "student@example.com";

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const original = redis.pipeline;
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;

  part("One lesson marked done once takes its room once");
  redis.clear();
  await markLesson(COURSE, STUDENT, LESSON, true, ROOM);
  const once = await used();
  is("marking it takes some room", once > 0, true);
  await markLesson(COURSE, STUDENT, LESSON, false, ROOM);
  is("unmarking it gives all of it back", await used(), 0);

  part("Marked done from two tabs at the same time: counted once");
  redis.clear();
  await Promise.all([markLesson(COURSE, STUDENT, LESSON, true, ROOM), markLesson(COURSE, STUDENT, LESSON, true, ROOM)]);
  is("the room holds one lesson's worth", await used(), once);
  await markLesson(COURSE, STUDENT, LESSON, false, ROOM);
  is("unmarked, nothing is left counted", await used(), 0);

  part("Already done, but the check came back unreadable: counted once");
  redis.clear();
  await markLesson(COURSE, STUDENT, LESSON, true, ROOM);
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "SISMEMBER") return ["?"];
    return original.call(redis, commands);
  };
  try {
    await markLesson(COURSE, STUDENT, LESSON, true, ROOM);
  } finally {
    redis.pipeline = original;
  }
  is("the room still holds one lesson's worth", await used(), once);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
