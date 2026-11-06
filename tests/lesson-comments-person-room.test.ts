/**
 * Deleting a person (lib/person-erasure.ts) takes their lesson comments, the
 * answers under their own comments and the name they chose out of a course,
 * and gives back to the store's data room what those took, as the other
 * deletions of comments do (lib/lesson-comments.ts), once: also when an
 * erasure, a comment's deletion and a lesson's deletion run at the same time,
 * and at the room it was charged when the creator hid it.
 */
import { addComment, deleteComment, dropLessonComments, forgetLessonCommentsPerson, lessonComments, readComment, setHidden } from "@/lib/lesson-comments";
import { emailKey } from "@/lib/learn";
import { redisPipeline } from "@/lib/redis";
import { dataUsed } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
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

  // Runs `meanwhile` once, just before the first pipeline that `when` picks.
  const between = (when: (commands: (string | number)[][]) => boolean, meanwhile: () => Promise<unknown>) => {
    const original = redis.pipeline;
    let ran = false;
    redis.pipeline = async (commands) => {
      if (!ran && when(commands)) {
        ran = true;
        redis.pipeline = original;
        await meanwhile();
      }
      return original.call(redis, commands);
    };
    return { ran: () => ran, undo: () => { redis.pipeline = original; } };
  };
  const takes = (commands: (string | number)[][]) => commands[0]?.[0] === "EVAL" && [
    "-- marktmorgen:lesson-comments-take:",
    "-- marktmorgen:lesson-comment-thread-delete:",
  ].some((mark) => String(commands[0][1]).startsWith(mark));

  part("An erasure between a comment's deletion reading it and taking it out: given back once");
  redis.clear();
  await say(ben, "Where are the slides?", "Ben");
  const onlyBen = await used();
  const raced = await say(ana, "How warm should the kitchen be?", "Ana");
  await say(ben, "Around 24 degrees.", undefined, raced.id);
  const race1 = between(takes, () => forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM));
  is("the deletion finds nothing left to take", await deleteComment(COURSE, raced.id, ROOM), 0);
  race1.undo();
  is("the erasure did run in between", race1.ran(), true);
  is("the room is Ben's alone, not given back twice", await used(), onlyBen);

  part("Two deletions of one comment at once: given back once");
  redis.clear();
  await say(ben, "Where are the slides?", "Ben");
  const benAgain = await used();
  const twice = await say(ana, "And the flour?", "Ana");
  const answer = await say(ben, "Bread flour.", undefined, twice.id);
  const afterAnswer = await used();
  is("both say what they took, together the comment and its answer once", (await Promise.all([deleteComment(COURSE, twice.id, ROOM), deleteComment(COURSE, twice.id, ROOM)])).sort(), [0, 2]);
  is("the thread took room", afterAnswer > benAgain, true);
  is("its room given back once, Ana's name still counted", await used(), benAgain + dataBytes([ana, "Ana"], 1));
  is("nothing of them is kept", [await readComment(COURSE, twice.id), await readComment(COURSE, answer.id)], [null, null]);

  part("A lesson's deletion racing an erasure: given back once");
  const lesson = async () => {
    redis.clear();
    await say(ben, "Where are the slides?", "Ben");
    const withBen = await used();
    await say(ana, "One", "Ana");
    await say(ana, "Two");
    return withBen;
  };
  await lesson();
  await forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM);
  await dropLessonComments(COURSE, [L1], ROOM);
  const oneAfterTheOther = await used();
  const withBenThere = await lesson();
  is("one after the other, every comment's room goes back, Ben's name stays", oneAfterTheOther > 0 && oneAfterTheOther < withBenThere, true);
  const race2 = between(takes, () => forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM));
  await dropLessonComments(COURSE, [L1], ROOM);
  race2.undo();
  is("the erasure did run in between", race2.ran(), true);
  is("at once, the same room: nothing given back twice", await used(), oneAfterTheOther);

  part("A hidden comment gives back what it was charged, not more");
  redis.clear();
  await say(ben, "Where are the slides?", "Ben");
  const beforeHidden = await used();
  const hid = await say(ana, "x", "Ana");
  is("hidden", (await setHidden(COURSE, hid.id, true))?.hidden, true);
  await forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM);
  is("erasure: exactly the room it took", await used(), beforeHidden);
  const hid2 = await say(ana, "y", "Ana");
  await setHidden(COURSE, hid2.id, true);
  await deleteComment(COURSE, hid2.id, ROOM);
  is("deletion: exactly the room it took, the name still counted", await used(), beforeHidden + dataBytes([ana, "Ana"], 1));

  part("Hiding a comment deleted meanwhile never writes it back");
  redis.clear();
  const gone = await say(ana, "Hide me", "Ana");
  const race3 = between((commands) => commands[0]?.[0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:lesson-comments-hide:"), () => forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM));
  is("nothing hidden: it is gone", await setHidden(COURSE, gone.id, true), null);
  race3.undo();
  is("the erasure did run in between", race3.ran(), true);
  is("and it stays gone", await readComment(COURSE, gone.id), null);

  part("An answer written while its comment's author is erased: nothing of it is kept");
  const adds = (commands: (string | number)[][]) => commands[0]?.[0] === "EVAL" && [
    "-- marktmorgen:lesson-comments-add:",
    "-- marktmorgen:lesson-comment-reply:",
  ].some((mark) => String(commands[0][1]).startsWith(mark));
  for (const [who, replier] of [["Ana herself", ana], ["Ben", ben]] as const) {
    redis.clear();
    const bens = await say(ben, "Where are the slides?", "Ben");
    const onlyBen = await used();
    const top = await say(ana, "How warm should the kitchen be?", "Ana");
    const race = between(adds, () => forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM));
    const made = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: replier, text: "Around 24 degrees.", parent: top.id });
    race.undo();
    is(`${who}: the erasure did run in between`, race.ran(), true);
    is(`${who}: the answer is refused, its comment is gone`, made.ok ? "written" : made.reason, "parent");
    is(`${who}: only Ben's comment is kept or listed`, (await lessonComments(COURSE, L1)).map((c) => c.id), [bens.id]);
    const [kept, newest, count] = await redisPipeline([
      ["HLEN", `nl:lc:${COURSE}:c`],
      ["ZCARD", `nl:lc:${COURSE}:all`],
      ["HGET", `nl:lc:${COURSE}:r`, top.id],
    ]);
    is(`${who}: nothing orphaned, no count for the gone comment`, [kept, newest, count], [1, 1, null]);
    is(`${who}: the room is Ben's alone, the answer's charge given back`, await used(), onlyBen);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
