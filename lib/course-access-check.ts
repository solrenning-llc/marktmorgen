/**
 * "Can everyone follow your lessons?" in the course editor: 98
 * [D2-COMPLIANCE-REVIEW] unit 2 (AX274 Part A item 6: the studio warns about
 * a video with no captions and offers the fix; it never changes the
 * creator's content on its own).
 *
 * Read only from what the course page already reads (app/studio/course/
 * [product]/page.tsx): the course, each lesson video's state at the video
 * service and the languages it has captions in, and the captions being
 * written by AI. No read more. Pure, so it can be tested.
 *
 * A video that can take captions here is one kept by the video service and
 * ready or being prepared, which is when the editor shows its Captions part
 * (components/course-editor.tsx). One still uploading, or that failed, is
 * left to its own state in the editor. One kept anywhere else cannot be given
 * captions in the editor: it is counted apart and never called fine. Not a
 * conformity claim: nothing here says a course is accessible or lawful.
 */
import type { Course } from "@/lib/course";
import type { CaptionTrack } from "@/lib/captions";
import { isStreamPath, type StreamState } from "@/lib/stream-rules";

/** A lesson, with where it sits: its module and its place in it, both counted from 1, so two of the same title differ. */
export type CheckedLesson = { id: string; title: string; module: number; lesson: number };

export type LessonCaptionCheck = {
  /** Lessons whose video can take captions and has none, none being written either, in course order. */
  missing: CheckedLesson[];
  /** Lesson videos whose captions are being written by AI now. */
  writing: number;
  /** Lesson videos still uploading, or that could not be prepared: no captions can be added until they are ready. */
  notReady: number;
  /** Lessons whose video is kept where captions cannot be added in the editor. */
  elsewhere: CheckedLesson[];
  /** Every lesson video is ready and has captions. */
  done: boolean;
};

/**
 * The id of a lesson's Captions title in the editor, which the check links to. Its own: the Captions part's language
 * menu is `captions-<lesson>`, named by its label (independent review, 31/10/2026).
 */
export function captionsAnchor(lessonId: string): string {
  return `lesson-captions-${lessonId}`;
}

/** The check for a course with at least one lesson video; null for one with none. */
export function lessonCaptionCheck(
  course: Course,
  states: Record<string, StreamState>,
  captions: Record<string, CaptionTrack[]>,
  writing: Record<string, string[]>,
): LessonCaptionCheck | null {
  const videos = course.modules.flatMap((unit, m) =>
    unit.lessons.flatMap((lesson, l) => (lesson.video ? [{ id: lesson.id, title: lesson.title, module: m + 1, lesson: l + 1, path: lesson.video.pathname }] : [])),
  );
  if (!videos.length) return null;
  const missing: CheckedLesson[] = [];
  const elsewhere: CheckedLesson[] = [];
  let beingWritten = 0;
  let notReady = 0;
  for (const { path, ...where } of videos) {
    if (!isStreamPath(path)) {
      elsewhere.push(where);
      continue;
    }
    // The editor's own default for a state it has not heard yet (components/course-editor.tsx).
    const state = states[path] ?? "working";
    if (state !== "ready" && state !== "working") {
      notReady += 1;
      continue;
    }
    if ((captions[path] ?? []).length > 0) continue;
    if ((writing[path] ?? []).length > 0) {
      beingWritten += 1;
      continue;
    }
    missing.push(where);
  }
  return { missing, writing: beingWritten, notReady, elsewhere, done: missing.length === 0 && elsewhere.length === 0 && notReady === 0 && beingWritten === 0 };
}
