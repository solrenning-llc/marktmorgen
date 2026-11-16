import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CourseCommentsStudio, type StudioComment } from "@/components/course-comments-studio";
import { addComment, readComment } from "@/lib/lesson-comments";
import { tellStudent } from "@/lib/lesson-comment-notify";
import { CREATOR_AUTHOR } from "@/lib/lesson-comments-rules";
import { emailKey, studentEmail, touchStudent } from "@/lib/learn";
import { claimHandle, ensureStatsId, storeForEmail, type Listing } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is } from "./check";

async function main() {
  redis.clear();
  const originalFetch = globalThis.fetch;
  let external = 0;
  globalThis.fetch = async () => { external++; throw Error("No external transport in this test"); };
  try {
    const owner = "reply-owner@example.com", student = "student@example.com", course = "c".repeat(32), lesson = "lessonone001";
    await claimHandle(owner, "replyproof", "Reply proof", "");
    await ensureStatsId(owner);
    const store = (await storeForEmail(owner))!;
    await touchStudent(course, student, 100, ROOM);
    const by = emailKey(student);
    const parent = await addComment({ room: ROOM, courseId: course, lessonId: lesson, by, name: "Student fixture", text: "A question", now: 100 });
    if (!parent.ok) throw Error("Synthetic question was not stored");
    const reply = await addComment({ room: ROOM, courseId: course, lessonId: lesson, by: CREATOR_AUTHOR, text: "A stored answer", parent: parent.comment.id, now: 101 });
    if (!reply.ok) throw Error("Synthetic answer was not stored");
    is("the real notification reader knows the student's address", await studentEmail(course, by), student);
    await redis.pipeline([["SET", `nl:lc:${course}:mail:${by}:${lesson}`, "1", "EX", 3600]]);
    const sent = await tellStudent({ store, product: { id: "product001", title: "Course fixture" } as Listing, courseId: course, lessonTitle: "Lesson fixture", parent: parent.comment, reply: reply.comment, origin: "https://course.test" });
    is("an ordinary hourly notification pause sends no second email", sent, false);
    is("the answer is actually stored despite that paused notification", (await readComment(course, reply.comment.id))?.text, "A stored answer");
    const comment: StudioComment = { id: parent.comment.id, lessonId: lesson, lessonTitle: "Lesson fixture", name: "Student fixture", fromCreator: false, text: parent.comment.text, at: 100, hidden: false, answerTo: null, parentId: null, fresh: false };
    const html = renderToStaticMarkup(createElement(CourseCommentsStudio, { productId: "product001", storeName: store.name, initialOn: true, initial: [comment], lessonHref: "/@replyproof/course/product001", now: 200 }));
    const words = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    is("the actual introduction describes the answer's place and author", words.includes("Your answers appear under the lesson as Reply proof."), true);
    is("the introduction never promises a notification was delivered", /student gets an email/i.test(words), false);
    is("the ordinary answer composer remains available", words.includes("Post the answer"), true);
    is("no external provider was contacted", external, 0);
  } finally { globalThis.fetch = originalFetch; }
  done();
}
void main().catch(error => { console.error(error); process.exit(1); });
