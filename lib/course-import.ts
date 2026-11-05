/** Item 260 [KJ5], unit 1. A preview is never an upload or permission to spend. */
export const COURSE_IMPORT_FORMAT = "marktmorgen-course-draft-v1";
export const MAX_COURSE_IMPORT_BYTES = 16 * 1024 * 1024;
export type CourseImportLesson = { title: string; text: string; video: string | null; files: string[] };
export type CourseImportDraft = { title: string; modules: { title: string; lessons: CourseImportLesson[] }[] };
export type CourseImportPreview =
  | { ok: true; state: "preview_only"; draft: CourseImportDraft; assets: string[]; lessonCount: number; storageBytes: null; videoSeconds: null; costUsd: null }
  | { ok: false; path: string; reason: string };

/** RED baseline: no creator-supplied course format is implemented yet. */
export function previewCourseImport(raw: unknown): CourseImportPreview {
  void raw;
  return { ok: false, path: "file", reason: "This course file could not be read." };
}
