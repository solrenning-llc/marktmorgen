import { CourseCommentsStudio, type StudioComment } from "@/components/course-comments-studio";
import { commentsOn, markSeen } from "@/lib/lesson-comments";
import { CREATOR_AUTHOR, commentClock } from "@/lib/lesson-comments-rules";
import type { Metadata } from "next";
import { aiAvailableFor, aiLeft } from "@/lib/ai";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { storeFolder } from "@/lib/store";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { StudioEmptyState } from "@/components/empty-state";
import { productSegment } from "@/lib/product-slug";
import { lessonCount, lessonsInOrder, readCourse } from "@/lib/course";
import { captionsAnchor, lessonCaptionCheck } from "@/lib/course-access-check";
import { CourseAccessCheck } from "@/components/course-access-check";
import { canSellProduct } from "@/lib/store-checkout";
import { COURSE_TAB_PAGE, MAX_TAB_PAGES, MAX_WORK_PAGES, type CourseTab, VIDEO_BLOCK, certificatesTab, commentsTab, courseTab, studentsTab, tabCursor, tabPage, videosTab, workTab } from "@/lib/studio-course-tabs";
import { CertificateValidity } from "@/components/certificate-validity";
import {
  CertificateSwitch, CourseStart,
  CourseEditor,
  GiveTriesBack,
  StudentAccess,
  WithdrawCertificate,
} from "@/components/course-editor";
import { readListing, readTitles, visibleIds } from "@/lib/catalog";
import { CourseShelfStudio } from "@/components/course-shelf-studio";
import { templateById } from "@/lib/course-templates";
import { isStreamConfigured } from "@/lib/stream";
import { OWED_SHOWN, autoRefundsOwedPage } from "@/lib/auto-captions";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { isBillingConfigured } from "@/lib/billing";
import { can } from "@/lib/team-roles";
import { parseLanguage } from "@/lib/store-language";
import { CourseWorkStudio, type StudioWork } from "@/components/course-work-studio";
import { isUnreadSubmission } from "@/lib/assignment";


export const metadata: Metadata = {
  title: "Your course — Marktmorgen",
  robots: { index: false, follow: false },
};

/** The course page's tabs, in order, with the words of their links (issue #4304). */
const COURSE_TAB_LINKS: [CourseTab, string][] = [
  ["course", "Lessons"],
  ["videos", "Videos"],
  ["work", "Work handed in"],
  ["comments", "Comments"],
  ["students", "Students"],
  ["certificates", "Certificates"],
];

function day(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * A tab's pages (issue #4304): where this page of rows sits among all of them, and plain links to the pages
 * either side of it, each its own request. A link names what it opens ("Next 20 comments").
 */
function TabPager({ label, noun, page, size, shown, total, maxPages, href }: { label: string; noun: string; page: number; size: number; shown: number; total: number | null; maxPages: number; href: (page: number) => string }) {
  const first = (page - 1) * size + 1;
  const last = (page - 1) * size + shown;
  const more = total === null ? shown === size : last < total;
  if (page === 1 && !more) return null;
  return (
    <nav aria-label={label} className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      <p className="text-ink-soft">{shown ? `Showing ${first}–${last} of ${total === null ? `at least ${last}` : total}` : `Nothing on page ${page}`}</p>
      {page > 1 ? (
        <Link href={href(page - 1)} className="inline-block min-h-11 py-3 font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep">
          {`Previous ${size} ${noun}`}
        </Link>
      ) : null}
      {more && page < maxPages ? (
        <Link href={href(page + 1)} className="inline-block min-h-11 py-3 font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep">
          {`Next ${size} ${noun}`}
        </Link>
      ) : more ? (
        <p className="text-ink-soft">{`These are the last ${noun} this page can show at a time.`}</p>
      ) : null}
    </nav>
  );
}

/**
 * Pages read by cursor (issue #4304, unit C): a cursor through the set has no way back, so the links are the next
 * page and the first one, each its own request.
 */
function CursorPager({ label, noun, size, cursor, next, href }: { label: string; noun: string; size: number; cursor: string; next: string | null; href: (cursor: string) => string }) {
  if (cursor === "0" && next === null) return null;
  return (
    <nav aria-label={label} className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      {cursor !== "0" ? (
        <Link href={href("0")} className="inline-block min-h-11 py-3 font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep">
          {`First page of ${noun}`}
        </Link>
      ) : null}
      {next !== null ? (
        <Link href={href(next)} className="inline-block min-h-11 py-3 font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep">
          {`Next ${size} ${noun}`}
        </Link>
      ) : (
        <p className="text-ink-soft">{`That is every one of the ${noun}.`}</p>
      )}
    </nav>
  );
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
  const initialTemplate = typeof query.template === "string" ? templateById(query.template) : null;
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
  // One tab at a time (issue #4304, unit A): each tab is its own address and reads only what it shows, a page
  // at a time, so a load fits the STUDIO_PAGE_UNITS it is counted at (lib/studio-course-tabs.ts).
  const tab = courseTab(query.tab);
  const page = tabPage(query.page);
  const lessons = lessonCount(course);
  const selling = canSellProduct(store, product);
  const titles = new Map(lessonsInOrder(course).map(({ lesson }) => [lesson.id, lesson.title]));
  const hasTasks = lessonsInOrder(course).some(({ lesson }) => lesson.task);
  const onCourse = tab === "course";
  // Lesson videos (unit B): the lessons tab reads none; the editor reads one lesson's state, captions and AI
  // captions when it is opened, in a request of its own. The Videos tab checks a block of them for captions.
  const videos = tab === "videos" ? await videosTab(course, page) : null;
  // Refunds for AI captions Stripe has not confirmed yet, shown to whoever may see the plan's card.
  // A page of them (unit D): at most OWED_SHOWN read, with whether there are more; null when they could not be read.
  const owed = onCourse && can(view.role, "billing") ? await autoRefundsOwedPage(folder).catch(() => null) : { rows: [], more: false };
  const owedRows = owed?.rows ?? [];
  const autoCan =
    can(view.role, "billing") && store.subscriptionActive && Boolean(store.subscriptionId && store.stripeCustomerId) && isBillingConfigured() && isStreamConfigured();
  const aiState = (onCourse || tab === "work") && aiAvailableFor(store) ? { on: true, left: await aiLeft(store).catch(() => 0) } : { on: false, left: 0 };
  // The "More from" shelf (628 [HN4](b)): the store's listed products to pick from, the course left out, by name.
  // Null when the names could not be read: the section says so instead of an empty list (rule 24).
  const shelfTitles = onCourse ? await readTitles(store).catch(() => null) : null;
  const shelfOptions = shelfTitles ? visibleIds(store).filter((pid) => pid !== product.id && shelfTitles.has(pid)).map((pid) => ({ id: pid, title: shelfTitles.get(pid)! })) : [];
  const shelfSaved = shelfTitles ? (course.shelf ?? []).filter((pid) => shelfTitles.has(pid)).map((pid) => ({ id: pid, title: shelfTitles.get(pid)! })) : [];

  // Students: a page of them; null when they could not be read (rule 24), never "No students yet" or counts of 0.
  // By cursor (unit C): HSCAN has no order, so a page is sorted within itself and the page says so.
  const cursor = tabCursor(query.cursor);
  const studentsRead = tab === "students" ? await studentsTab(course, cursor) : null;
  const students = studentsRead?.students ?? [];
  const total = studentsRead?.total ?? 0;
  const quizLessons = studentsRead?.quizLessons ?? [];
  const passed = studentsRead?.passed ?? [];
  const finished = students.filter((s) => lessons > 0 && s.done >= lessons).length;
  const started = students.filter((s) => s.done > 0).length;

  // Certificates: a page of them; null when they could not be read.
  const certificates = tab === "certificates" ? await certificatesTab(course.id, cursor) : null;
  // Counted only when this one page held every certificate; otherwise the page says how many there are in all.
  const whole = certificates !== null && cursor === "0" && certificates.next === null && !certificates.tooBig;
  const standing = whole ? certificates.list.filter((c) => !c.withdrawnAt).length : null;

  // Work handed in for the course's assignments (lib/assignment.ts): what is waiting, or everything, a page of it.
  const showingWork = query.work === "all" ? "all" : "waiting";
  const work = tab === "work" && hasTasks ? await workTab(course.id, page, showingWork === "all") : { rows: [], handed: [], addresses: [], total: 0, unread: 0 };
  const workRows: StudioWork[] = work.rows.flatMap((row, i) => {
    const submission = work.handed[i];
    const title = titles.get(row.lessonId);
    return submission && !isUnreadSubmission(submission) && title !== undefined ? [{ lessonId: row.lessonId, lessonTitle: title, who: row.who, email: work.addresses[i] ?? "", submission }] : [];
  });
  // Work that is there but whose record does not read is said in the list, never left out of it (CX-123 rule 24).
  const unreadWork = work.rows.filter((row, i) => isUnreadSubmission(work.handed[i]) && titles.has(row.lessonId)).length;

  // The newest comments under the lessons, a page of them, marked new since this page last showed them.
  const [talking, recent] = tab === "comments" ? await Promise.all([commentsOn(course.id), commentsTab(course.id, page)]) : [false, { comments: [], fresh: 0, seen: 0 }];
  if (tab === "comments") await markSeen(course.id);
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
  const tabHref = (to: CourseTab, at = 1, extra = "") => `${studioPath(store, [`tab=${to}`, at > 1 ? `page=${at}` : "", extra].filter(Boolean).join("&"), `course/${product.id}`)}#tab-title`;

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
        <StudioTrail store={store} path={[{ label: "Products", href: `${studioPath(store)}#products` }]} here="Course" />
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

        <nav aria-label="Course sections" className="mt-8 border-b border-line">
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-bold">
            {COURSE_TAB_LINKS.map(([to, label]) => (
              <li key={to}>
                <Link
                  href={tabHref(to)}
                  aria-current={tab === to ? "page" : undefined}
                  className={`inline-block min-h-11 py-3 underline-offset-4 ${tab === to ? "border-b-2 border-violet-deep text-ink" : "text-ink-soft underline hover:text-violet-deep"}`}
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <h2 id="tab-title" tabIndex={-1} className="mt-6 text-lg font-semibold tracking-[-0.02em] text-ink">{COURSE_TAB_LINKS.find(([to]) => to === tab)?.[1]}</h2>
        {onCourse ? (
          <>
        {owed === null ? (
          <p role="status" className="notice mt-5">
            Refunds for AI captions could not be checked just now. Reload this page in a moment; this does not mean none are pending.
          </p>
        ) : null}
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
            {owed?.more ? (
              <p className="mt-2 text-sm text-ink">{`At least ${OWED_SHOWN} refunds for AI captions are pending; this page lists ${OWED_SHOWN} at a time. The rest are checked on our own all the same.`}</p>
            ) : null}
          </section>
        ) : null}
        <CourseEditor
          productId={product.id}
          initialTemplate={initialTemplate?.id ?? null}
          openFirst={typeof query.lesson === "string" && lessonsInOrder(course).some(({ lesson }) => lesson.id === query.lesson) ? query.lesson : null}
          initial={course}
          draft={product.hidden === true}
          folder={folder}
          streams={{}}
          captions={{}}
          writing={{}}
          auto={{ can: autoCan, spoken: parseLanguage(store.language) }}
          title={product.title}
          ai={aiState}
          look={store.look}
          language={parseLanguage(store.language)}
        />

        <section className="card mt-8 p-6 sm:p-8" aria-labelledby="shelf-title">
          <h2 id="shelf-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">More from your store</h2>
          <p className="mt-2 max-w-2xl text-ink-soft">
            Pick up to six of your other products to show your students on this course&apos;s front page, under the
            lessons. Each one shows its name, its short description and the price on its card, and links to its page.
            A student never sees what they already have from you, and sees nothing at all when that cannot be checked.
            Nothing shows inside a lesson.
          </p>
          {shelfTitles === null ? (
            <p role="status" className="notice mt-3">
              Your products could not be read just now. Reload this page in a moment; your shelf is unchanged.
            </p>
          ) : shelfOptions.length === 0 && shelfSaved.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">Publish another product first; then you can add it here.</p>
          ) : (
            <CourseShelfStudio productId={product.id} saved={shelfSaved} options={shelfOptions} />
          )}
        </section>

          </>
        ) : null}
        {tab === "videos" ? (
          <>
            {videos === null ? (
              <p role="status" className="notice mt-5">
                The lesson videos could not be checked just now. Reload this page in a moment; this does not mean they have no captions.
              </p>
            ) : videos.total === 0 ? (
              <p className="mt-5 text-ink-soft">This course has no lesson videos yet. Add one to a lesson on the Lessons tab, and its captions are checked here.</p>
            ) : (
              <>
                <CourseAccessCheck
                  check={lessonCaptionCheck(course, videos.states, videos.captions, videos.writing, videos.only)}
                  productId={product.id}
                  hrefOf={(id) => `${studioPath(store, `lesson=${encodeURIComponent(id)}`, `course/${product.id}`)}#${captionsAnchor(id)}`}
                  canWrite={autoCan}
                  canReupload={isStreamConfigured()}
                  scope={videos.pages > 1 ? `lesson videos ${videos.from}–${videos.to} of ${videos.total}` : undefined}
                />
                <TabPager label="Pages of lesson videos" noun="lesson videos" page={videos.page} size={VIDEO_BLOCK} shown={videos.to - videos.from + 1} total={videos.total} maxPages={videos.pages} href={(at) => tabHref("videos", at)} />
              </>
            )}
          </>
        ) : null}
        {tab === "work" ? (
          <>
        {hasTasks ? (
          <CourseWorkStudio
            productId={product.id}
            rows={workRows}
            unread={unreadWork}
            total={work.total}
            showing={showingWork}
            hrefs={{ waiting: tabHref("work"), all: tabHref("work", 1, "work=all") }}
            ai={aiState}
          />
        ) : null}
        {hasTasks ? (
          <TabPager label="Pages of work handed in" noun="pieces of work" page={page} size={COURSE_TAB_PAGE.work} shown={work.rows.length} total={work.total} maxPages={MAX_WORK_PAGES} href={(at) => tabHref("work", at, showingWork === "all" ? "work=all" : "")} />
        ) : null}

        {hasTasks ? null : <p className="mt-6 text-ink-soft">This course has no assignments yet. Add one to a lesson on the Lessons tab, and the work students hand in is listed here.</p>}
          </>
        ) : null}
        {tab === "comments" ? (
          <>
        <CourseCommentsStudio
          productId={product.id}
          storeName={store.name}
          initialOn={talking}
          initial={shownComments}
          lessonHref={view.role === "owner" ? `/@${store.handle}/course/${product.id}` : null}
          now={commentClock()}
        />
        <TabPager label="Pages of comments" noun="comments" page={page} size={COURSE_TAB_PAGE.comments} shown={recent.comments.length} total={null} maxPages={MAX_TAB_PAGES} href={(at) => tabHref("comments", at)} />

          </>
        ) : null}
        {tab === "certificates" ? (
          <>
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
            {course.certificate ? <CertificateValidity productId={product.id} months={course.certificateMonths ?? null} /> : null}
            {course.certificate ? (
              <Link
                href={`/@${store.handle}/certificate/sample?product=${product.id}`}
                className="text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep"
              >
                See a sample
              </Link>
            ) : null}
          </div>

          <h3 className="mt-7 font-semibold text-ink">{standing === null ? "Completions" : `Completions \u00b7 ${standing} ${standing === 1 ? "certificate" : "certificates"} issued`}</h3>
          {certificates && !whole ? (
            <p className="mt-2 text-sm text-ink-soft">
              {`${certificates.total} certificates in all, in no set order, about ${COURSE_TAB_PAGE.certificates} on each page and sorted by date within it, so how many are still standing is not counted here.`}
            </p>
          ) : null}
          {certificates?.tooBig ? (
            <p role="status" className="notice mt-3">
              This page of certificates is too large to show, so the rest could not be read here. Go to the next page, or reload in a moment.
            </p>
          ) : null}
          {certificates === null ? (
            <p role="status" className="notice mt-3">
              The certificates could not be read just now. Reload this page in a moment; this does not mean none were issued.
            </p>
          ) : certificates.list.length === 0 ? (
            <StudioEmptyState
              level={4}
              compact
              className="mt-3"
              title={course.certificate ? "No certificates yet" : "Certificates are off"}
              body={course.certificate ? "Nobody has finished yet. When a student does and asks for their certificate, it is listed here." : "Switch certificates on above and each student who finishes is listed here with theirs."}
            />
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
          {certificates ? (
            <CursorPager label="Pages of certificates" noun="certificates" size={COURSE_TAB_PAGE.certificates} cursor={cursor} next={certificates.next} href={(at) => tabHref("certificates", 1, at === "0" ? "" : `cursor=${at}`)} />
          ) : null}
        </section>
          </>
        ) : null}
        {tab === "students" ? (
          <>
        <section className="card mt-8 p-6 sm:p-8" aria-labelledby="students-title">
          <h2 id="students-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Students</h2>
          <p className="mt-2 text-ink-soft">
            Everyone who has opened the course since buying it, with how many lessons they marked done. Buyers are
            read from your own Stripe account; this list is what they did here.
          </p>
          {studentsRead === null ? null : (
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
          )}
          {studentsRead !== null && (cursor !== "0" || studentsRead.next !== null) ? (
            <p className="mt-3 text-sm text-ink-soft">
              {`${total} students in all, in no set order, about ${COURSE_TAB_PAGE.students} on each page and sorted by last visit within it. The lessons finished above count only the students on this page.`}
            </p>
          ) : null}
          {studentsRead?.tooBig ? (
            <p role="status" className="notice mt-3">
              This page of students is too large to show, so the rest could not be read here. Go to the next page, or reload in a moment.
            </p>
          ) : null}
          {studentsRead === null ? (
            <p role="status" className="notice mt-5">
              The students could not be read just now. Reload this page in a moment; this does not mean nobody has opened the course.
            </p>
          ) : students.length === 0 ? (
            <StudioEmptyState
              level={3}
              compact
              className="mt-5"
              title="No students yet"
              body="Each student who opens the course is listed here, with the lessons they marked done."
              action={selling ? { href: `/@${store.handle}/p/${productSegment(product)}`, label: "Open the sale page to share it" } : undefined}
            />
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
          {studentsRead ? (
            <CursorPager label="Pages of students" noun="students" size={COURSE_TAB_PAGE.students} cursor={cursor} next={studentsRead.next} href={(at) => tabHref("students", 1, at === "0" ? "" : `cursor=${at}`)} />
          ) : null}
        </section>
          </>
        ) : null}
      </main>
      </StudioStorePin>
    </div>
  );
}
