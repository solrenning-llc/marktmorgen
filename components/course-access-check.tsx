import { Icon } from "@/components/icons";
import type { CheckedLesson, LessonCaptionCheck } from "@/lib/course-access-check";

/** "Module 2, lesson 1": where a lesson sits, so two lessons of the same title are told apart. */
const where = (lesson: CheckedLesson) => `module ${lesson.module}, lesson ${lesson.lesson}`;

/**
 * "Can everyone follow your lessons?" above the course editor (98
 * [D2-COMPLIANCE-REVIEW] unit 2, lib/course-access-check.ts): lesson videos
 * with no captions, by lesson, each with a link that opens that lesson at its
 * Captions part. It never changes the creator's videos or words.
 *
 * `hrefOf` keeps the store in the address, as every studio link does
 * (lib/studio-route.ts, studioPath). `canWrite`: this person sees the editor's
 * AI captions control. `canReupload`: a video uploaded again now goes to the
 * video service, where captions can be added.
 */
export function CourseAccessCheck({
  check,
  productId,
  hrefOf,
  canWrite,
  canReupload,
}: {
  check: LessonCaptionCheck | null;
  productId: string;
  hrefOf: (lessonId: string) => string;
  canWrite: boolean;
  canReupload: boolean;
}) {
  if (!check) return null;
  return (
    <section aria-labelledby={`course-access-${productId}`} className="card mt-8 p-6 sm:p-8">
      <h2 id={`course-access-${productId}`} className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Can everyone follow your lessons?
      </h2>
      <p className="mt-1 max-w-[80ch] text-sm text-ink-soft">
        Captions show the words of a video as text, for students who cannot hear it, are somewhere quiet, or follow better by reading. This checks the videos of this course as they were when this page opened; reload the page to check again. It is not a full accessibility review.
      </p>
      {check.done ? (
        <p className="mt-5 flex items-center gap-2 text-sm text-ink" data-course-captions="done">
          <Icon name="check" size={16} className="text-violet-deep" />
          Every lesson video has captions.
        </p>
      ) : null}
      {check.missing.length ? (
        <div className="mt-5 rounded-2xl bg-paper p-4 ring-1 ring-line" data-course-captions={check.missing.length}>
          <h3 className="font-semibold text-ink">
            {check.missing.length === 1 ? "1 lesson video has no captions" : `${check.missing.length} lesson videos have no captions`}
          </h3>
          <p className="mt-1 max-w-[80ch] text-sm text-ink-soft">
            {canWrite
              ? "Open each lesson below and add a captions file (.vtt or .srt) under Captions, or have them written for you there once the video is ready."
              : "Open each lesson below and add a captions file (.vtt or .srt) under Captions."}
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {check.missing.map((lesson) => (
              <li key={lesson.id}>
                <a href={hrefOf(lesson.id)} className="font-bold text-violet-deep underline underline-offset-2">
                  {`Add captions to “${lesson.title}” (${where(lesson)})`}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {check.writing > 0 ? (
        <p className="mt-4 max-w-[80ch] text-sm text-ink" data-course-captions-writing={check.writing}>
          {check.writing === 1 ? "Captions for 1 lesson video are being written. They appear in its lesson when they are done." : `Captions for ${check.writing} lesson videos are being written. They appear in each lesson when they are done.`}
        </p>
      ) : null}
      {check.notReady > 0 ? (
        <p className="mt-4 max-w-[80ch] text-sm text-ink" data-course-captions-not-ready={check.notReady}>
          {check.notReady === 1
            ? "1 lesson video is still uploading or could not be prepared. Captions can be added once it is ready; its lesson says where it stands."
            : `${check.notReady} lesson videos are still uploading or could not be prepared. Captions can be added once they are ready; each lesson says where it stands.`}
        </p>
      ) : null}
      {check.elsewhere.length ? (
        <div className="mt-4 max-w-[80ch] text-sm text-ink" data-course-captions-elsewhere={check.elsewhere.length}>
          <p>
            {check.elsewhere.length === 1 ? "This lesson video is kept where captions cannot be added:" : "These lesson videos are kept where captions cannot be added:"}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-6">
            {check.elsewhere.map((lesson) => <li key={lesson.id}>{`“${lesson.title}” (${where(lesson)})`}</li>)}
          </ul>
          {canReupload ? <p className="mt-2">To add captions, open the lesson and use Replace the video with the same file. Once the lesson shows the video being prepared, a Captions part appears under it.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
