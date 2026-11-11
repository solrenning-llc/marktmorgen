/**
 * Item 260 [KJ5], unit 2: an outline the preview accepted
 * (lib/course-import.ts, previewCourseImport) applied to a new course.
 *
 * Pure, with no caller yet: nothing is read, written, uploaded or spent, and
 * nothing here is permission to do so. It goes through the course's own
 * edits (lib/course.ts), the way ready structures do (lib/course-templates.ts,
 * applyTemplate): the "outline" edit for the modules and lessons, then
 * "module-remove" for the new course's own empty module and "lesson-edit"
 * for each lesson that has text. So it meets every limit those edits
 * enforce and makes nothing a creator could not make by hand. Whole or not
 * at all: any edit refused gives nothing back.
 *
 * Only a course exactly as it is made (templateFits): one the creator
 * touched is never written over.
 *
 * Nothing is changed silently. Where the editor's own cleaning (spaces in a
 * title, line ends in a text) would keep something other than what the
 * outline says, the place, the outline's words and what would be kept are
 * listed in `changed`, to show before anything is saved.
 *
 * Videos and files are not attached: their local references are listed in
 * `toUpload` by the new lesson they belong to, for the creator to upload
 * through the store's existing uploads, which check the plan's storage and
 * video rights and take the room before any cost. The lesson text is
 * returned apart (`bodies`), for saveBody, which takes its own room.
 */
import { type Course, type CourseEdit, cleanBody, editCourse, lessonsInOrder } from "@/lib/course";
import type { CourseImportDraft } from "@/lib/course-import";
import { templateFits } from "@/lib/course-templates";

export type ImportUpload = { lessonId: string; kind: "video" | "file"; path: string };
export type ImportChange = { path: string; from: string; to: string };

export type CourseImportPlan =
  | { ok: true; course: Course; bodies: { lessonId: string; text: string }[]; toUpload: ImportUpload[]; changed: ImportChange[] }
  | { ok: false; why: "not-new" | "refused" };

export function planCourseImport(course: Course, draft: CourseImportDraft): CourseImportPlan {
  if (!templateFits(course).ok) return { ok: false, why: "not-new" };
  const original = course.modules[0].id;
  const outline: CourseEdit = { op: "outline", modules: draft.modules.map((m) => ({ title: m.title, lessons: m.lessons.map((l) => l.title) })) };
  let step = editCourse(course, outline);
  if (!step.ok) return { ok: false, why: "refused" };
  step = editCourse(step.course, { op: "module-remove", moduleId: original });
  if (!step.ok) return { ok: false, why: "refused" };

  const made = step.course.modules;
  if (made.length !== draft.modules.length || made.some((m, i) => m.lessons.length !== draft.modules[i].lessons.length)) {
    return { ok: false, why: "refused" };
  }
  const changed: ImportChange[] = [];
  const bodies: { lessonId: string; text: string }[] = [];
  const toUpload: ImportUpload[] = [];
  const edits: CourseEdit[] = [];
  draft.modules.forEach((unit, mi) => {
    if (made[mi].title !== unit.title) changed.push({ path: `modules[${mi}].title`, from: unit.title, to: made[mi].title });
    unit.lessons.forEach((item, li) => {
      const lesson = made[mi].lessons[li];
      const at = `modules[${mi}].lessons[${li}]`;
      if (lesson.title !== item.title) changed.push({ path: `${at}.title`, from: item.title, to: lesson.title });
      const text = cleanBody(item.text);
      if (text !== item.text) changed.push({ path: `${at}.text`, from: item.text, to: text });
      if (text) {
        bodies.push({ lessonId: lesson.id, text });
        edits.push({ op: "lesson-edit", lessonId: lesson.id, title: lesson.title, preview: lesson.preview, link: lesson.link, hasBody: true });
      }
      if (item.video !== null) toUpload.push({ lessonId: lesson.id, kind: "video", path: item.video });
      for (const path of item.files) toUpload.push({ lessonId: lesson.id, kind: "file", path });
    });
  });
  for (const edit of edits) {
    step = editCourse(step.course, edit);
    if (!step.ok) return { ok: false, why: "refused" };
  }
  // The edits above keep every title as the outline edit made it; a lesson that moved or vanished would be a fault, so it gives nothing.
  if (lessonsInOrder(step.course).length !== draft.modules.reduce((n, m) => n + m.lessons.length, 0)) return { ok: false, why: "refused" };
  return { ok: true, course: step.course, bodies, toUpload, changed };
}

/** The outline's size one studio request covers (a studio request's own transfer, tests/plan-cost-registry.ts). */
export const IMPORT_BYTES_PER_UNIT = 50_000;
/** The largest outline the import route reads: under the hosting's request body limit. */
export const IMPORT_MAX_BYTES = 4_000_000;

/**
 * Studio requests an import takes beyond the one its request already took
 * (lib/studio-route.ts, countStudio), before the work: one for each part of
 * the outline's size past the first; and, to save, one for each lesson
 * (its text written, at most MAX_BODY_LENGTH) and one for the outline's
 * write. `lessons` is null for a preview, which writes nothing.
 */
export function importUnits(outlineLength: number, lessons: number | null): number {
  const read = Math.max(0, Math.ceil(outlineLength / IMPORT_BYTES_PER_UNIT) - 1);
  return lessons === null ? read : read + lessons + 1;
}
