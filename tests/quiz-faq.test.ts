/**
 * The questions someone starting out asks about quizzes and certificates
 * (534 [FQ1], unit 13, lib/quiz-faq.ts; added 2 November 2026). Checked: the
 * quiz editor's and the course editor's own words, read from their files;
 * the most questions; the certificate page read from the record and saying
 * when it was withdrawn; the shared trial answer in both states; no figure;
 * first in the page's own Questions block, no question asked twice.
 */
import { readFileSync } from "node:fs";
import { QUIZ_WORDS, quizBeginnerQuestions } from "@/lib/quiz-faq";
import { tryBeforePaying } from "@/lib/beginner-faq";
import { MAX_QUESTIONS } from "@/lib/quiz";
import { TRIAL_DAYS } from "@/lib/plan";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";

part("The studio's own words");
const quiz = flat(read("components/quiz-editor.tsx"));
const course = flat(read("components/course-editor.tsx"));
is("the course toggle and the lesson button", [read("components/course-toggle.tsx").includes(QUIZ_WORDS.course), course.includes(`"${QUIZ_WORDS.lesson}"`)], [true, true]);
is("the quiz editor is not drawn on a lesson with an assignment", /lesson\.task \? null : <QuizEditor/.test(course), true);
is("an assignment's review is a switch, so it is read only when chosen", flat(read("components/task-editor.tsx")).includes("I read and approve each one."), true);
is("a certificate needs every lesson done and every required quiz passed", flat(read("lib/certificate.ts")).includes("requiredQuizLessons(course).every((id) => passed.has(id))"), true);
is("the quiz editor's button, field labels and save", [QUIZ_WORDS.add, QUIZ_WORDS.question, QUIZ_WORDS.pass, QUIZ_WORDS.tries, QUIZ_WORDS.save].every((w) => quiz.includes(w)), true);
is("the course editor's certificate box", course.includes(QUIZ_WORDS.certificate), true);
is("the most questions in a quiz, as the page writes it by hand", JSON.stringify(findPage("platform", "quizzes-and-certificates")).includes(`Up to ${MAX_QUESTIONS} questions`), true);
is("tries are 1 to 10 on a new quiz, as the page now says", [/export const MAX_ATTEMPTS = 10;/.test(read("lib/quiz.ts")), JSON.stringify(findPage("platform", "quizzes-and-certificates")).includes("how many tries (1 to 10)")], [true, true]);
const cert = flat(read("app/[handle]/certificate/[id]/page.tsx"));
is("a certificate's page is read from the record by its id, and says when it was withdrawn", [cert.includes("readCertificate"), cert.includes("CERT_ID_PATTERN"), /withdrawnAt\s*>\s*0/.test(cert)], [true, true, true]);

part("The answers");
const now = quizBeginnerQuestions(false);
const later = quizBeginnerQuestions(true, TRIAL_DAYS);
is("four questions", now.map((x) => x.q), ["What are quizzes and certificates here?", "How do I start one?", "Can I try it before paying?", "How many people use quizzes and certificates?"]);
is("the most questions from the code", answer(now, "What are quizzes and certificates here?").includes(`up to ${MAX_QUESTIONS} multiple-choice questions`), true);
is("start: the editors' own words, in order", (() => { const a = answer(now, "How do I start one?"); const at = Object.values(QUIZ_WORDS).map((w) => a.indexOf(`“${w}”`)); return at.every((x, k) => x >= 0 && (k === 0 || x > at[k - 1])); })(), true);
is("try before paying: the one shared answer, in quizzes' words", [answer(now, "Can I try it before paying?"), answer(later, "Can I try it before paying?")], [tryBeforePaying("Quizzes and certificates", "a course's quizzes and its certificate", false), tryBeforePaying("Quizzes and certificates", "a course's quizzes and its certificate", true, TRIAL_DAYS)]);
is("how many: no figure, and the check of a certificate left to the answer already on the page", [answer(now, "How many people use quizzes and certificates?").startsWith("We publish no number"), JSON.stringify(findPage("platform", "quizzes-and-certificates")).includes("Can a certificate be faked by editing a link?")], [true, true]);
is("an assignment said to be read only when the creator chooses", [/which you can read and approve/.test(answer(now, "What are quizzes and certificates here?")), /hand in and you read/.test(answer(now, "What are quizzes and certificates here?"))], [true, false]);
is("one space between sentences, never two", /\s{2}/.test([...now, ...later].map((x) => x.a).join(" ")), false);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of students or certificates, no percent figure, no result promised", /\b\d+\s+(students|certificates|creators|sales)|\d+%|guarantee|proven|results?\b/i.test(all), false);

part("On the quizzes page");
const faq = (findPage("platform", "quizzes-and-certificates")?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in the page's own Questions block", faq?.items.slice(0, 4).map((x) => x.q), now.map((x) => x.q));
is("no question asked twice", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);

done();
