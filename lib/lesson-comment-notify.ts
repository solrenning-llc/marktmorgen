/**
 * Who hears about a comment under a lesson.
 *
 *   - The creator's phone, when a device of theirs asked for course comments
 *     (lib/phone-alerts.ts): the lesson and the start of what was written,
 *     never who wrote it, as every notification on a lock screen. Never for
 *     the creator's own words.
 *   - The student, by email, when the creator answers a comment of theirs:
 *     one email per lesson in an hour at most, with the answer and the way
 *     back to the lesson. Nobody else's answer sends an email, so students
 *     writing to each other never fill an inbox.
 */
import { alertCreator } from "@/lib/phone-alerts";
import { claimMark } from "@/lib/claim-mark";
import { sendEmail } from "@/lib/email";
import { courseSender, studentEmail } from "@/lib/learn";
import { CREATOR_AUTHOR, type LessonComment } from "@/lib/lesson-comments-rules";
import type { Listing, Store } from "@/lib/store";
import { coursesWords } from "@/lib/buyer-words/courses";

const MAIL_GAP_SECONDS = 3_600;

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export async function tellCreator(store: Store, product: Listing, lessonTitle: string, comment: LessonComment): Promise<void> {
  if (comment.by === CREATOR_AUTHOR) return;
  const page = `/studio/course/${product.id}${store.sid ? `?store=${store.sid}` : ""}#comments`;
  await alertCreator(
    store,
    "comment",
    {
      title: `New comment: ${excerpt(product.title, 60)}`,
      body: `Under “${excerpt(lessonTitle, 60)}”: ${excerpt(comment.text, 120)}`,
      url: page,
    },
    { seed: comment.id, at: comment.at * 1000 },
  ).catch((error) => console.error("a comment notification failed", error));
}

/** Emails the student whose comment the creator answered. Returns whether an email went. */
export async function tellStudent(input: {
  store: Store;
  product: Listing;
  courseId: string;
  lessonTitle: string;
  parent: LessonComment;
  reply: LessonComment;
  origin: string;
}): Promise<boolean> {
  const { store, product, courseId, lessonTitle, parent, reply, origin } = input;
  if (reply.by !== CREATOR_AUTHOR || parent.by === CREATOR_AUTHOR) return false;
  const to = await studentEmail(courseId, parent.by);
  if (!to) return false;
  // One email a gap: ours only on OK or our own value read back (CX-123 rule 24, L9); anything else sends nothing.
  if ((await claimMark(`nl:lc:${courseId}:mail:${parent.by}:${parent.lesson}`, MAIL_GAP_SECONDS)) !== "ours") return false;
  const link = `${origin}/@${store.handle}/course/${product.id}/${parent.lesson}#c-${reply.id}`;
  // To the student, in the store's language (lib/buyer-words/courses.ts).
  const w = coursesWords(store.language);
  return sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: courseSender(store),
    to,
    subject: w.answeredSubject(store.name).slice(0, 200),
    text: [
      w.answeredLead(store.name, lessonTitle, product.title),
      "",
      excerpt(reply.text, 1_500),
      "",
      w.answeredRead,
      link,
      "",
      w.answeredWhy,
      "",
      w.sentBy(store.name),
    ].join("\n"),
  });
}
