/**
 * The name a student chose for a course's comments (lib/lesson-comments.ts,
 * addComment) takes its room in the store's data room once. The name box is
 * shown only until a name is chosen, but a second tab opened before that, or a
 * form sent again, sends it with the next comment too, and every such comment
 * took the name's room again although the record holds one name. Deleting the
 * person gives back one name's worth, so the rest stayed counted for good.
 *
 * Real addComment, erasure and data room against tests/redis-stub.ts. Synthetic data only.
 */
import { addComment, forgetLessonCommentsPerson } from "@/lib/lesson-comments";
import { emailKey } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COURSE = "e".repeat(32);
const L1 = "lessonone001";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const ana = emailKey("ana@example.com");
  const say = async (text: string, name?: string) => {
    const made = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: ana, text, name });
    if (!made.ok) throw new Error(`no comment: ${made.reason}`);
  };

  part("A name sent again with a later comment is not counted again");
  await say("First question", "Ana");
  const afterFirst = await used();
  await say("Second question");
  const comment = (await used()) - afterFirst;
  await say("Third question", "Ana");
  is("the third comment takes only its own room", (await used()) - afterFirst, 2 * comment);

  part("Deleting the person gives all of it back");
  await forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM);
  is("nothing is left counted", await used(), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
