/**
 * The questions someone starting out asks about courses (534 [FQ1], unit 2,
 * lib/course-faq.ts; added 1 November 2026). Checked: each answer's words
 * are the studio's own, read from the files they come from; the structures
 * are the code's list; the trial answer follows PLANS_ON_SALE and says what
 * a course without a plan can and cannot do, with the code's video hours;
 * no number of students or sales, no time promise; the courses page shows
 * them first in its own "Questions" block, with no question asked twice.
 */
import { readFileSync } from "node:fs";
import { COURSE_STUDIO_WORDS, STUDENT_COUNTS, courseBeginnerQuestions } from "@/lib/course-faq";
import { COURSE_TEMPLATES } from "@/lib/course-templates";
import { TRIAL_DAYS } from "@/lib/plan";
import { AUTOMATIC_UPLOAD_CAPS, uploadAllowanceWords } from "@/lib/upload-budget-policy";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");

part("The studio's own words");
is("the button that makes a product a course, which goes straight to the course's page", [read("components/course-toggle.tsx").includes(COURSE_STUDIO_WORDS.make), read("components/course-toggle.tsx").includes("router.push(studioHref(`/studio/course/${product.id}`))")], [true, true]);
is("the button shows only on a paid product with no file, link or price options", read("components/course-toggle.tsx").includes("product.priceCents > 0 && product.options.length === 0 && !product.file && !product.link && !product.call"), true);
is("the ready structures' heading and buttons", [read("components/course-template-picker.tsx").includes(COURSE_STUDIO_WORDS.structures), read("components/course-template-picker.tsx").includes(COURSE_STUDIO_WORDS.use), read("components/course-template-picker.tsx").includes(`"${COURSE_STUDIO_WORDS.scratch}"`)], [true, true, true]);
is("the Students section's own counts", STUDENT_COUNTS.every((w) => read("app/studio/course/[product]/page.tsx").includes(`>${w}<`)), true);
is("what a lesson holds, as the course page in the studio says it", read("app/studio/course/[product]/page.tsx").includes("A lesson can have a video, text, downloads, a link, and a quiz or an assignment"), true);
is("how buyers open it, as the product's course line says it", read("components/course-toggle.tsx").includes("Buyers open it with their email address, on any device, with no password."), true);

part("The answers");
const now = courseBeginnerQuestions(false);
const later = courseBeginnerQuestions(true, TRIAL_DAYS);
const answer = (list: { q: string; a: string }[], q: string) => list.find((x) => x.q === q)?.a ?? "";
is("four questions", now.map((x) => x.q), ["What is a course here?", "How do I start one?", "Can I try it before paying?", "Do courses work?"]);
is("the structures named from the code's own list, scratch by its own name", [answer(now, "How do I start one?").includes(COURSE_TEMPLATES.filter((t) => t.id !== "scratch").map((t) => t.name).join(", ")), answer(now, "How do I start one?").includes(`“${COURSE_STUDIO_WORDS.scratch}”`)], [true, true]);
is("never a step the studio does not take next", /then “?Add lessons/.test(answer(now, "How do I start one?")), false);
const before = answer(now, "Can I try it before paying?");
is("before plans are on sale: no card, and only what a store without a plan can do", [before.includes("no card"), before.includes("you can set up a course with its modules and the text of its lessons in your own store's studio with no card.")], [true, true]);
is("uploads said as the upload policy has them: none before a paid plan", [AUTOMATIC_UPLOAD_CAPS.setup.opens, before.includes("Files and lesson videos can be uploaded once a paid plan starts."), uploadAllowanceWords("setup", null).length > 0], [0, true, true]);
is("no promise of files or videos played before a plan", /videos play|upload (a|your) (file|video)s? (now|today)/i.test(before), false);
const trial = answer(later, "Can I try it before paying?");
is("once they are: the trial's days, charged only when it ends, and what the trial leaves out", [trial.includes(`${TRIAL_DAYS}-day trial`), trial.includes("first charged when it ends"), trial.includes("leaves out paid AI writing"), AUTOMATIC_UPLOAD_CAPS.trial.opens === 0 ? trial.includes("Files and lesson videos can be uploaded once a paid plan starts.") : true], [true, true, true, true]);
is("the start date for everyone is said too", answer(now, "What is a course here?").includes("or after a start date you set for everyone"), true);
is("the live demo it points to is at the end of every feature page", read("components/topic-page.tsx").includes('<Link href="/demo" className="link-arrow">'), true);
is("does it work: no figure, the creator's own counts", [answer(now, "Do courses work?").startsWith("We publish no number of students or sales"), answer(now, "Do courses work?").includes("who opened it, who finished a lesson, and who finished it all"), answer(now, "Do courses work?").includes("how many lessons they marked done"), read("app/studio/course/[product]/page.tsx").includes("with how many lessons they marked done")], [true, true, true, true]);
const all = [...now, ...later].map((x) => x.a).join(" ");
is("no number of buyers or students, no percent, no result promised", /\b\d{2,}\s+(students|buyers|creators|sales)|%|guarantee|proven|results?\b/i.test(all), false);

part("On the courses page");
const page = findPage("platform", "courses");
const faq = (page?.blocks ?? []).find((b) => (b as { kind?: string }).kind === "faq") as { title: string; items: { q: string }[] } | undefined;
is("first in its own Questions block", [faq?.title, faq?.items.slice(0, 4).map((x) => x.q)], ["Questions about courses", now.map((x) => x.q)]);
is("no question asked twice on the page", new Set(faq?.items.map((x) => x.q)).size, faq?.items.length);
done();
