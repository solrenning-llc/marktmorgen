/**
 * "What a student sees on day …" in the course editor (399 [SL3], unit 3;
 * added 2 November 2026): which modules and lessons are open to a student a
 * given number of days into the course, by the course page's own rules, so
 * the creator can check a drip schedule, a cohort and a quiz or assignment
 * that holds lessons shut without buying the course or waiting for the day.
 *
 *   - Open or not is isOpen (lib/course.ts), as the course page uses it: on a
 *     course with no start date the days count from each student's joining,
 *     on a cohort from its start date.
 *   - Held shut is heldBack (lib/quiz.ts) for a student who has passed
 *     nothing yet: every lesson after the first required quiz, or assignment
 *     that holds the rest shut, waits for it: for a quiz, until it is
 *     passed; for an assignment, until it is handed in, or, when the creator
 *     reviews each one, until they approve it (lib/assignment.ts).
 *   - A free preview lesson is open to everyone, as on the store page.
 *
 * Nothing is read, written or counted; no student, purchase or progress is
 * looked at.
 */
import { type Course, isCohort, isOpen, lessonsInOrder } from "@/lib/course";
import { heldBack } from "@/lib/quiz";

export type PreviewLesson = {
  id: string;
  title: string;
  /** "open"; "free" (a free preview, open to anyone); "waits" (its module has not opened); "held" (behind a quiz or assignment). */
  state: "open" | "free" | "waits" | "held";
  /** For "waits": the day its module opens. */
  opensOnDay?: number;
  /** For "held": the lesson whose quiz must be passed, whose assignment handed in, or whose assignment the creator must approve, first. */
  heldBy?: { title: string; kind: "quiz" | "task" | "approval" };
};

export type PreviewModule = { id: string; title: string; open: boolean; opensOnDay: number; lessons: PreviewLesson[] };

/** Whether anything in the course depends on the day or on a quiz, so the preview has something to show. */
export function previewMatters(course: Course): boolean {
  return isCohort(course) || course.modules.some((unit) => unit.dripDays > 0) || lessonsInOrder(course).some(({ lesson }) => lesson.quiz?.required || lesson.task?.gate);
}

/** The last day anything opens: the preview's days run from 0 to it. */
export function lastOpeningDay(course: Course): number {
  return Math.max(0, ...course.modules.map((unit) => unit.dripDays));
}

/**
 * The course as a student sees it `day` whole days after their clock started
 * (their joining day, or the cohort's start date), having passed nothing yet.
 */
export function courseOnDay(course: Course, day: number): PreviewModule[] {
  // Whole days; anything that cannot be read is day 0.
  const days = Number.isFinite(day) && day >= 0 ? Math.floor(day) : 0;
  // The clock's start in seconds: the cohort's date, or a joining day of 0. The moment looked at is that many days after it.
  const start = course.startsAt ?? 0;
  const at = start + days * 86_400;
  const held = heldBack(course, new Set());
  const lessons = new Map(lessonsInOrder(course).map(({ lesson }) => [lesson.id, lesson]));
  return course.modules.map((unit) => {
    const open = isOpen(course, unit, start, at);
    return {
      id: unit.id,
      title: unit.title,
      open,
      opensOnDay: unit.dripDays,
      lessons: unit.lessons.map((lesson): PreviewLesson => {
        if (lesson.preview) return { id: lesson.id, title: lesson.title, state: "free" };
        if (!open) return { id: lesson.id, title: lesson.title, state: "waits", opensOnDay: unit.dripDays };
        const by = lessons.get(held.get(lesson.id) ?? "");
        if (!by) return { id: lesson.id, title: lesson.title, state: "open" };
        const kind = by.quiz?.required ? "quiz" : by.task?.review ? "approval" : "task";
        return { id: lesson.id, title: lesson.title, state: "held", heldBy: { title: by.title, kind } };
      }),
    };
  });
}

/** What the preview says beside a lesson. */
export function lessonStateWords(lesson: PreviewLesson): string {
  if (lesson.state === "open") return "Open";
  if (lesson.state === "free") return "Free preview: open to anyone";
  if (lesson.state === "waits") return `Opens on day ${lesson.opensOnDay ?? 0}, with its module`;
  const by = lesson.heldBy;
  if (by?.kind === "quiz") return `Opens once the quiz in “${by.title}” is passed`;
  if (by?.kind === "approval") return `Opens once you approve the work handed in for “${by.title}”`;
  return `Opens once the work in “${by?.title ?? ""}” is handed in`;
}

/** One line for the day: how many lessons a student can open, out of all, and when every module is open. */
export function dayWords(modules: PreviewModule[], day: number, last: number): string {
  const all = modules.flatMap((unit) => unit.lessons);
  const open = all.filter((lesson) => lesson.state === "open" || lesson.state === "free").length;
  const count = `${open} of ${all.length} ${all.length === 1 ? "lesson" : "lessons"} open`;
  return day >= last && last > 0 ? `${count}. Every module is open from day ${last}.` : `${count}.`;
}
