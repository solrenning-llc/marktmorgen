"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useLeaveGuard } from "@/components/leave-guard";
import { UrlField } from "@/components/url-field";
import { LessonText } from "@/components/lesson-text";
import { type StoreLook, lookStyle } from "@/lib/store-look";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { useRouter } from "next/navigation";
import { uploadReason, uploadSoldFile } from "@/lib/sold-file-upload";
import { toast } from "@/components/toast";
import { QuizEditor } from "@/components/quiz-editor";
import { TaskEditor } from "@/components/task-editor";
import {
  type Course,
  type CourseModule,
  type Lesson,
  MAX_BODY_LENGTH,
  MAX_DRIP_DAYS,
  MAX_ITEM_TITLE,
  MAX_LESSON_FILES,
  MAX_LESSONS,
  VIDEO_TYPES,
} from "@/lib/course";
import { MAX_VIDEOS_AT_ONCE, type Skipped, lessonTitleFromFile, planVideos } from "@/lib/course-videos";
import {
  ACCEPT_ATTRIBUTE,
  MAX_FILE_BYTES,
  maxFileLabel,
  readableSize,
  safeFileName,
} from "@/lib/product-file";
import { LINK_PROBLEMS, type LinkProblem } from "@/lib/product-link";
import { useStudioHref } from "@/components/studio-store-pin";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { CourseTemplatePicker } from "@/components/course-template-picker";
import { FIT_WORDS, exampleTitlesLeft, exampleTitlesWords, quizLessonsWaiting, quizWaitingWords, templateFits } from "@/lib/course-templates";
import { AiAssist, AiOn } from "@/components/ai-assist";
import { type StreamState, isStreamPath } from "@/lib/stream-rules";
import { CAPTION_LANGUAGES, type CaptionTrack, MAX_CAPTION_BYTES, MAX_CAPTION_TRACKS } from "@/lib/captions";
import { captionsAnchor } from "@/lib/course-access-check";
import { CENTS_PER_MINUTE, GIVE_UP_HOURS, MAX_AUTO_LANGUAGES, MAX_AUTO_MINUTES, MIN_CENTS, autoCaptionCents, dollars } from "@/lib/auto-captions-rules";
import { TusError, tusUpload } from "@/lib/tus-upload";

type Outline = { modules: { title: string; lessons: string[] }[] };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  too_many: "That is as many as a course holds: 30 modules and 200 lessons.",
  not_empty: "Take its lessons out first, one by one, so no work is lost by accident.",
  drip: `Type a number of days from 0 to ${MAX_DRIP_DAYS}.`,
  files: `A lesson holds up to ${MAX_LESSON_FILES} downloads.`,
  video_type: "That video type does not play in every browser. Upload an MP4, a MOV or a WebM.",
  too_big: `That file is over ${maxFileLabel()}, which is the most one file can be.`,
  wrong_type: "That kind of file cannot be uploaded here.",
  unknown: "That is not there anymore. Reload the page.",
  not_course: "This product is no longer a course. Reload the page.",
  not_new: FIT_WORDS["not-new"],
  busy: "Another change to this course is still saving. Try again in a moment.",
  invalid: "That upload could not be checked. Try again.",
  storage_full: "This file does not fit within your store's remaining storage. Delete a file you no longer sell to make room — nothing already bought is affected.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  video_unavailable: "Videos cannot be taken in just now. Try again in a few minutes.",
  slow_down: "That is a lot of videos in one hour. Try again a little later.",
  upload_stopped: "The upload stopped before the end, and could not go on. Check your connection and upload the video again.",
  caption_format: "That file could not be read as captions. Upload a .vtt or .srt file with a time on every caption.",
  caption_empty: "That file is empty.",
  caption_too_big: "That captions file is over 1 MB, which is the most one can be.",
  caption_many: `A video holds captions in up to ${MAX_CAPTION_TRACKS} languages. Remove one first.`,
  caption_not_ready: "The video has to finish uploading before captions can be added.",
  caption_language: "Choose a language from the list.",
  caption_unknown: "That video is not there anymore. Reload the page.",
  auto_not_ready: "The video has to finish uploading and being prepared before captions can be written.",
  auto_language: "Choose languages this video has no captions in yet, the one spoken first, three at most.",
  auto_long: `Captions are written for videos of up to ${MAX_AUTO_MINUTES / 60} hours.`,
  auto_busy: "Captions for this video are already being written. They appear here when they are done.",
  auto_plan: "Captions written by AI are charged to the card your plan is paid with, so they need a plan first.",
  auto_card: "There is no card on your plan to charge. Add one under Plan and billing, then try again.",
  auto_declined: "Your card was declined, so nothing was charged and nothing is being written.",
  auto_owed: "A refund for an earlier request for this video's captions is not confirmed by Stripe yet, so new AI captions can't be bought for it until it is. Its state is shown at the top of this page.",
  auto_refund_pending: "The video service would not write these captions. The charge is being refunded, but Stripe has not confirmed the refund yet; its state is shown at the top of this page.",
  auto_refunded: "The video service would not write these captions, so the charge was refunded to your card. Nothing is being written; try again in a moment.",
  auto_unavailable: "The video service could not take this just now. Nothing was charged; try again in a moment.",
  auto_unknown: "That video is not there anymore. Reload the page.",
  forbidden: "Your role on this store does not include charging the plan's card. Ask the owner to do this.",
  store_full: "Your store's data room is full. Delete something you no longer need, such as old posts, drafts, pages or contacts, or move to a larger plan.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Answer = { ok?: boolean; error?: string; reason?: string; course?: Course; stream?: StreamState };

/**
 * Where each lesson video kept by the video service (lib/stream.ts) is on
 * its way to being playable, by the path the lesson keeps for it: as the
 * page was drawn, and as this browser has learned since.
 */
// The store's look, for the lesson text's preview (487 [IT4], pattern 7).
const Look = createContext<{ look: StoreLook; language: LanguageCode } | null>(null);

const Streams = createContext<{
  states: Record<string, StreamState>;
  learned: (path: string, state: StreamState) => void;
  /** The languages each of those videos has captions in. */
  captions: Record<string, CaptionTrack[]>;
  captioned: (path: string, tracks: CaptionTrack[]) => void;
  /** The languages captions are being written in by AI, by video (lib/auto-captions.ts). */
  writing: Record<string, string[]>;
  wrote: (path: string, langs: string[]) => void;
  /** Whether this person may have captions written by AI, charged to the plan's card; and the store's language. */
  auto: { can: boolean; spoken: string };
}>({
  states: {},
  learned: () => {},
  captions: {},
  writing: {},
  wrote: () => {},
  auto: { can: false, spoken: "en" },
  captioned: () => {},
});

/** What a creator is told about a video the service keeps. */
const STREAM_WORDS: Record<StreamState, string> = {
  upload: "Being prepared in several sizes. It plays for students as soon as the first one is ready.",
  working: "Being prepared in several sizes. It plays for students as soon as the first one is ready.",
  ready: "Ready. It plays in the size each student's connection can carry.",
  failed: "This file could not be made into a video. Upload it again, as an MP4 if you can.",
};

type Door = { endpoint: string; library: string; id: string; expires: number; signature: string; pathname: string };

/**
 * Asks for the door a lesson's video goes through to the video service
 * (app/api/store/stream). "off" when the service is not set up, and the
 * video then goes into the file store as it always has.
 */
async function openDoor(lessonId: string, file: File): Promise<{ door: Door } | { off: true } | { error: string }> {
  try {
    const response = await fetch("/api/store/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId, name: file.name, bytes: file.size, type: file.type }),
    });
    const data = (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as { ok?: boolean; error?: string; door?: Door };
    if (data.ok && data.door) return { door: data.door };
    if (data.error === "off") return { off: true };
    return { error: data.error ?? "server_error" };
  } catch {
    return { error: "server_error" };
  }
}

/** The video service turned the upload away before it began: why, in MESSAGES' words. */
class VideoRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Sends one lesson's video where it is kept: to the video service when it is
 * set up, in pieces, so a dropped line costs only the piece on its way
 * (lib/tus-upload.ts), or else to the file store as it always has gone.
 * Returns where it is, for the course to be told; throws when it could not go.
 */
async function putVideo(lessonId: string, chosen: File, folder: string, onProgress: (percent: number) => void): Promise<string> {
  const opened = await openDoor(lessonId, chosen);
  if ("error" in opened) throw new VideoRefused(opened.error);
  if ("door" in opened) {
    const { door } = opened;
    await tusUpload(
      chosen,
      {
        endpoint: door.endpoint,
        headers: {
          AuthorizationSignature: door.signature,
          AuthorizationExpire: String(door.expires),
          LibraryId: door.library,
          VideoId: door.id,
        },
        metadata: { filetype: chosen.type, title: safeFileName(chosen.name) },
      },
      { onProgress },
    );
    return door.pathname;
  }
  return uploadSoldFile(chosen, { folder, ownerId: lessonId }, onProgress);
}

/** What went wrong with an upload, as a key of MESSAGES. */
function uploadProblem(thrown: unknown): string {
  if (thrown instanceof VideoRefused) return MESSAGES[thrown.code] ? thrown.code : "server_error";
  if (thrown instanceof TusError) return thrown.reason === "refused" ? "invalid" : "upload_stopped";
  const reason = uploadReason(thrown);
  return MESSAGES[reason] ? reason : "server_error";
}

async function post(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/store/course", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

function problem(answer: Answer): string {
  if (answer.error === "link") return LINK_PROBLEMS[answer.reason as LinkProblem] ?? LINK_PROBLEMS.shape;
  return MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error;
}

const small = "text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40";

/** Building a course: modules, lessons, and what each lesson holds. */
export function CourseEditor({
  productId,
  initial,
  folder,
  title = "",
  ai = { on: false, left: 0 },
  streams = {},
  captions = {},
  writing = {},
  auto = { can: false, spoken: "en" },
  openFirst = null,
  look = null,
  language = "en",
}: {
  productId: string;
  /** The store's look, so a lesson's text is previewed as students see it. */
  look?: StoreLook | null;
  /** The store's language, so the preview is marked as the lesson page is. */
  language?: LanguageCode;
  /** A lesson to show open when the page is drawn: the one "Can everyone follow your lessons?" linked to. */
  openFirst?: string | null;
  initial: Course;
  folder: string;
  /** Where each lesson video kept by the video service stood when the page was drawn. */
  streams?: Record<string, StreamState>;
  /** The languages each of those videos had captions in when the page was drawn. */
  captions?: Record<string, CaptionTrack[]>;
  /** The languages captions were being written in by AI, by video, when the page was drawn. */
  writing?: Record<string, string[]>;
  /** Whether this person may have captions written by AI, and the store's language to start from. */
  auto?: { can: boolean; spoken: string };
  /** The course's name, for the writing help. */
  title?: string;
  /** Whether the writing help is on, and what is left of the month (lib/ai.ts). */
  ai?: { on: boolean; left: number };
}) {
  const studioHref = useStudioHref();
  const router = useRouter();
  const [course, setCourse] = useState<Course>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openLesson, setOpenLesson] = useState<string | null>(openFirst);
  const [newModule, setNewModule] = useState("");
  // An outline the writing help proposed, waiting for the creator to add it or not.
  const [proposal, setProposal] = useState<Outline | null>(null);
  // The ready structures (540 [CU1]): put away for this visit by "Keep an empty course".
  const [skipTemplates, setSkipTemplates] = useState(false);
  // After a structure is used, the focus goes to the line that says which titles are still examples.
  const [focusExamples, setFocusExamples] = useState(0);
  const examplesLine = useRef<HTMLParagraphElement>(null);
  const [streamStates, setStreamStates] = useState<Record<string, StreamState>>(streams);
  const learned = (path: string, state: StreamState) => setStreamStates((known) => ({ ...known, [path]: state }));
  const [captionTracks, setCaptionTracks] = useState<Record<string, CaptionTrack[]>>(captions);
  const captioned = (path: string, tracks: CaptionTrack[]) => setCaptionTracks((known) => ({ ...known, [path]: tracks }));
  const [writingNow, setWritingNow] = useState<Record<string, string[]>>(writing);
  const wrote = (path: string, langs: string[]) => setWritingNow((known) => ({ ...known, [path]: langs }));

  async function run(payload: Record<string, unknown>): Promise<Answer> {
    setBusy(true);
    setError(null);
    const answer = await post({ id: productId, ...payload });
    setBusy(false);
    if (answer.ok && answer.course) setCourse(answer.course);
    if (!answer.ok) setError(problem(answer));
    return answer;
  }

  const lessons = course.modules.reduce((n, m) => n + m.lessons.length, 0);
  const examples = exampleTitlesLeft(course);
  const quizzesWaiting = quizLessonsWaiting(course).length;
  useEffect(() => {
    if (focusExamples) examplesLine.current?.focus();
  }, [focusExamples]);

  return (
    <Look.Provider value={look ? { look, language } : null}>
    <Streams.Provider value={{ states: streamStates, learned, captions: captionTracks, captioned, writing: writingNow, wrote, auto }}>
    <div className="mt-8 space-y-6">
      {error ? (
        <p className="notice notice-error" role="alert">{error}</p>
      ) : null}

      {/* Both the course as this page holds it and as the server last drew it: a certificate or a start date set further down changes only the second. */}
      {!skipTemplates && templateFits(course).ok && templateFits(initial).ok ? (
        <CourseTemplatePicker
          course={course}
          busy={busy}
          save={async (payload) => {
            const answer = await run(payload);
            // The course already has the creator's changes: the structures go, with the course as kept.
            if (answer.error === "not_new") {
              setSkipTemplates(true);
              router.refresh();
            }
            return answer;
          }}
          onSkip={() => {
            setSkipTemplates(true);
            // The picker goes away with the focus in it: the focus moves to the first module's name, where an empty course starts.
            const first = course.modules[0];
            requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`section[aria-labelledby="module-${first?.id}-heading"] input`)?.focus());
          }}
          onApplied={(kept) => {
            toast("The structure is added. The course stays hidden from your store until you replace the example titles.");
            // A quiz lesson the structure made opens, with its "Add a quiz" button.
            const quiz = quizLessonsWaiting(kept)[0];
            if (quiz) setOpenLesson(quiz);
            setFocusExamples((n) => n + 1);
            // The certificate and the sale line further down the page are drawn by the server.
            router.refresh();
          }}
        />
      ) : null}
      {examples > 0 || quizzesWaiting > 0 ? (
        <p id="course-example-titles" ref={examplesLine} tabIndex={-1} className="notice notice-warn">
          {[exampleTitlesWords(examples), quizWaitingWords(quizzesWaiting)].filter(Boolean).join(" ")}
        </p>
      ) : null}

      <AiOn value={ai}>
      {course.modules.map((unit, index) => (
        <ModuleCard
          key={unit.id}
          unit={unit}
          index={index}
          last={index === course.modules.length - 1}
          busy={busy}
          productId={productId}
          folder={folder}
          openLesson={openLesson}
          setOpenLesson={setOpenLesson}
          room={MAX_LESSONS - lessons}
          run={run}
          onCourse={setCourse}
          onError={setError}
        />
      ))}
      </AiOn>

      <AiOn value={ai}>
        <AiAssist<Outline>
          title="Draft the outline with AI"
          hint="Say what the course covers and who it is for. A list of modules and lessons comes back for you to look at, and nothing is added until you say so."
          placeholder="Sourdough from scratch for complete beginners: starter, first loaf, shaping, scoring, and fixing what went wrong."
          payload={() => ({ kind: "outline", title })}
          onResult={(value) => setProposal(value)}
          done="Here is the outline. Add it as it is, or discard it."
        />
        {proposal ? (
          <section className="card p-6 sm:p-8" aria-labelledby="outline-title">
            <h2 id="outline-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">A proposed outline</h2>
            <ol className="mt-3 space-y-3 text-sm">
              {proposal.modules.map((unit, i) => (
                <li key={i}>
                  <p className="font-semibold text-ink">{`${i + 1}. ${unit.title}`}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-6 text-ink-soft">
                    {unit.lessons.map((lesson, n) => (
                      <li key={n}>{lesson}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-sm text-ink-soft">
              Each lesson is added with its title only: its video, text and files are yours to add, and any title can be changed.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy}
                aria-busy={busy}
                onClick={async () => {
                  const answer = await run({ action: "edit", op: "outline", modules: proposal.modules });
                  if (answer.ok) {
                    setProposal(null);
                    toast("The modules and lessons are added.");
                  }
                }}
              >
                {`Add these ${proposal.modules.length} modules`}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setProposal(null)}>
                Discard it
              </button>
            </div>
          </section>
        ) : null}
      </AiOn>

      <form
        className="card p-6 sm:p-8"
        onSubmit={async (event) => {
          event.preventDefault();
          const answer = await run({ action: "edit", op: "module-add", title: newModule });
          if (answer.ok) setNewModule("");
        }}
      >
        <label htmlFor="new-module" className="field-label">Add a module</label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="new-module"
            className="field min-w-0 flex-1"
            maxLength={MAX_ITEM_TITLE}
            placeholder={`Module ${course.modules.length + 1}`}
            value={newModule}
            onChange={(event) => setNewModule(event.target.value)}
          />
          <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-secondary">Add module</button>
        </div>
      </form>

      {lessons === 0 ? (
        <div className="card-flat p-6 sm:p-8">
          <p className="text-sm text-ink-soft">
            Changed your mind? A course with no lessons can go back to being an ordinary product.
          </p>
          <button
            type="button"
            aria-busy={busy} disabled={busy}
            className="btn btn-secondary btn-sm mt-3"
            onClick={async () => {
              const answer = await run({ action: "disable" });
              if (answer.ok) {
                toast("It's an ordinary product again.");
                router.push(studioHref("/studio"));
              }
            }}
          >
            Stop selling it as a course
          </button>
        </div>
      ) : null}
    </div>
    </Streams.Provider>
    </Look.Provider>
  );
}

function ModuleCard({
  unit,
  index,
  last,
  busy,
  productId,
  folder,
  openLesson,
  setOpenLesson,
  room,
  run,
  onCourse,
  onError,
}: {
  unit: CourseModule;
  index: number;
  last: boolean;
  busy: boolean;
  productId: string;
  folder: string;
  openLesson: string | null;
  setOpenLesson: (id: string | null) => void;
  /** Lessons the course still has room for. */
  room: number;
  run: (payload: Record<string, unknown>) => Promise<Answer>;
  onCourse: (course: Course) => void;
  onError: (message: string | null) => void;
}) {
  const [title, setTitle] = useState(unit.title);
  const [drip, setDrip] = useState(String(unit.dripDays));
  const [newLesson, setNewLesson] = useState("");
  const changed = title !== unit.title || drip !== String(unit.dripDays);
  // A module's name or days changed and not saved: leaving asks first (487 [IT4], item 6).
  // Asked while a save is still going too: the course's busy is shared by every module and lesson.
  useLeaveGuard(changed);
  const titleId = `module-${unit.id}-title`;
  const dripId = `module-${unit.id}-drip`;

  return (
    <section className="card p-6 sm:p-8" aria-labelledby={`module-${unit.id}-heading`}>
      <p id={`module-${unit.id}-heading`} className="eyebrow">{`Module ${index + 1}`}</p>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          const answer = await run({ action: "edit", op: "module-edit", moduleId: unit.id, title, dripDays: drip });
          if (answer.ok) {
            // Taken as the server kept it, so a name it tidied never reads as unsaved.
            const kept = answer.course?.modules.find((m) => m.id === unit.id);
            if (kept) {
              // A field changed while it was saving keeps what was typed.
              setTitle((now) => (now === title ? kept.title : now));
              setDrip((now) => (now === drip ? String(kept.dripDays) : now));
            }
            toast("Module saved.");
          }
        }}
      >
        <label className="block min-w-0">
          <span className="field-label" id={titleId}>Name</span>
          <input aria-labelledby={titleId} className="field mt-2" maxLength={MAX_ITEM_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block">
          <span className="field-label" id={dripId}>Opens after (days)</span>
          <input
            aria-labelledby={dripId}
            className="field mt-2"
            inputMode="numeric"
            pattern="[0-9]*"
            value={drip}
            onChange={(e) => setDrip(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          />
        </label>
        <button type="submit" disabled={busy || !changed} className="btn btn-secondary">Save</button>
      </form>
      <p className="mt-2 text-sm text-ink-mute">
        {unit.dripDays === 0
          ? "Opens as soon as a student joins."
          : `Opens ${unit.dripDays} ${unit.dripDays === 1 ? "day" : "days"} after each student joins, with an email to them that day.`}
      </p>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm font-bold">
        <button type="button" className={small} disabled={busy || index === 0} onClick={() => run({ action: "edit", op: "module-move", moduleId: unit.id, direction: "up" })}>
          Move module up
        </button>
        <button type="button" className={small} disabled={busy || last} onClick={() => run({ action: "edit", op: "module-move", moduleId: unit.id, direction: "down" })}>
          Move module down
        </button>
        {unit.lessons.length === 0 ? (
          <button
            type="button"
            className={small}
            aria-busy={busy}
            disabled={busy}
            onClick={async () => {
              const answer = await run({ action: "edit", op: "module-remove", moduleId: unit.id });
              if (answer.ok) toast("Module removed.");
            }}
          >
            Remove module
          </button>
        ) : null}
      </div>

      <ol className="mt-5 space-y-3">
        {unit.lessons.map((lesson, li) => (
          <li key={lesson.id} className="rounded-[var(--r-sm)] border border-line bg-white p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="min-w-0 break-words font-semibold text-ink">{`${li + 1}. ${lesson.title}`}</p>
              <p className="text-xs font-bold uppercase tracking-wide text-ink-mute">
                {[
                  lesson.video ? "video" : null,
                  lesson.hasBody ? "text" : null,
                  lesson.files.length ? `${lesson.files.length} ${lesson.files.length === 1 ? "download" : "downloads"}` : null,
                  lesson.link ? "link" : null,
                  lesson.quiz ? `quiz${lesson.quiz.required ? ", must pass" : ""}` : null,
                  lesson.task ? `assignment${lesson.task.gate ? ", must finish" : ""}` : null,
                  lesson.preview ? "free preview" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "empty"}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm font-bold">
              <button type="button" className={small} onClick={() => setOpenLesson(openLesson === lesson.id ? null : lesson.id)} aria-expanded={openLesson === lesson.id}>
                {openLesson === lesson.id ? "Close" : "Edit lesson"}
              </button>
              <button type="button" className={small} aria-busy={busy} disabled={busy} onClick={() => run({ action: "edit", op: "lesson-move", lessonId: lesson.id, direction: "up" })}>
                Up
              </button>
              <button type="button" className={small} aria-busy={busy} disabled={busy} onClick={() => run({ action: "edit", op: "lesson-move", lessonId: lesson.id, direction: "down" })}>
                Down
              </button>
            </div>
            {openLesson === lesson.id ? (
              <LessonEditor
                lesson={lesson}
                productId={productId}
                folder={folder}
                busy={busy}
                run={run}
                onCourse={onCourse}
                onError={onError}
                onRemoved={() => setOpenLesson(null)}
              />
            ) : null}
          </li>
        ))}
      </ol>

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={async (event) => {
          event.preventDefault();
          const answer = await run({ action: "edit", op: "lesson-add", moduleId: unit.id, title: newLesson });
          if (answer.ok) setNewLesson("");
        }}
      >
        <label htmlFor={`new-lesson-${unit.id}`} className="sr-only">{`New lesson in module ${index + 1}`}</label>
        <input
          id={`new-lesson-${unit.id}`}
          className="field min-w-0 flex-1"
          maxLength={MAX_ITEM_TITLE}
          placeholder={`Lesson ${unit.lessons.length + 1}`}
          value={newLesson}
          onChange={(e) => setNewLesson(e.target.value)}
        />
        <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-primary">Add lesson</button>
      </form>
      <VideosToLessons unit={unit} index={index} productId={productId} folder={folder} room={room} busy={busy} onCourse={onCourse} onError={onError} />
    </section>
  );
}

/** Why a chosen video did not become a lesson, before anything was sent. */
const SKIPPED_WORDS: Record<Skipped["reason"], string> = {
  type: "This type does not play in every browser. Upload it as an MP4, a MOV or a WebM.",
  too_big: `It is over ${maxFileLabel()}, which is the most one file can be.`,
  room: `There was no room left: a course holds ${MAX_LESSONS} lessons, and ${MAX_VIDEOS_AT_ONCE} videos are taken at a time.`,
};

/** An upload that went wrong this way stops the rest: the next one would go wrong the same way. */
const STOPS_THE_REST = new Set(["renewal_unpaid", "plan_disputed", "uploads_pending", "upload_refresh", "slow_down", "video_unavailable", "storage_full", "signed_out", "unavailable", "not_course", "too_many", "unknown", "forbidden"]);

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Asks the course to change, once more after a moment while another change to it is still saving. */
async function postPatiently(payload: Record<string, unknown>): Promise<Answer> {
  for (let attempt = 0; ; attempt += 1) {
    const answer = await post(payload);
    if (answer.ok || answer.error !== "busy" || attempt >= 3) return answer;
    await pause(1_200);
  }
}

/**
 * A module's videos, chosen all at once, made into one lesson each
 * (lib/course-videos.ts): named after the file, in the order of the file
 * names, each lesson made just before its video goes up and taken away
 * again when its video could not go.
 */
function VideosToLessons({
  unit,
  index,
  productId,
  folder,
  room,
  busy,
  onCourse,
  onError,
}: {
  unit: CourseModule;
  index: number;
  productId: string;
  folder: string;
  room: number;
  busy: boolean;
  onCourse: (course: Course) => void;
  onError: (message: string | null) => void;
}) {
  const streams = useContext(Streams);
  const [working, setWorking] = useState<{ at: number; of: number; name: string; percent: number } | null>(null);
  const [report, setReport] = useState<{ made: number; missed: { name: string; why: string }[] } | null>(null);
  const stopping = useRef(false);
  const [stopAsked, setStopAsked] = useState(false);

  // Closing the tab stops the upload under way, so the browser asks first.
  useEffect(() => {
    if (!working) return;
    const hold = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [working]);

  async function makeLessons(chosen: File[]) {
    onError(null);
    setReport(null);
    stopping.current = false;
    setStopAsked(false);
    const { take, skipped } = planVideos(chosen, room, MAX_FILE_BYTES);
    const missed = skipped.map((s) => ({ name: s.name, why: SKIPPED_WORDS[s.reason] }));
    let made = 0;
    // The lessons this module had, so the one each request adds is the one not among them.
    const known = new Set(unit.lessons.map((lesson) => lesson.id));
    for (let i = 0; i < take.length; i += 1) {
      const file = take[i];
      const rest = (why: string) => take.slice(i).forEach((f) => missed.push({ name: f.name, why }));
      if (stopping.current) {
        rest("Not sent: you stopped before it.");
        break;
      }
      setWorking({ at: i + 1, of: take.length, name: file.name, percent: 0 });
      const added = await postPatiently({ id: productId, action: "edit", op: "lesson-add", moduleId: unit.id, title: lessonTitleFromFile(file.name) });
      const lesson = added.ok && added.course ? added.course.modules.find((m) => m.id === unit.id)?.lessons.find((l) => !known.has(l.id)) : undefined;
      if (!added.ok || !added.course || !lesson) {
        const code = added.error && MESSAGES[added.error] ? added.error : "server_error";
        if (STOPS_THE_REST.has(code)) {
          rest(MESSAGES[code]);
          break;
        }
        missed.push({ name: file.name, why: MESSAGES[code] });
        continue;
      }
      known.add(lesson.id);
      onCourse(added.course);
      let problem: string | null = null;
      try {
        const pathname = await putVideo(lesson.id, file, folder, (percent) => setWorking({ at: i + 1, of: take.length, name: file.name, percent }));
        const placed = await postPatiently({ id: productId, action: "media", lessonId: lesson.id, kind: "video", pathname, name: file.name });
        if (placed.ok && placed.course) {
          onCourse(placed.course);
          if (isStreamPath(pathname)) streams.learned(pathname, placed.stream ?? "working");
          made += 1;
        } else {
          problem = placed.error && MESSAGES[placed.error] ? placed.error : "server_error";
        }
      } catch (thrown) {
        problem = uploadProblem(thrown);
      }
      if (problem) {
        // Its lesson goes again, so no empty lesson is left behind.
        const removed = await postPatiently({ id: productId, action: "edit", op: "lesson-remove", lessonId: lesson.id });
        if (removed.ok && removed.course) onCourse(removed.course);
        missed.push({ name: file.name, why: MESSAGES[problem] });
        if (STOPS_THE_REST.has(problem)) {
          take.slice(i + 1).forEach((f) => missed.push({ name: f.name, why: "Not sent, because the video before it could not go." }));
          break;
        }
      }
    }
    setWorking(null);
    setReport({ made, missed });
    if (made) toast(`${made} ${made === 1 ? "lesson" : "lessons"} made from your videos.`);
  }

  const inputId = `videos-${unit.id}`;
  const hintId = `${inputId}-hint`;
  const off = busy || working !== null || room <= 0;
  return (
    <div className="mt-4 border-t border-line pt-4">
      <label htmlFor={inputId} className={`btn btn-secondary btn-sm ${off ? "pointer-events-none opacity-50" : "cursor-pointer"}`}>
        Add lessons from videos
      </label>
      <input
        id={inputId}
        type="file"
        multiple
        accept={VIDEO_TYPES.join(",")}
        className="sr-only"
        aria-describedby={hintId}
        aria-label={`Add lessons from videos to module ${index + 1}`}
        disabled={off}
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (chosen.length) void makeLessons(chosen);
        }}
      />
      <p id={hintId} className="mt-2 text-sm text-ink-mute">
        {room <= 0
          ? `The course holds as many lessons as it can: ${MAX_LESSONS}.`
          : `Choose up to ${Math.min(MAX_VIDEOS_AT_ONCE, room)} videos at once. Each becomes a lesson at the end of this module, named after its file, in the order of the file names.`}
      </p>
      {working ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm text-ink-soft" role="status">
            {`Video ${working.at} of ${working.of}: ${working.name} · ${Math.round(working.percent)}%. Keep this page open.`}
          </p>
          <button
            type="button"
            className={`${small} font-bold`}
            disabled={stopAsked}
            onClick={() => {
              stopping.current = true;
              setStopAsked(true);
            }}
          >
            {stopAsked ? "Stopping after this video…" : "Stop after this video"}
          </button>
        </div>
      ) : null}
      {report && report.missed.length ? (
        <div className="notice notice-error mt-3" role="alert">
          <p>{report.made ? `${report.made} became lessons. These did not:` : "None of these became a lesson:"}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {report.missed.map((m, n) => (
              <li key={`${m.name}-${n}`}>
                <span className="break-all font-semibold">{m.name}</span>
                {` · ${m.why}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function LessonEditor({
  lesson,
  productId,
  folder,
  busy,
  run,
  onCourse,
  onError,
  onRemoved,
}: {
  lesson: Lesson;
  productId: string;
  folder: string;
  busy: boolean;
  run: (payload: Record<string, unknown>) => Promise<Answer>;
  onCourse: (course: Course) => void;
  onError: (message: string | null) => void;
  onRemoved: () => void;
}) {
  const [title, setTitle] = useState(lesson.title);
  const [preview, setPreview] = useState(lesson.preview);
  const [link, setLink] = useState(lesson.link ?? "");
  const [text, setText] = useState<string | null>(null);
  // The text as it was read or last saved: only a change to it is unsaved.
  const [savedText, setSavedText] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [uploading, setUploading] = useState<{ kind: "video" | "file"; percent: number } | null>(null);
  const [removing, setRemoving] = useState(false);
  // The text's preview starts at a phone's width, where most lessons are read (487 [IT4], pattern 7).
  const [phone, setPhone] = useState(true);
  const shown = useContext(Look);
  const look = shown?.look ?? null;
  const locale = LANGUAGES[shown?.language ?? "en"]?.locale ?? "en-US";
  // A lesson's name, link, preview or text changed and not saved, or a file still going up: leaving asks first (487 [IT4], item 6).
  const unsaved = title !== lesson.title || preview !== lesson.preview || link !== (lesson.link ?? "") || text !== savedText;
  useLeaveGuard(unsaved || uploading !== null);
  const streams = useContext(Streams);

  async function loadText() {
    setLoadingText(true);
    try {
      const response = await fetch(`/api/store/course?id=${productId}&lessonId=${lesson.id}`, { cache: "no-store" });
      const data = (await response.json()) as { ok?: boolean; text?: string };
      const read = data.ok ? data.text ?? "" : "";
      setText(read);
      setSavedText(read);
    } catch {
      setText("");
      setSavedText("");
    } finally {
      setLoadingText(false);
    }
  }

  async function upload(kind: "video" | "file", chosen: File) {
    onError(null);
    if (chosen.size > MAX_FILE_BYTES) return onError(MESSAGES.too_big);
    if (kind === "video" && !VIDEO_TYPES.includes(chosen.type)) return onError(MESSAGES.video_type);
    setUploading({ kind, percent: 0 });
    try {
      const progress = (percent: number) => setUploading({ kind, percent });
      const pathname = kind === "video" ? await putVideo(lesson.id, chosen, folder, progress) : await uploadSoldFile(chosen, { folder, ownerId: lesson.id }, progress);
      const answer = await run({ action: "media", lessonId: lesson.id, kind, pathname, name: chosen.name });
      if (answer.ok && answer.course) {
        onCourse(answer.course);
        if (isStreamPath(pathname)) {
          streams.learned(pathname, answer.stream ?? "working");
          toast("Video uploaded.");
        }
      }
    } catch (thrown) {
      onError(MESSAGES[uploadProblem(thrown)]);
    } finally {
      setUploading(null);
    }
  }

  const prefix = `lesson-${lesson.id}`;
  // The lesson's text as its page draws it (components/lesson-text.tsx), from what is typed now, in the store's look.
  const toggle = (on: boolean) => `inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold ${on ? "bg-white text-ink shadow-sm" : "text-ink-soft"}`;
  const lessonPreview = (now: string, storeLook: StoreLook) => (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-soft">As students see it</p>
        <div role="group" aria-label="Preview width" className="inline-flex rounded-full bg-sand p-1">
          <button type="button" className={toggle(phone)} aria-pressed={phone} onClick={() => setPhone(true)}>
            Phone
          </button>
          <button type="button" className={toggle(!phone)} aria-pressed={!phone} onClick={() => setPhone(false)}>
            Wide
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-soft">The same words as in the editor, laid out as the lesson shows them. Nothing in it can be pressed here.</p>
      <div className="mt-1 overflow-hidden rounded-2xl ring-1 ring-line">
        <div
          // Inert: its links stay out of the Tab order and out of reach of a click that would leave the draft.
          inert
          // In the store's language, as the lesson page is (3.1.2).
          lang={locale}
          className={`st-page st-theme-${storeLook.theme} mx-auto px-4 pb-8 pt-6`}
          // The words in the page's text color, as the lesson page sets it; Wide takes the room there is, as the lesson column does.
          style={{ ...(lookStyle(storeLook) as React.CSSProperties), color: "var(--st-text)", maxWidth: phone ? 390 : "100%" }}
        >
          {/* In the same card the lesson page puts behind the words, so the color behind them and the line length match. */}
          <div className="st-card p-5 sm:p-8">
            {now.trim() ? <LessonText text={now} /> : <p className="text-sm">The lesson&apos;s words appear here as you write.</p>}
          </div>
        </div>
      </div>
    </div>
  );
  const streamed = lesson.video && isStreamPath(lesson.video.pathname) ? streams.states[lesson.video.pathname] ?? "working" : null;
  return (
    <div className="mt-4 space-y-5 border-t border-line pt-4">
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const answer = await run({ action: "edit", op: "lesson-edit", lessonId: lesson.id, title, preview, link });
          if (answer.ok) {
            // Taken as the server kept it, so a name or link it tidied never reads as unsaved.
            const kept = answer.course?.modules.flatMap((m) => m.lessons).find((l) => l.id === lesson.id);
            if (kept) {
              // A field changed while it was saving keeps what was typed.
              setTitle((now) => (now === title ? kept.title : now));
              setPreview((now) => (now === preview ? kept.preview : now));
              setLink((now) => (now === link ? kept.link ?? "" : now));
            }
            toast("Lesson saved.");
          }
        }}
      >
        <label className="block">
          <span className="field-label">Lesson name</span>
          <input className="field mt-2" maxLength={MAX_ITEM_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div>
          <label htmlFor={`${prefix}-link`} className="field-label">A link for this lesson (optional)</label>
          <UrlField id={`${prefix}-link`} className="field mt-2" value={link} onChange={setLink} />
        </div>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input type="checkbox" className="mt-1" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
          <span>Free preview: anyone can open this lesson from your store before buying.</span>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-secondary btn-sm">Save lesson</button>
        </div>
      </form>

      <div>
        <p className="field-label">Video</p>
        {lesson.video ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="min-w-0 break-all text-ink">{`${lesson.video.name} · ${readableSize(lesson.video.bytes)}`}</span>
            <button
              type="button"
              className={`${small} font-bold`}
              disabled={busy || uploading !== null}
              onClick={async () => {
                const answer = await run({ action: "edit", op: "media-remove", lessonId: lesson.id, pathname: lesson.video!.pathname });
                if (answer.ok) toast("Video removed.");
              }}
            >
              Remove video
            </button>
            {streamed ? (
              <p className={`w-full text-sm ${streamed === "failed" ? "font-semibold text-danger" : "text-ink-mute"}`} role="status">
                {STREAM_WORDS[streamed]}
              </p>
            ) : null}
            {streamed === "ready" || streamed === "working" ? (
              <Captions lessonId={lesson.id} pathname={lesson.video.pathname} busy={busy || uploading !== null} onError={onError} />
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-sm text-ink-mute">{`MP4, MOV or WebM, up to ${maxFileLabel()}. Upright phone videos stay upright.`}</p>
        )}
        <label className="btn btn-secondary btn-sm mt-2 cursor-pointer">
          {lesson.video ? "Replace the video" : "Upload a video"}
          <input
            type="file"
            accept={VIDEO_TYPES.join(",")}
            className="sr-only"
            disabled={busy || uploading !== null}
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = "";
              if (chosen) upload("video", chosen);
            }}
          />
        </label>
        {uploading?.kind === "video" ? (
          <p className="mt-2 text-sm text-ink-soft" role="status">{`Uploading… ${Math.round(uploading.percent)}%`}</p>
        ) : null}
      </div>

      <div>
        <label htmlFor={`${prefix}-text`} className="field-label">Text</label>
        {text === null ? (
          <div className="mt-2">
            <button type="button" className="btn btn-secondary btn-sm" disabled={loadingText} onClick={loadText}>
              {lesson.hasBody ? "Edit the text" : "Write text for this lesson"}
            </button>
          </div>
        ) : (
          <form
            className="mt-2"
            onSubmit={async (event) => {
              event.preventDefault();
              const answer = await run({ action: "body", lessonId: lesson.id, text });
              if (answer.ok) {
                setSavedText(text);
                toast("Lesson text saved.");
              }
            }}
          >
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
              <div className="min-w-0">
                <textarea
                  id={`${prefix}-text`}
                  rows={12}
                  className="field min-h-48"
                  maxLength={MAX_BODY_LENGTH}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <p className="mt-1 text-sm text-ink-mute">
                  {`Blank lines make paragraphs, lines starting with "- " make a list, and web addresses become links. ${MAX_BODY_LENGTH - text.length} characters left.`}
                </p>
              </div>
              {look ? (
                <>
                  {/* Beside the text on a wide screen; on a narrow one, folded. */}
                  <div className="hidden xl:block">{lessonPreview(text, look)}</div>
                  <details className="xl:hidden">
                    <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-ink underline underline-offset-4">See it as students see it</summary>
                    <div className="mt-2">{lessonPreview(text, look)}</div>
                  </details>
                </>
              ) : null}
            </div>
            <button type="submit" aria-busy={busy} disabled={busy} className="btn btn-secondary btn-sm mt-2">Save text</button>
          </form>
        )}
      </div>

      <div>
        <p className="field-label">Downloads</p>
        {lesson.files.length ? (
          <ul className="mt-2 space-y-1 text-sm">
            {lesson.files.map((file) => (
              <li key={file.pathname} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="min-w-0 break-all text-ink">{`${file.name} · ${readableSize(file.bytes)}`}</span>
                <button
                  type="button"
                  className={`${small} font-bold`}
                  aria-busy={busy}
                  disabled={busy}
                  onClick={async () => {
                    const answer = await run({ action: "edit", op: "media-remove", lessonId: lesson.id, pathname: file.pathname });
                    if (answer.ok) toast("Download removed.");
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-ink-mute">Worksheets, slides, templates: anything a student keeps.</p>
        )}
        {lesson.files.length < MAX_LESSON_FILES ? (
          <label className="btn btn-secondary btn-sm mt-2 cursor-pointer">
            Add a download
            <input
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              className="sr-only"
              disabled={busy || uploading !== null}
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                e.target.value = "";
                if (chosen) upload("file", chosen);
              }}
            />
          </label>
        ) : null}
        {uploading?.kind === "file" ? (
          <p className="mt-2 text-sm text-ink-soft" role="status">{`Uploading… ${Math.round(uploading.percent)}%`}</p>
        ) : null}
      </div>

      {/* A lesson is finished by a quiz or by an assignment (lib/assignment-rules.ts), never by both. */}
      {lesson.task ? null : <QuizEditor productId={productId} lessonId={lesson.id} setup={lesson.quiz} onCourse={onCourse} />}
      <TaskEditor productId={productId} lessonId={lesson.id} setup={lesson.task ?? null} hasQuiz={Boolean(lesson.quiz)} onCourse={onCourse} />

      <div className="border-t border-line pt-4">
        {removing ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-ink-soft">{lesson.task ? "Remove this lesson with its video, text, downloads and the work handed in for its assignment?" : "Remove this lesson with its video, text and downloads?"}</span>
            <button
              type="button"
              aria-busy={busy} disabled={busy}
              className="btn btn-secondary btn-sm"
              onClick={async () => {
                const answer = await run({ action: "edit", op: "lesson-remove", lessonId: lesson.id });
                if (answer.ok) {
                  onRemoved();
                  toast("Lesson removed.");
                }
              }}
            >
              Yes, remove it
            </button>
            <button type="button" className={`${small} font-bold`} onClick={() => setRemoving(false)}>Keep it</button>
          </div>
        ) : (
          <button type="button" className="text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger" onClick={() => setRemoving(true)}>
            Remove lesson
          </button>
        )}
      </div>
    </div>
  );
}

/** Taking one student off the course, or letting them back on. */
/**
 * Captions for a lesson's video kept by the video service: the languages it
 * has them in, and a way to add or take away one (app/api/store/stream/captions).
 *
 * The file is read here, as text, and the same rules that the server holds
 * it to are met before it is sent (lib/captions.ts), so a file that is not
 * captions is refused without a wait.
 */
function Captions({
  lessonId,
  pathname,
  busy,
  onError,
}: {
  lessonId: string;
  pathname: string;
  busy: boolean;
  onError: (message: string | null) => void;
}) {
  const streams = useContext(Streams);
  const tracks = streams.captions[pathname] ?? [];
  const [lang, setLang] = useState("en");
  const [working, setWorking] = useState(false);

  async function send(payload: Record<string, unknown>, done: string) {
    onError(null);
    setWorking(true);
    try {
      const response = await fetch("/api/store/stream/captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId, ...payload }),
      });
      const data = (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as { ok?: boolean; error?: string; captions?: CaptionTrack[] };
      if (data.ok && data.captions) {
        streams.captioned(pathname, data.captions);
        toast(done);
      } else {
        onError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
      }
    } catch {
      onError(MESSAGES.server_error);
    } finally {
      setWorking(false);
    }
  }

  async function add(chosen: File) {
    if (chosen.size > MAX_CAPTION_BYTES) return onError(MESSAGES.caption_too_big);
    const words = await chosen.text().catch(() => "");
    await send({ action: "add", lang, text: words }, "Captions added.");
  }

  const selectId = `captions-${lessonId}`;
  return (
    <div className="w-full">
      <p id={captionsAnchor(lessonId)} tabIndex={-1} className="field-label">Captions</p>
      {tracks.length ? (
        <ul className="mt-2 space-y-1 text-sm">
          {tracks.map((track) => (
            <li key={track.lang} className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-ink">{track.label}</span>
              <button
                type="button"
                className={`${small} font-bold`}
                disabled={busy || working}
                aria-label={`Remove the ${track.label} captions`}
                onClick={() => send({ action: "remove", lang: track.lang }, "Captions removed.")}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-ink-mute">
          None yet. Have them written by AI below, or upload a .vtt or .srt file, and the player shows a captions button.
        </p>
      )}
      {(streams.writing[pathname] ?? []).length ? (
        <p className="mt-2 text-sm text-ink" role="status" data-captions-writing>
          {`Being written by AI: ${(streams.writing[pathname] ?? []).map((code) => CAPTION_LANGUAGES.find((l) => l.code === code)?.label ?? code).join(", ")}. Most lessons take a few minutes; they appear here when they are done.`}
        </p>
      ) : streams.auto.can ? (
        <AutoCaptions lessonId={lessonId} pathname={pathname} have={tracks.map((t) => t.lang)} busy={busy || working} onError={onError} />
      ) : null}
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label htmlFor={selectId} className="block">
          <span className="sr-only">Captions language</span>
          <select id={selectId} className="field" value={lang} disabled={busy || working} onChange={(e) => setLang(e.target.value)}>
            {CAPTION_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>{language.label}</option>
            ))}
          </select>
        </label>
        <label className="btn btn-secondary btn-sm cursor-pointer" aria-busy={working}>
          {tracks.some((track) => track.lang === lang) ? "Replace these captions" : "Add captions"}
          <input
            type="file"
            accept=".vtt,.srt,text/vtt"
            className="sr-only"
            disabled={busy || working}
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = "";
              if (chosen) add(chosen);
            }}
          />
        </label>
      </div>
    </div>
  );
}

/**
 * Captions written by AI (lib/auto-captions.ts): the language spoken in the
 * video, up to two more to translate into, and the price, read from the
 * video's length, before anything is charged.
 */
function AutoCaptions({
  lessonId,
  pathname,
  have,
  busy,
  onError,
}: {
  lessonId: string;
  pathname: string;
  have: string[];
  busy: boolean;
  onError: (message: string | null) => void;
}) {
  const streams = useContext(Streams);
  const free = CAPTION_LANGUAGES.filter((l) => !have.includes(l.code));
  const [open, setOpen] = useState(false);
  const [spoken, setSpoken] = useState(free.some((l) => l.code === streams.auto.spoken) ? streams.auto.spoken : free[0]?.code ?? "en");
  const [also, setAlso] = useState<string[]>([]);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [working, setWorking] = useState(false);

  async function call(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch("/api/store/stream/captions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lessonId, ...payload }),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Record<string, unknown>;
  }

  async function show() {
    onError(null);
    setWorking(true);
    const data: Record<string, unknown> = await call({ action: "quote" }).catch(() => ({ ok: false, error: "server_error" }));
    setWorking(false);
    if (data.ok && typeof data.minutes === "number") {
      setMinutes(data.minutes);
      setOpen(true);
    } else onError(MESSAGES[String(data.error ?? "")] ?? MESSAGES.server_error);
  }

  async function order() {
    onError(null);
    setWorking(true);
    const data: Record<string, unknown> = await call({ action: "auto", spoken, also: also.filter((code) => code !== spoken) }).catch(() => ({ ok: false, error: "server_error" }));
    setWorking(false);
    if (data.ok && Array.isArray(data.writing)) {
      streams.wrote(pathname, (data.writing as unknown[]).filter((code): code is string => typeof code === "string"));
      setOpen(false);
      toast(`Charged ${dollars(Number(data.cents) || 0)}. The captions are being written.`);
    } else onError(MESSAGES[String(data.error ?? "")] ?? MESSAGES.server_error);
  }

  const languages = [spoken, ...also.filter((code) => code !== spoken)];
  const cents = minutes === null ? 0 : autoCaptionCents(minutes * 60, languages.length);
  if (!free.length) return null;
  return (
    <div className="mt-3 rounded-[var(--r-sm)] bg-sand p-3" data-auto-captions>
      {!open ? (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || working} aria-busy={working} onClick={() => void show()}>
          Write captions with AI
        </button>
      ) : (
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm text-ink-soft">Language spoken in the video</span>
            <select className="field mt-1" value={spoken} disabled={busy || working} onChange={(e) => setSpoken(e.target.value)}>
              {free.map((language) => (
                <option key={language.code} value={language.code}>{language.label}</option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend className="text-sm text-ink-soft">{`Also translated into (up to ${MAX_AUTO_LANGUAGES - 1}, optional)`}</legend>
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {free
                .filter((language) => language.code !== spoken)
                .map((language) => {
                  const checked = also.includes(language.code);
                  return (
                    <label key={language.code} className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy || working || (!checked && also.filter((code) => code !== spoken).length >= MAX_AUTO_LANGUAGES - 1)}
                        onChange={(e) => setAlso((now) => (e.target.checked ? [...now, language.code] : now.filter((code) => code !== language.code)))}
                      />
                      <span>{language.label}</span>
                    </label>
                  );
                })}
            </div>
          </fieldset>
          <p className="text-sm text-ink" data-auto-price>
            {`${minutes} ${minutes === 1 ? "minute" : "minutes"} of video × ${languages.length} ${languages.length === 1 ? "language" : "languages"} × ${dollars(CENTS_PER_MINUTE)} = ${dollars(cents)}${cents === MIN_CENTS && (minutes ?? 0) * languages.length * CENTS_PER_MINUTE < MIN_CENTS ? ` (the least one order is)` : ""}, charged now to the card your plan is paid with. Anything not delivered within ${GIVE_UP_HOURS} hours is refunded.`}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || working} aria-busy={working} onClick={() => void order()}>
              {`Write them for ${dollars(cents)}`}
            </button>
            <button type="button" className={`${small} font-bold`} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function StudentAccess({ productId, email, blocked }: { productId: string; email: string; blocked: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-busy={busy} disabled={busy}
      className="whitespace-nowrap text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep disabled:opacity-40"
      onClick={async () => {
        setBusy(true);
        const answer = await post({ id: productId, action: "block", email, blocked: !blocked });
        setBusy(false);
        if (answer.ok) toast(blocked ? "Access restored." : "Access removed.");
        router.refresh();
      }}
    >
      {blocked ? "Let back in" : "Remove access"}
    </button>
  );
}

/** Certificates of completion for this course: on or off. */
export function CertificateSwitch({ productId, on }: { productId: string; on: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold text-ink">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand"
          onChange={async (event) => {
            const next = event.target.checked;
            setBusy(true);
            setError(null);
            const answer = await post({ id: productId, action: "cert", on: next });
            setBusy(false);
            if (!answer.ok) {
              setError(problem(answer));
              return;
            }
            toast(next ? "Certificates are on." : "Certificates are off.");
            router.refresh();
          }}
        />
        Give a certificate to every student who finishes
      </label>
      {error ? (
        <p className="notice notice-error mt-2" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Withdrawing one certificate: its page then says so, and the student may issue it again. */
export function WithdrawCertificate({ productId, certificate }: { productId: string; certificate: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="whitespace-nowrap text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger" onClick={() => setAsking(true)}>
        Withdraw
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <button
        type="button"
        aria-busy={busy}
        disabled={busy}
        className="btn btn-secondary btn-sm"
        onClick={async () => {
          setBusy(true);
          const answer = await post({ id: productId, action: "withdraw", certificate });
          setBusy(false);
          if (answer.ok) toast("Certificate withdrawn.");
          setAsking(false);
          router.refresh();
        }}
      >
        Yes, withdraw it
      </button>
      <button type="button" className={`${small} font-bold`} onClick={() => setAsking(false)}>
        Keep it
      </button>
    </span>
  );
}

/** Gives a student back their tries on every quiz they have not passed. */
export function GiveTriesBack({ productId, email }: { productId: string; email: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-busy={busy}
      disabled={busy}
      className="whitespace-nowrap text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep disabled:opacity-40"
      onClick={async () => {
        setBusy(true);
        const answer = await post({ id: productId, action: "retries", email });
        setBusy(false);
        if (answer.ok) toast("Quiz tries given back.");
      }}
    >
      Give quiz tries back
    </button>
  );
}


/**
 * The course's start date: the one thing that makes it a cohort.
 *
 * A date here moves every module's clock off each student's joining day and
 * onto this one, so the whole room opens week three on the same morning. No
 * date, and the course stays what it was: everyone in week one on their own
 * first day, whenever that is.
 *
 * The date is picked as a day and sent as the second that day begins in the
 * creator's own zone, because "the 4th" starts at a different moment in
 * Auckland and in Los Angeles, and the person running the course is the one
 * who decides which. What the student then sees is that moment shown in
 * their zone, which is the honest answer to "when does this open for me".
 */
export function CourseStart({ productId, startsAt }: { productId: string; startsAt: number | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A date input wants "YYYY-MM-DD" in the viewer's own zone.
  const asDay = (seconds: number) => {
    const d = new Date(seconds * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const [day, setDay] = useState(startsAt === null ? "" : asDay(startsAt));

  async function send(at: number | null) {
    setBusy(true);
    setError(null);
    const answer = await post({ id: productId, action: "start", at });
    setBusy(false);
    if (!answer.ok) {
      setError(answer.error === "start" ? "That date is outside what a course start can be." : problem(answer));
      return;
    }
    toast(at === null ? "This course has no fixed start." : "The start date is set.");
    router.refresh();
  }

  return (
    <div>
      <label className="field-label" htmlFor={`start-${productId}`}>
        The day this course begins
      </label>
      <p className="field-hint mt-1">
        Leave it empty and each student starts on the day they join, which is how this course works now. Set a date and
        everyone moves through it together from that morning: module one opens then, and a module set to open after seven
        days opens seven days after that date for the whole room at once. Somebody who joins later finds everything up to
        that moment already open.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          id={`start-${productId}`}
          type="date"
          value={day}
          disabled={busy}
          className="field w-auto"
          onChange={(event) => setDay(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || !day}
          onClick={() => {
            // Midnight on the chosen day, in this browser's own zone.
            const [y, m, d] = day.split("-").map(Number);
            if (!y || !m || !d) return;
            void send(Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000));
          }}
        >
          {busy ? "Saving…" : startsAt === null ? "Make it a cohort" : "Change the date"}
        </button>
        {startsAt !== null ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => {
              setDay("");
              void send(null);
            }}
          >
            Remove the date
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="notice notice-error mt-2" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
