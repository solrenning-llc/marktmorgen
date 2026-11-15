/**
 * An extension of tests/e2e/seed.ts for checking the studio's editors in a
 * browser: run it after seed.ts, against the same stand-in database. It adds
 * to the owner's store, through the same functions the studio's routes use:
 * a product with a course (two modules, three lessons) and a quiz on one
 * lesson; a funnel with one product page; a form with a question of every
 * kind; a quiz-style form with two results; the community switched on, open
 * to the course's buyers; a private podcast; and a buyer (student@example.com)
 * who holds the course and the podcast through an import, with a signed-in
 * session, so the course, its lessons, the quiz and the community can be seen
 * as a student. Synthetic data only.
 * Prints one JSON line: { podcast, studentSession, course, product, lesson, funnel, form, quizForm }.
 */
import { setProductPodcast, addProduct, setCommunity, setPastBuyers, setProductCourse, storeForEmail, ensureStatsId } from "@/lib/store";
import { openSession } from "@/lib/auth";
import { grantImported } from "@/lib/imported-purchases";
import { freshConfig, saveConfig } from "@/lib/community";
import { newPodcastId, savePodcast } from "@/lib/podcast";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { readQuiz, saveQuiz, setupOf } from "@/lib/quiz";
import { type FormDef, newFormId, parseForm } from "@/lib/forms";
import { writeForm } from "@/lib/form-store";
import { type PageFunnel, newFunnelId } from "@/lib/page-funnel";
import { readPageFunnels, writePageFunnel } from "@/lib/page-funnel-store";

const OWNER = "owner@example.com";

function must<T extends { ok: boolean }>(result: T, what: string): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`${what} was refused: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

async function main(): Promise<void> {
  const statsId = (await ensureStatsId(OWNER))?.statsId;
  if (!statsId) throw new Error("the store has no statsId");

  // A product with a course: it has no file or link, so a course can be its delivery.
  const made = must(await addProduct(OWNER, "Bread Basics Course", "Six short lessons from starter to loaf.", "39", null), "the course product");
  const product = made.product.id;
  let course = emptyCourse();
  must(await setProductCourse(OWNER, product, { id: course.id, lessons: 0 }), "the course");
  course = must(editCourse(course, { op: "module-add", title: "Getting started" }), "module 1").course;
  course = must(editCourse(course, { op: "module-add", title: "Your first loaf" }), "module 2").course;
  const [first, second] = course.modules;
  course = must(editCourse(course, { op: "lesson-add", moduleId: first.id, title: "What you need" }), "lesson 1").course;
  course = must(editCourse(course, { op: "lesson-add", moduleId: first.id, title: "Feeding a starter" }), "lesson 2").course;
  course = must(editCourse(course, { op: "lesson-add", moduleId: second.id, title: "Mixing and shaping" }), "lesson 3").course;
  const lessonId = course.modules[0].lessons[1].id;
  // Read the way the studio route reads what the quiz editor sends (app/api/store/course).
  const read = readQuiz({
    passPercent: 70,
    attempts: 3,
    required: false,
    questions: [
      { text: "How often do you feed a starter kept on the counter?", kind: "single", choices: ["Once a week", "Once or twice a day", "Never"], correct: [1], explanation: "On the counter it eats fast." },
      { text: "Which of these go into a starter?", kind: "multiple", choices: ["Flour", "Water", "Salt"], correct: [0, 1], explanation: "Salt slows the yeast." },
    ],
  });
  if (!read.ok) throw new Error(`the quiz was refused: ${JSON.stringify(read)}`);
  const quiz = read.quiz;
  const store = await storeForEmail(OWNER);
  if (!store) throw new Error("the owner's store is gone");
  await saveQuiz(course.id, lessonId, quiz, store);
  course = must(editCourse(course, { op: "quiz", lessonId, quiz: setupOf(quiz) }), "the quiz").course;
  await saveCourse(course, store);
  must(await setProductCourse(OWNER, product, { id: course.id, lessons: 3 }), "the lesson count");

  // A funnel of two product pages.
  const existing = await readPageFunnels(statsId);
  const funnel: PageFunnel = { id: newFunnelId(), name: "Bread launch", slug: "bread", steps: [{ kind: "product", id: product }], on: false, since: Math.floor(Date.now() / 1000) };
  await writePageFunnel(statsId, funnel, existing, store);

  // A form with one question of each kind, and a quiz-style form with two results.
  const now = Math.floor(Date.now() / 1000);
  const form = parseForm({
    id: newFormId(), name: "Class waitlist", button: "", doneHeading: "Thanks", doneBody: "We will write when a seat opens.", outcomes: [], offerList: true, updatedAt: now,
    fields: [
      { id: "f10000", type: "short", label: "Your name", required: true, options: [] },
      { id: "f20000", type: "email", label: "Your email", required: true, options: [] },
      { id: "f30000", type: "long", label: "What do you want to bake?", required: false, options: [] },
      { id: "f40000", type: "choice", label: "Which day suits you?", required: true, options: [{ id: "o10000", label: "Saturday", outcome: "" }, { id: "o20000", label: "Sunday", outcome: "" }] },
      { id: "f50000", type: "choices", label: "What do you have at home?", required: false, options: [{ id: "o30000", label: "A scale", outcome: "" }, { id: "o40000", label: "A Dutch oven", outcome: "" }] },
      { id: "f60000", type: "scale", label: "How sure are you with dough?", required: false, options: [] },
    ],
  });
  if (!form) throw new Error("the form did not parse");
  if (!(await writeForm(statsId, form))) throw new Error("the form was not written");
  const quizForm = parseForm({
    id: newFormId(), name: "Which bread first?", button: "", doneHeading: "", doneBody: "", offerList: false, updatedAt: now,
    outcomes: [
      { id: "r10000", title: "Start with a flatbread", body: "No oven needed.", product: "" },
      { id: "r20000", title: "Start with a sourdough loaf", body: "Worth the wait.", product },
    ],
    fields: [
      { id: "g10000", type: "choice", label: "How much time do you have?", required: true, options: [{ id: "a10000", label: "An hour", outcome: "r10000" }, { id: "a20000", label: "A weekend", outcome: "r20000" }] },
    ],
  });
  if (!quizForm) throw new Error("the quiz form did not parse");
  if (!(await writeForm(statsId, quizForm))) throw new Error("the quiz form was not written");

  // The community switched on, and a buyer who holds the course through an import (no Stripe needed), with a session.
  const on = await setCommunity(OWNER, true);
  if (!on?.community) throw new Error("the community was not switched on");
  // Its buyers of the course are let in.
  await saveConfig(on.community.id, { ...freshConfig(on.name), access: [product] });
  const STUDENT = "student@example.com";
  // A private podcast, with no episode yet, held by the same buyer.
  const cast = must(await addProduct(OWNER, "Bread Talk Podcast", "A private feed about bread, one episode a week.", "5", null), "the podcast product");
  const podcastId = newPodcastId();
  await savePodcast({ id: podcastId, episodes: [] });
  must(await setProductPodcast(OWNER, cast.product.id, { id: podcastId, episodes: 0 }), "the podcast");
  const granted = await grantImported(statsId, "0123456789abcdef01234567", [{ email: STUDENT, productId: product, items: null }, { email: STUDENT, productId: cast.product.id, items: null }]);
  if (!granted.every(Boolean)) throw new Error("the course or the podcast was not granted to the student");
  await setPastBuyers(OWNER);
  const studentSession = await openSession(STUDENT);

  console.log(JSON.stringify({ podcast: cast.product.id, studentSession, course: course.id, product, lesson: lessonId, funnel: funnel.id, form: form.id, quizForm: quizForm.id }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
