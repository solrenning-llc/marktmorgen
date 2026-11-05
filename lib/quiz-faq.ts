/**
 * The questions someone starting out asks about quizzes and certificates
 * (534 [FQ1], unit 13, added 2 November 2026), answered only by what the
 * code does today: the quiz editor's own words (components/quiz-editor.tsx),
 * the most questions (lib/quiz.ts, MAX_QUESTIONS), the course toggle and the
 * course editor's lesson button and certificate box
 * (components/course-toggle.tsx, components/course-editor.tsx), the review
 * switch of an assignment (components/task-editor.tsx), the certificate's page,
 * read from our record (app/[handle]/certificate/[id]), and the shared answer
 * to "Can I try quizzes and certificates before paying?" (lib/beginner-faq.ts). No number of
 * students or certificates. Shown first in the page's own "Questions" block.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { MAX_QUESTIONS } from "@/lib/quiz";
import { tryBeforePaying } from "@/lib/beginner-faq";

/** The quiz editor's and the course editor's own words. */
export const QUIZ_WORDS = { course: "Sell this as a course with lessons", lesson: "Edit lesson", add: "Add a quiz", question: "Add a question", pass: "Pass mark (%)", tries: "Tries allowed", save: "Save the quiz", certificate: "Give a certificate to every student who finishes" } as const;

export function quizBeginnerQuestions(onSale = PLANS_ON_SALE, trialDays = TRIAL_DAYS): { q: string; a: string }[] {
  const w = QUIZ_WORDS;
  return [
    {
      q: "What are quizzes and certificates here?",
      a: `A quiz at the end of a lesson of a course, up to ${MAX_QUESTIONS} multiple-choice questions marked on our side, or an assignment students hand in, which you can read and approve before the lesson counts as done. With certificates on, a student who finishes every lesson and passes every quiz that has to be passed types their name and gets a certificate, with a page of its own that anyone can open to check it.`,
    },
    {
      q: "How do I add a quiz and a certificate?",
      a: `In your studio, on a product with a price, press “${w.course}”. On a lesson with no assignment, press “${w.lesson}”, then “${w.add}”. Write each question, type its answers and check the right one; add more with “${w.question}”, set “${w.pass}” and “${w.tries}”, and press “${w.save}”. For certificates, check “${w.certificate}” on the course.`,
    },
    {
      q: "Can I try quizzes and certificates before paying?",
      a: tryBeforePaying("Quizzes and certificates", "a course's quizzes and its certificate", onSale, trialDays),
    },
    {
      q: "How many people use quizzes and certificates?",
      a: "We publish no number of students or certificates, because we do not have a real, checked count to show. How anyone can check a certificate is answered below.",
    },
  ];
}
