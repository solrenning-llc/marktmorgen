/**
 * Who hears about an assignment (lib/assignment.ts), and how.
 *
 *   - The creator, by email, when a student hands in work for them to read:
 *     once an hour per course at most, however many come in, with the way to
 *     the studio. Nothing about what was handed in: they read it there.
 *   - The student, by email, when the creator approves their work or asks
 *     for another try: what the creator wrote, in the store's language, and
 *     the way back to the lesson. Sent from the store's name, as every
 *     course email is (lib/learn.ts, courseSender).
 */
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { courseSender } from "@/lib/learn";
import { tellCreatorNow } from "@/lib/assignment";
import type { Submission } from "@/lib/assignment-rules";
import type { Listing, Store } from "@/lib/store";
import { SITE_URL } from "@/lib/site-url";
import { coursesWords } from "@/lib/buyer-words/courses";

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Tells the creator there is work to read. Returns whether an email went. */
export async function tellCreatorOfWork(input: { store: Store; product: Listing; courseId: string; lessonTitle: string; origin: string }): Promise<boolean> {
  // The studio lives on this site, as in every other studio email: never the
  // host of the student's request, which can be another creator's domain.
  const { store, product, courseId, lessonTitle } = input;
  if (!(await tellCreatorNow(courseId))) return false;
  const page = `${SITE_URL}/studio/course/${product.id}${store.sid ? `?store=${store.sid}` : ""}#work`;
  return sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: `Work to read in ${excerpt(product.title, 80)}`,
    text: [
      `A student handed in their work on “${excerpt(lessonTitle, 100)}”, in ${excerpt(product.title, 100)}.`,
      "",
      "Read it, write back, and approve it or ask for another try, in your studio:",
      page,
      "",
      "What you write reaches the student by email. If more work comes in within the hour, it waits in the same list without another email.",
    ].join("\n"),
  });
}

/** Emails the student what the creator made of their work. Returns whether an email went. */
export async function tellStudentOfReview(input: {
  store: Store;
  product: Listing;
  lessonId: string;
  lessonTitle: string;
  to: string;
  submission: Submission;
  origin: string;
}): Promise<boolean> {
  const { store, product, lessonId, lessonTitle, to, submission, origin } = input;
  if (submission.state === "waiting") return false;
  const w = coursesWords(store.language);
  const link = `${origin}/@${store.handle}/course/${product.id}/${lessonId}#task`;
  const lead = submission.state === "approved" ? w.taskMailApproved(store.name, lessonTitle, product.title) : w.taskMailAgain(store.name, lessonTitle, product.title);
  return sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: courseSender(store),
    to,
    subject: w.taskMailSubject(excerpt(lessonTitle, 120)).slice(0, 200),
    text: [
      lead,
      ...(submission.feedback ? ["", w.taskMailWrote(store.name), "", submission.feedback] : []),
      "",
      w.taskMailOpen,
      link,
      "",
      w.sentBy(store.name),
    ].join("\n"),
  });
}
