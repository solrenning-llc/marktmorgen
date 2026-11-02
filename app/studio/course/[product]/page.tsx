import { CourseCommentsStudio, type StudioComment } from "@/components/course-comments-studio";
import { commentsOn, markSeen, recentComments } from "@/lib/lesson-comments";
import { CREATOR_AUTHOR, commentClock } from "@/lib/lesson-comments-rules";
import type { Metadata } from "next";
import { aiAvailableFor, aiLeft } from "@/lib/ai";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { storeFolder } from "@/lib/store";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { lessonCount, lessonsInOrder, readCourse } from "@/lib/course";
import { captionsAnchor, lessonCaptionCheck } from "@/lib/course-access-check";
import { CourseAccessCheck } from "@/components/course-access-check";
import { emailKey, studentEmail, studentsOf } from "@/lib/learn";
import { canSellProduct } from "@/lib/store-checkout";
import { passedFor } from "@/lib/quiz";
import { certificatesFor } from "@/lib/certificate";
import {
  CertificateSwitch, CourseStart,
  CourseEditor,
  GiveTriesBack,
  StudentAccess,
  WithdrawCertificate,
} from "@/components/course-editor";
import { readListing } from "@/lib/catalog";
import { isStreamConfigured, streamCaptions, streamStates } from "@/lib/stream";
import { autoRefundsOwed, autoWriting } from "@/lib/auto-captions";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { isBillingConfigured } from "@/lib/billing";
import { can } from "@/lib/team-roles";
import { parseLanguage } from "@/lib/store-language";
import { CourseWorkStudio, type StudioWork } from "@/components/course-work-studio";
import { submissionsOf, waitingWork } from "@/lib/assignment";


export const metadata: Metadata = {
  title: "Your course — Marktmorgen",
  robots: { index: false, follow: false },
};

function day(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Where a creator builds a course: modules, lessons, and who is taking it. */
export default async function StudioCoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ product: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { product: productId } = await params;
  const query = await searchParams;
  // Which store, and whether this person's role there has "products" (lib/studio-route.ts).
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "products");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const product = await readListing(store, productId);
  if (!product?.course) redirect(studioPath(store));
  const course = await readCourse(product.course.id);
  if (!course) redirect(studioPath(store));
  const folder = await storeFolder(view.ref);
  // Where each lesson video kept by the video service stands (lib/stream.ts).
  const videoPaths = lessonsInOrder(course).flatMap(({ lesson }) => (lesson.video ? [lesson.video.pathname] : []));
  const streams = await streamStates(videoPaths).catch(() => ({}));
  // And the languages each one has captions in.
  const captions = await streamCaptions(videoPaths).catch(() => ({}));
  // And those being written by AI (lib/auto-captions.ts), which only somebody
  // who may spend on the plan's card, on a store with a plan, may ask for.
  const writing = await autoWriting(videoPaths).catch(() => ({}));
  // Refunds for AI captions Stripe has not confirmed yet, shown to whoever may see the plan's card.
  const owedRows: Awaited<ReturnType<typeof autoRefundsOwed>> = can(view.role, "billing") ? await autoRefundsOwed(folder).catch(() => []) : [];
  const autoCan =
    can(view.role, "billing") && store.subscriptionActive && Boolean(store.subscriptionId && store.stripeCustomerId) && isBillingConfigured() && isStreamConfigured();
  const { students, total } = await studentsOf(course, 500);
  const lessons = lessonCount(course);
  const finished = students.filter((s) => lessons > 0 && s.done >= lessons).length;
  const started = students.filter((s) => s.done > 0).length;
  const selling = canSellProduct(store, product);
  const quizLessons = lessonsInOrder(course).filter(({ lesson }) => lesson.quiz).map(({ lesson }) => lesson.id);
  const passed = quizLessons.length ? await passedFor(course.id, students.map((s) => emailKey(s.email))) : [];
  const certificates = await certificatesFor(course.id);
  const standing = certificates.list.filter((c) => !c.withdrawnAt).length;
  // The newest comments under the lessons, marked new since this page last showed them.
  const [talking, recent] = await Promise.all([commentsOn(course.id), recentComments(course.id, 50)]);
  await markSeen(course.id);
  const titles = new Map(lessonsInOrder(course).map(({ lesson }) => [lesson.id, lesson.title]));
  const aiState = aiAvailableFor(store) ? { on: true, left: await aiLeft(store).catch(() => 0) } : { on: false, left: 0 };
  // Work handed in for the course's assignments (lib/assignment.ts): what is waiting, or everything.
  const hasTasks = lessonsInOrder(course).some(({ lesson }) => lesson.task);
  const showingWork = query.work === "all" ? "all" : "waiting";
  const work = hasTasks ? await waitingWork(course.id, 50, showingWork === "all") : { rows: [], total: 0 };
  const [handed, addresses] = await Promise.all([
    submissionsOf(course.id, work.rows),
    Promise.all(work.rows.map((row) => studentEmail(course.id, row.who).catch(() => null))),
  ]);
  const workRows: StudioWork[] = work.rows.flatMap((row, i) => {
    const submission = handed[i];
    const title = titles.get(row.lessonId);
    return submission && title !== undefined ? [{ lessonId: row.lessonId, lessonTitle: title, who: row.who, email: addresses[i] ?? "", submission }] : [];
  });
  const byId = new Map(recent.comments.map((c) => [c.id, c]));
  const shownComments: StudioComment[] = recent.comments
    .filter((c) => titles.has(c.lesson))
    .map((c) => {
      const parent = c.parent ? byId.get(c.parent) : undefined;
      return {
        id: c.id,
        lessonId: c.lesson,
        lessonTitle: titles.get(c.lesson) ?? "",
        name: c.name,
        fromCreator: c.by === CREATOR_AUTHOR,
        text: c.text,
        at: c.at,
        hidden: c.hidden,
        answerTo: c.parent ? (parent ? (parent.by === CREATOR_AUTHOR ? store.name : parent.name) : "") : null,
        parentId: c.parent,
        fresh: c.at > recent.seen && c.by !== CREATOR_AUTHOR,
      };
    });

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={view.role}
        stores={view.stores}
        owned={view.owned}
        action={{ href: `${studioPath(store)}#products`, label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>

      <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
        <p className="eyebrow">Course</p>
        <h1 className="t-h2 mt-3 break-words">{product.title}</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          Modules hold lessons. A lesson can have a video, text, downloads, a link, and a quiz or an assignment, and any lesson can be a
          free preview on your store. A module can open a number of days after each student joins, and they get an
          email the day it does.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-4 text-sm font-bold">
          {/* The course opens whole only for the store's owner (lib/learn.ts); a team member would be asked to buy it. */}
          {view.role === "owner" ? (
            <Link href={`/@${store.handle}/course/${product.id}`} className="text-ink-soft underline underline-offset-4 hover:text-violet-deep">
              See it as a student does
            </Link>
          ) : null}
          <span className="text-ink-mute">
            {selling
              ? "On sale on your store."
              : product.hidden
                ? "Hidden from your store. Publish it from your products in the studio when it is ready."
                : lessons === 0
                ? "Add the first lesson and it can go on sale."
                : "Not on sale yet: your store needs Stripe connected and a running subscription."}
          </span>
        </div>

        {owedRows.length ? (
          <section aria-labelledby="captions-refunds" className="mt-5 rounded-2xl border border-line bg-paper p-4" data-captions-refunds>
            <h2 id="captions-refunds" className="text-base font-bold text-ink">
              Refunds for AI captions not confirmed yet
            </h2>
            <ul className="mt-2 space-y-1 text-sm text-ink">
              {owedRows.map((row) => (
                <li key={row.id}>
                  {row.stuck
                    ? `A refund of $${(row.cents / 100).toFixed(2)} for AI captions was not confirmed by Stripe, and we have stopped checking it on our own. Write to ${SUPPORT_EMAIL} about it.`
                    : `A refund of $${(row.cents / 100).toFixed(2)} for AI captions was asked for, and Stripe has not confirmed it yet. We check it again on our own; you do not need to do anything.`}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <CourseAccessCheck
          check={lessonCaptionCheck(course, streams, captions, writing)}
          productId={product.id}
          hrefOf={(id) => `${studioPath(store, `lesson=${encodeURIComponent(id)}`, `course/${product.id}`)}#${captionsAnchor(id)}`}
          canWrite={autoCan}
          canReupload={isStreamConfigured()}
        />
        <CourseEditor
          productId={product.id}
          openFirst={typeof query.lesson === "string" && lessonsInOrder(course).some(({ lesson }) => lesson.id === query.lesson) ? query.lesson : null}
          initial={course}
          folder={folder}
          streams={streams}
          captions={captions}
          writing={writing}
          auto={{ can: autoCan, spoken: parseLanguage(store.language) }}
          title={product.title}
          ai={aiState}
          look={store.look}
          language={parseLanguage(store.language)}
        />

        {hasTasks ? (
          <CourseWorkStudio
            productId={product.id}
            rows={workRows}
            total={work.total}
            showing={showingWork}
            hrefs={{ waiting: `${studioPath(store, "", `course/${product.id}`)}#work`, all: `${studioPath(store, "work=all", `course/${product.id}`)}#work` }}
            ai={aiState}
          />
        ) : null}

        <CourseCommentsStudio
          productId={product.id}
          storeName={store.name}
          initialOn={talking}
          initial={shownComments}
          lessonHref={view.role === "owner" ? `/@${store.handle}/course/${product.id}` : null}
          now={commentClock()}
        />

        <section className="card mt-8 p-6 sm:p-8" aria-labelledby="certificate-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="certificate-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Certificate of completion</h2>
            <span className={`tag ${course.certificate ? "tag-live" : ""}`}>{course.certificate ? "On" : "Off"}</span>
          </div>
          <p className="mt-2 max-w-2xl text-ink-soft">
            A student who has marked every lesson done, and passed every quiz that has to be passed, types their name and
            gets a certificate they can print or save as a PDF. It carries the name as they typed it, the course title,
            your name and the date, and it has an address of its own that anyone can open to check it is real.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
            <CourseStart productId={product.id} startsAt={course.startsAt} />
            <CertificateSwitch productId={product.id} on={course.certificate} />
            {course.certificate ? (
              <Link
                href={`/@${store.handle}/certificate/sample?product=${product.id}`}
                className="text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep"
              >
                See a sample
              </Link>
            ) : null}
          </div>

          <h3 className="mt-7 font-semibold text-ink">{`Completions \u00b7 ${standing} ${standing === 1 ? "certificate" : "certificates"} issued`}</h3>
          {certificates.list.length === 0 ? (
            <p className="mt-3 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">
              {course.certificate
                ? "Nobody has finished yet. When a student does and asks for their certificate, it is listed here."
                : "Switch certificates on and each student who finishes is listed here with theirs."}
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Certificates issued, one row each">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-ink-mute">
                    <th scope="col" className="py-2 pr-3 font-semibold">Name on it</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">Student</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">Issued</th>
                    <th scope="col" className="py-2 font-semibold"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {certificates.list.map((certificate) => (
                    <tr key={certificate.id} className="border-t border-line align-top">
                      <td className={`max-w-[14rem] break-words py-2 pr-3 font-semibold ${certificate.withdrawnAt ? "text-ink-mute line-through" : "text-ink"}`}>
                        {certificate.name}
                      </td>
                      <td className="max-w-[14rem] break-all py-2 pr-3">{certificate.email}</td>
                      <td className="whitespace-nowrap py-2 pr-3">
                        {day(certificate.issuedAt)}
                        {certificate.withdrawnAt ? <span className="block text-xs text-ink-mute">{`Withdrawn ${day(certificate.withdrawnAt)}`}</span> : null}
                      </td>
                      <td className="py-2">
                        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                          <Link
                            href={`/@${store.handle}/certificate/${certificate.id}`}
                            className="whitespace-nowrap text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep"
                          >
                            Open
                          </Link>
                          {certificate.withdrawnAt ? null : <WithdrawCertificate productId={product.id} certificate={certificate.id} />}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card mt-8 p-6 sm:p-8" aria-labelledby="students-title">
          <h2 id="students-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Students</h2>
          <p className="mt-2 text-ink-soft">
            Everyone who has opened the course since buying it, with how many lessons they marked done. Buyers are
            read from your own Stripe account; this list is what they did here.
          </p>
          <div className="mt-5 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-[var(--r-sm)] bg-sand p-4">
              <p className="text-2xl font-semibold tabular-nums">{total}</p>
              <p className="text-sm text-ink-soft">opened it</p>
            </div>
            <div className="rounded-[var(--r-sm)] bg-sand p-4">
              <p className="text-2xl font-semibold tabular-nums">{started}</p>
              <p className="text-sm text-ink-soft">finished a lesson</p>
            </div>
            <div className="rounded-[var(--r-sm)] bg-sand p-4">
              <p className="text-2xl font-semibold tabular-nums">{finished}</p>
              <p className="text-sm text-ink-soft">finished it all</p>
            </div>
          </div>
          {students.length === 0 ? (
            <p className="mt-5 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">Nobody has opened it yet.</p>
          ) : (
            <div className="mt-5 overflow-x-auto" tabIndex={0} role="region" aria-label="Students, one row each">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-ink-mute">
                    <th scope="col" className="py-2 pr-3 font-semibold">Student</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">Joined</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">Done</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">Last here</th>
                    {quizLessons.length ? <th scope="col" className="py-2 pr-3 font-semibold">Quizzes passed</th> : null}
                    <th scope="col" className="py-2 font-semibold"><span className="sr-only">Access</span></th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((student, i) => (
                    <tr key={student.email} className="border-t border-line align-top">
                      <td className="max-w-[14rem] break-all py-2 pr-3">{student.email}</td>
                      <td className="whitespace-nowrap py-2 pr-3">{day(student.since)}</td>
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{`${Math.min(student.done, lessons)} of ${lessons}`}</td>
                      <td className="whitespace-nowrap py-2 pr-3">{day(student.lastSeen)}</td>
                      {quizLessons.length ? (
                        <td className="whitespace-nowrap py-2 pr-3 tabular-nums">
                          {`${quizLessons.filter((id) => passed[i]?.has(id)).length} of ${quizLessons.length}`}
                        </td>
                      ) : null}
                      <td className="py-2">
                        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                          <StudentAccess productId={product.id} email={student.email} blocked={student.blocked} />
                          {quizLessons.some((id) => !passed[i]?.has(id)) ? <GiveTriesBack productId={product.id} email={student.email} /> : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
      </StudioStorePin>
    </div>
  );
}
