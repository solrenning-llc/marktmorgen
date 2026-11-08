/**
 * Comments under lessons: who sees what, what is kept, and who is told.
 *
 * Measured before it was built (30 September 2026): Kajabi, Teachable and
 * Thinkific let students comment under a lesson; a course sold on Stan is a
 * list of lessons with nowhere to ask a question. What is checked:
 *
 *   - a student chooses a name once, and it is shown instead of their address;
 *   - answers are one level deep, under a comment of the same lesson;
 *   - a hidden comment is seen only by the creator and whoever wrote it;
 *   - deleting a comment takes its answers, and deleting a lesson its comments;
 *   - the studio counts what is new since it last looked;
 *   - a student is emailed when the creator answers them, not when another
 *     student does, and not twice in an hour for one lesson.
 */
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { emailKey, touchStudent } from "@/lib/learn";
import {
  addComment,
  commentsOn,
  deleteComment,
  dropLessonComments,
  freshCounts,
  lessonComments,
  markSeen,
  recentComments,
  setCommentsOn,
  setHidden,
} from "@/lib/lesson-comments";
import { CREATOR_AUTHOR, threadsFor } from "@/lib/lesson-comments-rules";
import { tellStudent } from "@/lib/lesson-comment-notify";
import type { Listing } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Sent = { to: string[]; subject: string; text: string };
const emails: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const COURSE = "c".repeat(32);
const L1 = "lessonone001";
const L2 = "lessontwo002";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_lesson_comments_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = { id: "p1aaaaaa", title: "Sourdough for Beginners" } as Listing;
  const dana = emailKey("dana@example.com");
  const hal = emailKey("hal@example.com");
  await touchStudent(COURSE, "Dana@Example.com", 1_000, ROOM);
  await touchStudent(COURSE, "hal@example.com", 1_000, ROOM);

  part("On until the creator says otherwise");
  is("on for a new course", await commentsOn(COURSE), true);
  await setCommentsOn(COURSE, false);
  is("off when switched off", await commentsOn(COURSE), false);
  await setCommentsOn(COURSE, true);

  part("A name, chosen once");
  const nameless = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: dana, text: "How warm should the kitchen be?" });
  is("without a name nothing is written", nameless.ok ? "written" : nameless.reason, "name");
  const first = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: dana, text: "How warm should the kitchen be?", name: "  Dana  ", now: 100 });
  if (!first.ok) throw new Error("no comment");
  is("the name is kept, trimmed", first.comment.name, "Dana");
  const second = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: dana, text: "And the flour?", now: 110 });
  is("and used next time without asking", second.ok && second.comment.name, "Dana");
  is("no address anywhere in what is kept", JSON.stringify(await lessonComments(COURSE, L1)).includes("example.com"), false);
  const empty = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: dana, text: " \n\n " });
  is("nothing written is refused", empty.ok ? "written" : empty.reason, "empty");

  part("Answers");
  const answer = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: CREATOR_AUTHOR, text: "75 to 80°F.", parent: first.comment.id, now: 120 });
  if (!answer.ok) throw new Error("no answer");
  is("the creator needs no name", answer.comment.name, "");
  is("the answer knows its comment", answer.parent?.id, first.comment.id);
  const deeper = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: hal, name: "Hal", text: "Same question", parent: answer.comment.id });
  is("an answer to an answer is refused: one level", deeper.ok ? "written" : deeper.reason, "parent");
  const elsewhere = await addComment({ room: ROOM, courseId: COURSE, lessonId: L2, by: hal, name: "Hal", text: "x", parent: first.comment.id });
  is("an answer from another lesson is refused", elsewhere.ok ? "written" : elsewhere.reason, "parent");
  const halsAnswer = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: hal, name: "Hal", text: "Mine sits by the oven.", parent: first.comment.id, now: 130 });
  if (!halsAnswer.ok) throw new Error("no answer");

  part("Threads, as each reader sees them");
  const forHal = threadsFor(await lessonComments(COURSE, L1), hal);
  is("newest thread first", forHal.map((t) => t.comment.text), ["And the flour?", "How warm should the kitchen be?"]);
  is("answers in the order written", forHal[1].replies.map((r) => r.text), ["75 to 80°F.", "Mine sits by the oven."]);
  await setHidden(COURSE, first.comment.id, true);
  const all = await lessonComments(COURSE, L1);
  is("hidden: another student no longer sees it, nor its answers", threadsFor(all, hal).map((t) => t.comment.text), ["And the flour?"]);
  is("whoever wrote it still does", threadsFor(all, dana).length, 2);
  is("and so does the creator", threadsFor(all, CREATOR_AUTHOR).length, 2);
  await setHidden(COURSE, first.comment.id, false);

  part("Who is emailed");
  const base = { store, product, courseId: COURSE, lessonTitle: "Your starter", origin: "https://marktmorgen.com" };
  // CX-123 rule 24, L9: the once-an-hour mark answered oddly, without landing, sends nothing.
  {
    const real = redis.pipeline.bind(redis);
    let used = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!used && commands[0]?.[0] === "SET" && String(commands[0]?.[1] ?? "").startsWith(`nl:lc:${COURSE}:mail:`)) {
        used = true;
        return ["QUEUED"];
      }
      return real(commands);
    }) as typeof redis.pipeline;
    try {
      is("a mark answered oddly that did not land sends nothing", [await tellStudent({ ...base, parent: first.comment, reply: answer.comment }), emails.length], [false, 0]);
    } finally {
      redis.pipeline = real;
    }
  }
  const sent = await tellStudent({ ...base, parent: first.comment, reply: answer.comment });
  is("the student the creator answered", [sent, emails.length, emails[0]?.to], [true, 1, ["dana@example.com"]]);
  is("with the answer and the way back to it", emails[0]?.text.includes("75 to 80°F.") && emails[0]?.text.includes(`/@harbor/course/p1aaaaaa/${L1}#c-${answer.comment.id}`), true);
  is("from the store, via Marktmorgen", emails[0] && (emails[0] as unknown as { from: string }).from.startsWith('"Harbor Kitchen via Marktmorgen"'), true);
  is("not twice in an hour for the same lesson", await tellStudent({ ...base, parent: first.comment, reply: answer.comment }), false);
  is("not when another student answers", await tellStudent({ ...base, parent: first.comment, reply: halsAnswer.comment }), false);
  is("and so still one email", emails.length, 1);

  part("Deleting");
  is("a comment goes with its answers", await deleteComment(COURSE, first.comment.id, ROOM), 3);
  is("what is left", (await lessonComments(COURSE, L1)).map((c) => c.text), ["And the flour?"]);
  const onL2 = await addComment({ room: ROOM, courseId: COURSE, lessonId: L2, by: hal, text: "Scoring tips?", now: 200 });
  is("a second lesson", onL2.ok, true);
  await dropLessonComments(COURSE, [L2], ROOM);
  is("a lesson deleted takes its comments", (await lessonComments(COURSE, L2)).length, 0);

  part("The studio");
  await markSeen(COURSE, 150);
  await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: hal, text: "Rye instead?", now: 300 });
  const recent = await recentComments(COURSE);
  is("the newest comments of the course", recent.comments.map((c) => c.text), ["Rye instead?", "And the flour?"]);
  is("and how many came since it last looked", recent.fresh, 1);
  is("counted for the list of courses too", (await freshCounts([COURSE])).get(COURSE), 1);
  await markSeen(COURSE, 400);
  is("none once seen", (await recentComments(COURSE)).fresh, 0);

  done();
}

void main();
