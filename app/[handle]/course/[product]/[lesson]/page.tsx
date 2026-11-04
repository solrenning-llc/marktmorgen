import { countDay } from "@/lib/day-visit";
import { windowId } from "@/lib/allowance-window";
import { isResting } from "@/lib/traffic";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { linkHost } from "@/lib/product-link";
import { readableSize } from "@/lib/product-file";
import { findLesson, isOpen, lessonsInOrder, readBody, readCourse } from "@/lib/course";
import { courseAccess, doneLessons, emailKey, lessonVideo } from "@/lib/learn";
import { type Attempt, attemptOf, heldBack, passedQuizzes, readQuizFor, studentQuiz } from "@/lib/quiz";
import { CourseOutline } from "@/components/course-outline";
import { LessonText } from "@/components/lesson-text";
import { LessonQuiz } from "@/components/lesson-quiz";
import { LessonTask } from "@/components/lesson-task";
import { readTaskFor, submissionOf } from "@/lib/assignment";
import type { Submission } from "@/lib/assignment-rules";
import { readListing } from "@/lib/catalog";
import { LessonComments } from "@/components/lesson-comments";
import { commenterName, commentsOn, lessonComments } from "@/lib/lesson-comments";
import { CREATOR_AUTHOR, SHOWN_THREADS, commentClock, threadsFor } from "@/lib/lesson-comments-rules";
import { videoLimitFor } from "@/lib/plan-standing";
import { speech } from "@/lib/buyer-words";
import { type CoursesWords, coursesWords } from "@/lib/buyer-words/courses";
import type { LanguageCode } from "@/lib/store-language";
import { NewTab } from "@/components/new-tab";

type Params = {
  params: Promise<{ handle: string; product: string; lesson: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** The tab's title, in the store's language. */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  let language: unknown;
  try {
    const decoded = decodeURIComponent(handle);
    language = decoded.startsWith("@") ? (await storeForPage(normaliseHandle(decoded)))?.language : undefined;
  } catch {
    language = undefined;
  }
  return {
    title: coursesWords(language).metaLesson,
    robots: { index: false, follow: false },
  };
}

/**
 * A download's size, "1.5 MB", the way lib/product-file.ts readableSize says
 * it, in the store's language: its decimal comma, and French's "Mo".
 */
function sizeIn(language: LanguageCode, locale: string, w: CoursesWords, bytes: number): string {
  if (language === "en") return readableSize(bytes);
  const one = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const gb = 1024 * 1024 * 1024;
  if (bytes >= gb) {
    const size = bytes / gb;
    // "5 GB" rather than "5.0 GB", as readableSize says it.
    const whole = Number(size.toFixed(1)) % 1 === 0;
    return `${whole ? new Intl.NumberFormat(locale).format(Number(size.toFixed(1))) : one.format(size)} ${w.sizeUnits.gb}`;
  }
  if (bytes >= 1024 * 1024) return `${one.format(bytes / (1024 * 1024))} ${w.sizeUnits.mb}`;
  if (bytes >= 1024) return `${new Intl.NumberFormat(locale).format(Math.round(bytes / 1024))} ${w.sizeUnits.kb}`;
  return w.bytes(bytes, new Intl.NumberFormat(locale).format(bytes));
}

/** One lesson: its video, its text, its downloads, and the way on. */
export default async function LessonPage({ params, searchParams }: Params) {
  const { handle: raw, product: productId, lesson: lessonId } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const product = await readListing(store, productId);
  if (!product?.course) redirect(`/@${store.handle}`);
  const course = await readCourse(product.course.id);
  const base = `/@${store.handle}/course/${product.id}`;
  const found = course ? findLesson(course, lessonId) : null;
  if (!course || !found) redirect(base);
  const said = speech(store);
  const w = coursesWords(store.language);

  const access = await courseAccess(store, product, await cookies());
  const open = access.state === "open" && isOpen(course, found.unit, access.start);
  // A free preview is open to anyone; everything else to a student whose
  // module has opened.
  if (!open && !found.lesson.preview) redirect(base);

  const { lesson, unit } = found;
  const start = access.state === "open" ? access.start : null;
  const student = access.state === "open" && !access.learner.owner ? access.learner : null;
  const who = student ? emailKey(student.email) : "";
  // A student's day in a course is a visit to the store (lib/day-visit.ts).
  // Once the whole month's visits are used, a lesson rests too (lib/traffic-rules.ts).
  if (student && (await isResting(store, undefined, "buyer"))) redirect(`/@${store.handle}/resting`);
  if (student) await countDay(store);
  const [done, passed] = student
    ? await Promise.all([doneLessons(course.id, student.email), passedQuizzes(course.id, who)])
    : [new Set<string>(), new Set<string>()];
  // A quiz that has to be passed holds the lessons after it shut, for a student.
  const held = student ? heldBack(course, passed) : new Map<string, string>();
  const blocker = held.get(lesson.id);
  if (blocker && !lesson.preview) redirect(`${base}/${blocker}?held=1#${findLesson(course, blocker)?.lesson.task ? "task" : "quiz"}`);

  const query = await searchParams;
  const [body, video, quiz, attempt, task, work] = await Promise.all([
    lesson.hasBody ? readBody(course.id, lesson.id) : Promise.resolve(""),
    // A store with no plan that can be charged plays video for the hours
    // it has, and is paused past them (lib/plan-standing.ts).
    lesson.video ? lessonVideo(lesson.video, videoLimitFor(store), windowId(store), store) : Promise.resolve(null),
    lesson.quiz ? readQuizFor(course.id, lesson.id) : Promise.resolve(null),
    lesson.quiz && student ? attemptOf(course.id, lesson.id, who) : Promise.resolve<Attempt | null>(null),
    // An assignment, and what this student handed in for it (lib/assignment.ts).
    lesson.task ? readTaskFor(course.id, lesson.id) : Promise.resolve(null),
    lesson.task && student ? submissionOf(course.id, lesson.id, who) : Promise.resolve<Submission | null>(null),
  ]);
  const quizMode = access.state === "open" && access.learner.owner ? "owner" : student && open ? "student" : "visitor";
  // A student sees only the questions their try draws from a bank (lib/quiz.ts).
  const asked = quiz && attempt && quizMode === "student" ? studentQuiz(quiz, course.id, lesson.id, who, attempt) : null;
  // Comments are for the course's students and its creator; a visitor on a
  // free preview sees none of them.
  const reader = access.state === "open" && open ? (access.learner.owner ? CREATOR_AUTHOR : who) : null;
  const [talking, comments, myName] = reader
    ? await Promise.all([
        commentsOn(course.id),
        lessonComments(course.id, lesson.id),
        reader === CREATOR_AUTHOR ? Promise.resolve("") : commenterName(course.id, reader),
      ])
    : [false, [], ""];
  const threads = reader && talking ? threadsFor(comments, reader).slice(0, SHOWN_THREADS) : [];
  const mustPass = Boolean(student && quiz && lesson.quiz?.required && !passed.has(lesson.id));
  // Work to hand in, still holding the lessons after it shut.
  const mustHandIn = Boolean(student && task && lesson.task?.gate && !passed.has(lesson.id));

  const order = lessonsInOrder(course);
  const at = order.findIndex((entry) => entry.lesson.id === lesson.id);
  const reachable = (entry: (typeof order)[number]) =>
    entry.lesson.preview || (start !== null && isOpen(course, entry.unit, start) && !held.has(entry.lesson.id));
  const previous = order.slice(0, at).reverse().find(reachable) ?? null;
  const next = order.slice(at + 1).find(reachable) ?? null;
  const isDone = done.has(lesson.id);
  const moduleNumber = course.modules.findIndex((m) => m.id === unit.id) + 1;

  return (
    <div
      lang={said.lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-5xl px-4 py-8 sm:py-12">
        <p className="text-sm">
          <Link href={base} className="st-footer-link font-semibold">{product.title}</Link>
          <span className="st-muted">{w.crumb(moduleNumber, unit.title)}</span>
        </p>

        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <article className="st-card min-w-0 p-5 sm:p-8">
            <h1 className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">{lesson.title}</h1>
            {!open ? (
              <p className="st-muted mt-2 text-sm font-semibold">{w.freePreview}</p>
            ) : null}
            {query.held === "1" && mustPass ? (
              <p className="st-note mt-4 text-sm" role="status">
                <strong>{w.heldStrong}</strong>{` ${w.heldRest}`}
              </p>
            ) : null}
            {query.held === "1" && mustHandIn ? (
              <p className="st-note mt-4 text-sm" role="status">
                {task?.review ? <strong>{w.heldTaskReviewStrong}</strong> : <><strong>{w.heldTaskStrong}</strong>{` ${w.heldRest}`}</>}
              </p>
            ) : null}

            {lesson.video ? (
              video?.kind === "stream" ? (
                <div className="mt-6 overflow-hidden rounded-2xl bg-black">
                  {/* The video service's player (lib/stream.ts): it sends the
                      size the line can carry, so the video does not stop to
                      wait. The frame takes the video's own shape, so one
                      filmed upright stays upright, and is never taller than
                      three quarters of the screen. */}
                  <iframe
                    src={video.src}
                    title={lesson.title}
                    allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen"
                    allowFullScreen
                    referrerPolicy="strict-origin-when-cross-origin"
                    className="mx-auto block w-full"
                    style={{
                      aspectRatio: `${video.width} / ${video.height}`,
                      maxWidth: `calc(75vh * ${video.width} / ${video.height})`,
                      border: 0,
                    }}
                  />
                </div>
              ) : video?.kind === "file" ? (
                <div className="mt-6 overflow-hidden rounded-2xl bg-black">
                  {/* Vertical videos stay vertical: the player takes the
                      shape of the video instead of forcing it wide. */}
                  <video
                    src={video.src}
                    controls
                    playsInline
                    preload="metadata"
                    controlsList="nodownload"
                    className="mx-auto block max-h-[75vh] w-full object-contain"
                  />
                </div>
              ) : video?.kind === "preparing" ? (
                <p className="st-note mt-6" role="status">
                  <strong>{w.preparingStrong}</strong>{` ${w.preparingRest}`}
                </p>
              ) : video?.kind === "paused" ? (
                <p className="st-note mt-6" role="status">
                  <strong>{w.pausedStrong}</strong>{` ${w.pausedRest(store.name)}`}
                </p>
              ) : video?.kind === "failed" ? (
                <p className="st-note mt-6">{w.videoFailed(store.name)}</p>
              ) : (
                <p className="st-note mt-6">{w.videoNotLoaded}</p>
              )
            ) : null}

            {body ? (
              <div className="mt-6" style={{ color: "var(--st-text)" }}>
                <LessonText text={body} codeLabel={w.codeBlock} />
              </div>
            ) : null}

            {lesson.link ? (
              <a href={lesson.link} target="_blank" rel="noopener noreferrer nofollow" className="btn st-btn mt-6">
                {w.openSite(linkHost(lesson.link))}
              <NewTab language={store.language} /></a>
            ) : null}

            {lesson.files.length ? (
              <div className="mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }}>
                <p className="st-label">{w.downloads}</p>
                <ul className="mt-2 space-y-2">
                  {lesson.files.map((file, i) => (
                    <li key={file.pathname} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                      <a
                        href={`/api/store/course/file?h=${encodeURIComponent(store.handle)}&p=${product.id}&l=${lesson.id}&i=${i}`}
                        className="min-w-0 break-all font-semibold underline underline-offset-2"
                        style={{ color: "var(--st-text)" }}
                      >
                        {file.name}
                      </a>
                      <span className="st-muted">{sizeIn(said.lang.code, said.lang.locale, w, file.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {!lesson.video && !body && !lesson.link && lesson.files.length === 0 && !quiz && !task ? (
              <p className="st-muted mt-6">{w.emptyLesson}</p>
            ) : null}

            {quiz ? (
              <LessonQuiz
                quiz={asked?.quiz ?? quiz}
                attempt={attempt}
                waitSeconds={asked?.wait ?? 0}
                stale={query.quiz === "stale"}
                mode={quizMode}
                action="/api/store/course/quiz"
                hidden={{ handle: store.handle, product: product.id, lesson: lesson.id }}
                storeName={store.name}
                justMarked={query.quiz === "marked"}
                language={store.language}
              />
            ) : null}

            {task && lesson.task ? (
              <LessonTask
                prompt={task.prompt}
                setup={{ review: task.review, file: task.file }}
                initial={work}
                mode={quizMode}
                where={{ handle: store.handle, product: product.id, lesson: lesson.id }}
                storeName={store.name}
                language={store.language}
              />
            ) : null}

            <div className="mt-8 flex flex-wrap items-center gap-3 border-t pt-6" style={{ borderColor: "var(--st-line)" }}>
              {student && open && mustPass ? (
                <p className="st-muted text-sm font-semibold">{w.passAbove}</p>
              ) : student && open && lesson.task ? (
                // Done by handing the work in, or by its approval, never by a button.
                isDone ? <span className="text-sm font-semibold" style={{ color: "var(--st-text)" }}>{w.doneMark}</span> : null
              ) : student && open ? (
                <form action="/api/store/course/progress" method="post" className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="handle" value={store.handle} />
                  <input type="hidden" name="product" value={product.id} />
                  <input type="hidden" name="lesson" value={lesson.id} />
                  {isDone ? (
                    <>
                      <span className="text-sm font-semibold" style={{ color: "var(--st-text)" }}>{w.doneMark}</span>
                      <input type="hidden" name="done" value="0" />
                      <button type="submit" className="st-footer-link text-sm font-semibold">{w.markNotDone}</button>
                    </>
                  ) : (
                    <>
                      <input type="hidden" name="done" value="1" />
                      <input type="hidden" name="next" value={next?.lesson.id ?? ""} />
                      <button type="submit" className="btn st-btn">{next ? w.markDoneNext : w.markDone}</button>
                    </>
                  )}
                </form>
              ) : null}
              {next && (isDone || !student || !open || lesson.task) ? (
                <Link href={`${base}/${next.lesson.id}`} className="btn st-btn">{w.nextLesson}</Link>
              ) : null}
              {previous ? (
                <Link href={`${base}/${previous.lesson.id}`} className="st-footer-link text-sm font-semibold">{w.previousLesson}</Link>
              ) : null}
            </div>
          </article>

          <aside className="st-card h-fit p-5 sm:p-6 lg:row-span-2">
            <p className="st-label">{w.inThisCourse}</p>
            <div className="mt-3">
              <CourseOutline course={course} base={base} start={start} done={done} current={lesson.id} held={held} language={store.language} />
            </div>
            {!open ? (
              <Link href={base} className="btn st-btn btn-block mt-5">{w.getWhole}</Link>
            ) : null}
          </aside>

          {reader && talking ? (
            <div className="min-w-0 lg:col-start-1 lg:row-start-2">
              <LessonComments
                threads={threads}
                reader={reader}
                storeName={store.name}
                hidden={{ handle: store.handle, product: product.id, lesson: lesson.id }}
                myName={myName}
                notice={typeof query.c === "string" ? query.c : ""}
                now={commentClock()}
                language={store.language}
                namePlaceholder={said.w.namePlaceholder}
              />
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
