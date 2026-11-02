/**
 * The questions someone starting out asks about courses (534 [FQ1], unit 2,
 * added 1 November 2026), answered only by what the code does today, read
 * from its own sources: the studio's own buttons (components/course-toggle.tsx
 * and components/course-template-picker.tsx), the ready structures
 * (lib/course-templates.ts), the Students section of a course's studio page
 * (app/studio/course/[product]/page.tsx), whether paid plans are on sale
 * (lib/opening.ts), the trial's length (lib/plan.ts) and what a store not
 * paying for a plan may upload (lib/upload-budget-policy.ts).
 *
 * The same four questions as the funnels page asks where they fit a course,
 * with the same answer to "Can I try it before paying?" in a course's own
 * terms; no number of students or sales, no time promise. Shown on the
 * courses page in its "Questions" block, so the page and its FAQPage data
 * are one text (components/topic-page.tsx).
 */
import { COURSE_TEMPLATES } from "@/lib/course-templates";
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The studio's own words, in the order a course is made. */
export const COURSE_STUDIO_WORDS = {
  make: "Sell this as a course with lessons",
  structures: "Start from a ready structure",
  use: "Use this structure",
  scratch: "Start from scratch",
} as const;
/** The Students section's own counts (app/studio/course/[product]/page.tsx). */
export const STUDENT_COUNTS = ["opened it", "finished a lesson", "finished it all"] as const;

export function courseBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const structures = COURSE_TEMPLATES.filter((t) => t.id !== "scratch").map((t) => t.name);
  return [
    {
      q: "What is a course here?",
      a: "Lessons in modules, sold as one product. A lesson can have a video, text, downloads, a link, and a quiz or an assignment, and a module can open a number of days after each student joins, or after a start date you set for everyone. Buyers open it with their email address, on any device, with no password.",
    },
    {
      q: "How do I start one?",
      a: `In your studio, on a paid product with no file, link or price options of its own, press “${COURSE_STUDIO_WORDS.make}”: the course's page opens, with “${COURSE_STUDIO_WORDS.structures}”: ${structures.join(", ")}. Pick one to see what it adds and press “${COURSE_STUDIO_WORDS.use}”, or pick “${COURSE_STUDIO_WORDS.scratch}” and add the modules yourself.`,
    },
    {
      q: "Can I try it before paying?",
      a: tryBeforePaying("A course", "a course with its modules and the text of its lessons", onSale, trialDays),
    },
    {
      q: "Do courses work?",
      a: `We publish no number of students or sales, because we do not have a real, checked count to show. Your own course tells you how it goes: its Students section counts who ${STUDENT_COUNTS.join(", who ").replace(/, who (finished it all)$/, ", and who $1")}, and lists each student with how many lessons they marked done.`,
    },
  ];
}
