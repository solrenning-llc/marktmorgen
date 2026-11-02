/**
 * Ready course structures to start from (540 [CU1], unit 1; added
 * 1 November 2026): no AI, no cost of their own. A structure is modules,
 * example lesson titles marked as examples for the creator to replace, when
 * each module opens, and whether finishing gives a certificate.
 *
 * It is applied through the course's own edits (lib/course.ts): the
 * "outline" edit the writing help already uses for the modules and lessons,
 * then "module-remove" for the new course's own empty module, "module-edit"
 * for each module's opening day and "certificate", chained in memory and
 * saved once (applyTemplate). So it meets every limit those edits already
 * enforce, and makes nothing a course could not have by hand. It is offered
 * only to a course exactly as it is made: one the creator touched is never
 * written over.
 *
 * Example titles are neutral: no result, promise, number of anything a
 * buyer gets, or testimonial (tests/course-templates.test.ts holds them to
 * that). Browser-safe: plain data and pure functions.
 *
 * Unit 2 (1 November 2026): the studio offers these on a new course
 * (components/course-template-picker.tsx). A pick is shown first as a draft,
 * built here in the browser with applyTemplate, and nothing is saved until
 * the creator says so; the save sends only the structure's id, and the
 * server applies it again to the course it keeps, under the course's lock,
 * in one write (app/api/store/course/route.ts, action "template").
 */
import { editCourse, type Course, type CourseEdit } from "@/lib/course";

export type TemplateModule = { title: string; lessons: string[]; dripDays: number };
export type CourseTemplate = {
  id: "mini" | "weekly" | "challenge" | "quizzes" | "scratch";
  name: string;
  /** What it is and who it is for, in one sentence. */
  about: string;
  modules: TemplateModule[];
  certificate: boolean;
  /** The funnel type it goes with (lib/funnel-types.ts), when there is one. */
  funnel: string | null;
};

const lessons = (count: number, first = 1) => Array.from({ length: count }, (_, i) => `Lesson ${first + i}: your title here`);

export const COURSE_TEMPLATES: readonly CourseTemplate[] = [
  {
    id: "mini",
    name: "Mini course",
    about: "One module of four short lessons, all open on the first day. For one focused topic.",
    modules: [{ title: "Module 1: your title here", lessons: lessons(4), dripDays: 0 }],
    certificate: false,
    funnel: null,
  },
  {
    id: "weekly",
    name: "Weekly course",
    about: "Four modules, one opening each week, with the email students already get when a module opens. For a course taken over a month.",
    modules: [0, 1, 2, 3].map((week) => ({ title: `Week ${week + 1}: your title here`, lessons: lessons(3, week * 3 + 1), dripDays: week * 7 })),
    certificate: false,
    funnel: null,
  },
  {
    id: "challenge",
    name: "5-day challenge",
    about: "Five short lessons, one opening each day, with an email to each student the day a lesson opens.",
    modules: [0, 1, 2, 3, 4].map((day) => ({ title: `Day ${day + 1}: your title here`, lessons: [`Lesson ${day + 1}: your title here`], dripDays: day })),
    certificate: false,
    // The challenge funnel (lib/funnel-types.ts) wants a free course, and a course here is always sold, so it is not offered with it.
    funnel: null,
  },
  {
    id: "quizzes",
    name: "Course with quizzes and a certificate",
    about: "Three modules, each ending with a lesson for its quiz, and a certificate when a student finishes. You write the questions.",
    modules: [0, 1, 2].map((m) => ({ title: `Module ${m + 1}: your title here`, lessons: [...lessons(2, m * 3 + 1), `Lesson ${m * 3 + 3}: quiz, add your questions here`], dripDays: 0 })),
    certificate: true,
    funnel: null,
  },
  { id: "scratch", name: "Start from scratch", about: "An empty course you build yourself, one module at a time.", modules: [], certificate: false, funnel: null },
];

export type TemplateFit = { ok: true } | { ok: false; why: "not-new" };

/**
 * Whether a structure may be applied: only to a course exactly as it is
 * made (lib/course.ts, emptyCourse: one "Module 1" opening on the first day,
 * no lesson, no certificate, no start date). A course the creator has
 * touched at all, a module renamed or given an opening day, is never
 * written over.
 */
export function templateFits(course: Pick<Course, "modules" | "certificate" | "startsAt">): TemplateFit {
  const [only, ...more] = course.modules;
  const untouched = !more.length && only && only.title === "Module 1" && only.dripDays === 0 && only.lessons.length === 0 && !course.certificate && course.startsAt === null;
  return untouched ? { ok: true } : { ok: false, why: "not-new" };
}

/** Said beside the structures when they cannot be applied. */
export const FIT_WORDS: Record<Exclude<TemplateFit, { ok: true }>["why"], string> = {
  "not-new": "Ready structures are for a new course. This one already has your changes, so it stays as it is.",
};

/**
 * The whole structure applied at once: the course's own edits chained on
 * the course in memory (the outline, taking away the new course's own
 * empty module only, each module's opening day, the certificate), so the
 * result is shown as a draft and saved in one write, or not at all. Any
 * edit refused leaves nothing done.
 */
export function applyTemplate(course: Course, template: CourseTemplate): { ok: true; course: Course } | { ok: false } {
  if (!templateFits(course).ok) return { ok: false };
  if (!template.modules.length) return { ok: true, course };
  const original = course.modules[0].id;
  const outline: CourseEdit = { op: "outline", modules: template.modules.map((m) => ({ title: m.title, lessons: [...m.lessons] })) };
  let draft = editCourse(course, outline);
  if (!draft.ok) return { ok: false };
  const added = draft.course.modules.filter((m) => m.id !== original);
  const edits: CourseEdit[] = [{ op: "module-remove", moduleId: original }];
  template.modules.forEach((m, i) => {
    if (m.dripDays > 0) edits.push({ op: "module-edit", moduleId: added[i].id, title: m.title, dripDays: m.dripDays });
  });
  if (template.certificate) edits.push({ op: "certificate", on: true });
  for (const edit of edits) {
    draft = editCourse(draft.course, edit);
    if (!draft.ok) return { ok: false };
  }
  return { ok: true, course: draft.course };
}

/** A structure by its id, as the studio sends it; null for anything else. */
export function templateById(id: unknown): CourseTemplate | null {
  return COURSE_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** When a module opens, in the words the course editor already uses beside each module. */
export function opensWords(dripDays: number): string {
  return dripDays === 0
    ? "Opens as soon as a student joins."
    : `Opens ${dripDays} ${dripDays === 1 ? "day" : "days"} after each student joins, with an email to them that day.`;
}

/** What a structure adds, in one sentence: said when it is picked, before anything is saved. */
export function draftWords(template: CourseTemplate): string {
  if (!template.modules.length) return "Nothing is added. You build the course yourself, one module at a time.";
  const modules = template.modules.length;
  const lessons = template.modules.reduce((n, m) => n + m.lessons.length, 0);
  const counted = `${modules} ${modules === 1 ? "module" : "modules"} and ${lessons} ${lessons === 1 ? "lesson" : "lessons"}`;
  return `Draft: ${counted}${template.certificate ? ", with a certificate when a student finishes" : ""}. Nothing is saved until you press "Use this structure". The course then stays hidden from your store until you replace every example title.`;
}

/**
 * What the editor says while example titles are left. Module titles go into
 * the email a student gets when a module opens, so they are named first.
 */
export function exampleTitlesWords(left: number): string {
  if (left <= 0) return "";
  const titles = left === 1 ? "1 title is still an example" : `${left} titles are still examples`;
  return `${titles}. Replace each with your own: until then the course stays hidden from your store, because a module's title is in the email a student gets when it opens.`;
}

/** The marks an example title carries until the creator replaces it. */
const EXAMPLE = /your title here|add your questions here/i;

/**
 * Titles still as the structure wrote them. Module titles go into the email
 * a student gets when a module opens (lib/learn.ts, sendDripEmails), so the
 * course is kept off the store while any is left: the route that applies a
 * structure hides the product (it had no lesson, so nothing could be sold
 * yet), and publishing it is refused until every example title is replaced
 * (app/api/store/product/route.ts, "course_examples"). The editor says how
 * many are left (exampleTitlesWords).
 */
export function exampleTitlesLeft(course: Pick<Course, "modules">): number {
  return course.modules.reduce((n, m) => n + (EXAMPLE.test(m.title) ? 1 : 0) + m.lessons.filter((l) => EXAMPLE.test(l.title)).length, 0);
}

/**
 * Lessons of the "Course with quizzes and a certificate" structure still
 * waiting for their questions: its name promises quizzes, and a quiz lesson
 * is an ordinary lesson until the creator writes them, so the editor says
 * how many and opens the first one.
 */
export function quizLessonsWaiting(course: Pick<Course, "modules">): string[] {
  // A lesson given an assignment instead cannot take a quiz too, so it is not counted.
  return course.modules.flatMap((m) => m.lessons.filter((l) => /add your questions here/i.test(l.title) && !l.quiz && !l.task).map((l) => l.id));
}

export function quizWaitingWords(waiting: number): string {
  if (waiting <= 0) return "";
  return `${waiting === 1 ? "1 quiz lesson has" : `${waiting} quiz lessons have`} no questions yet. Open each one and press "Add a quiz": until then it is an ordinary lesson.`;
}
