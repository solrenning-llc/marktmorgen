/**
 * j-mail-3 (Claude 3 cloud J, email audit): the email telling a student the creator answered takes the lesson's
 * one-an-hour mark before it is sent (lib/lesson-comment-notify.ts). When the sender refuses it for certain (nothing
 * went), the mark must be let go: kept, it silences this answer and every other answer on that lesson for an hour,
 * and the student never hears of any of them. A send whose answer is not known keeps the mark (never twice).
 */
import { addComment } from "@/lib/lesson-comments";
import { tellStudent } from "@/lib/lesson-comment-notify";
import { CREATOR_AUTHOR } from "@/lib/lesson-comments-rules";
import { emailKey, touchStudent } from "@/lib/learn";
import { claimHandle, ensureStatsId, storeForEmail, type Listing } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is } from "./check";

async function main() {
  redis.clear();
  const originalFetch = globalThis.fetch;
  const saved = { resend: process.env.RESEND_API_KEY, role: process.env.AWS_SES_ROLE_ARN };
  let external = 0;
  globalThis.fetch = async () => { external++; throw Error("No external transport in this test"); };
  // No sender at all: a certain refusal, with nothing sent (lib/email.ts sendEmailOutcome).
  delete process.env.RESEND_API_KEY;
  delete process.env.AWS_SES_ROLE_ARN;
  try {
    const owner = "refused-owner@example.com", student = "refused-student@example.com", course = "d".repeat(32), lesson = "lessonone002";
    await claimHandle(owner, "refusedproof", "Refused proof", "");
    await ensureStatsId(owner);
    const store = (await storeForEmail(owner))!;
    await touchStudent(course, student, 100, ROOM);
    const by = emailKey(student);
    const parent = await addComment({ room: ROOM, courseId: course, lessonId: lesson, by, name: "Student fixture", text: "A question", now: 100 });
    if (!parent.ok) throw Error("Synthetic question was not stored");
    const reply = await addComment({ room: ROOM, courseId: course, lessonId: lesson, by: CREATOR_AUTHOR, text: "A stored answer", parent: parent.comment.id, now: 101 });
    if (!reply.ok) throw Error("Synthetic answer was not stored");
    const sent = await tellStudent({ store, product: { id: "product002", title: "Course fixture" } as Listing, courseId: course, lessonTitle: "Lesson fixture", parent: parent.comment, reply: reply.comment, origin: "https://course.test" });
    is("a refused notice is not reported sent", sent, false);
    is("its hourly mark is let go, so the next answer can still tell the student", redis.run(["EXISTS", `nl:lc:${course}:mail:${by}:${lesson}`]), 0);
    is("no external provider was contacted", external, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (saved.resend !== undefined) process.env.RESEND_API_KEY = saved.resend;
    if (saved.role !== undefined) process.env.AWS_SES_ROLE_ARN = saved.role;
  }
  done();
}
void main();
