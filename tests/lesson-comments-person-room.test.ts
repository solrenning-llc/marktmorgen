/**
 * Deleting a person (lib/person-erasure.ts) takes their lesson comments, the
 * answers under their own comments and the name they chose out of a course,
 * and gives back to the store's data room what those took, as the other
 * deletions of comments do (lib/lesson-comments.ts), once.
 */
import { addComment, forgetLessonCommentsPerson, lessonComments } from "@/lib/lesson-comments";
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
  const ben = emailKey("ben@example.com");
  const say = async (by: string, text: string, name?: string, parent?: string) => {
    const made = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by, text, name, parent: parent ?? null });
    if (!made.ok) throw new Error(`no comment: ${made.reason}`);
    return made.comment;
  };

  part("A deleted person's comments, the answers under them and their name give their room back");
  const bens = await say(ben, "Where are the slides?", "Ben");
  const withBen = await used();
  const anas = await say(ana, "How warm should the kitchen be?", "Ana Lopes");
  await say(ben, "Around 24 degrees works for me.", undefined, anas.id);
  await say(ana, "Thanks, Ben!", undefined, bens.id);
  is("Ana's comments and the answer under hers take room", (await used()) > withBen, true);
  is("her two comments and the answer under her own go", await forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM), 3);
  is("exactly that room given back", await used(), withBen);
  is("Ben's own comment is kept", (await lessonComments(COURSE, L1)).map((c) => c.id), [bens.id]);
  is("a second deletion gives back nothing", [await forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM), await used()], [0, withBen]);

  part("Without a room nothing is counted, and nothing breaks");
  is("Ben deleted", await forgetLessonCommentsPerson(COURSE, [L1], ben), 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
