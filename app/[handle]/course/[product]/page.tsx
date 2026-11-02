import { EmailField } from "@/components/email-field";
import { countDay } from "@/lib/day-visit";
import { DigitalConsentBox } from "@/components/digital-consent-box";
import { isResting } from "@/lib/traffic";
import { forVisitor } from "@/lib/visitor";
import { activeIntro } from "@/lib/intro-price";
import { salePrice } from "@/lib/store-sale";
import { offNow } from "@/components/store-product";
import { paypalReady } from "@/lib/paypal-sales";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { canSellProduct } from "@/lib/store-checkout";
import { activePwyw } from "@/lib/pay-what-you-want";
import { beforeStart, isCohort, isOpen, lessonCount, lessonsInOrder, readCourse } from "@/lib/course";
import { courseAccess, doneLessons, emailKey, touchStudent } from "@/lib/learn";
import { heldBack, passedQuizzes, requiredQuizLessons } from "@/lib/quiz";
import { MAX_CERT_NAME, MIN_CERT_NAME, certificateOf, hasFinished } from "@/lib/certificate";
import { canManage } from "@/lib/membership-manage";
import { CourseOutline, WithDay } from "@/components/course-outline";
import { readListing } from "@/lib/catalog";
import { membershipLine, speech } from "@/lib/buyer-words";
import { coursesWords } from "@/lib/buyer-words/courses";
import { productSegment } from "@/lib/product-slug";
import { noteIfOpened } from "@/lib/course-finish";
import { exampleTitlesLeft } from "@/lib/course-templates";

type Params = {
  params: Promise<{ handle: string; product: string }>;
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
    title: coursesWords(language).metaCourse,
    robots: { index: false, follow: true },
  };
}

/** The course's front door: its outline, and for a student, where they are. */
export default async function CoursePage({ params, searchParams }: Params) {
  const { handle: raw, product: productId } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const loaded = await storeForPage(normaliseHandle(decoded));
  if (!loaded) notFound();
  // With the visitor's country, for a fair price for it (lib/fair-price.ts).
  const store = await forVisitor(loaded);
  const product = await readListing(store, productId);
  if (!product?.course) redirect(`/@${store.handle}`);
  const course = await readCourse(product.course.id);
  if (!course) redirect(`/@${store.handle}`);
  const said = speech(store);
  const w = coursesWords(store.language);

  const query = await searchParams;
  const notice = w.linkNotices[typeof query.link === "string" ? query.link : ""] ?? null;
  const access = await courseAccess(store, product, await cookies());
  const open = access.state === "open";
  const start = open ? access.start : null;
  const studying = open && !access.learner.owner;
  // A course still holding a ready structure's example titles is hidden and shown to its owner only (540 [CU1]).
  if (product.hidden && exampleTitlesLeft(course) > 0 && !(open && access.learner.owner)) redirect(`/@${store.handle}`);
  const who = studying ? emailKey(access.learner.email) : "";
  const [done, passed, certificate] = studying
    ? await Promise.all([
        doneLessons(course.id, access.learner.email),
        passedQuizzes(course.id, who),
        course.certificate ? certificateOf(course.id, who) : Promise.resolve(null),
      ])
    : [new Set<string>(), new Set<string>(), null];
  if (open && !access.learner.owner) {
    const { email } = access.learner;
    after(() => touchStudent(course.id, email, access.start, store));
    // Once the whole month's visits are used, a course rests too (lib/traffic-rules.ts).
    if (await isResting(store, undefined, "buyer")) redirect(`/@${store.handle}/resting`);
    // A student's day in a course is a visit to the store (lib/day-visit.ts).
    await countDay(store);
    // The first time a student opens it, what opening it starts (lib/course-finish.ts).
    after(() => noteIfOpened(store, product.id, course.id, email));
  }
  // Lessons a quiz that has to be passed still holds shut, for this student.
  const held = studying ? heldBack(course, passed) : new Map<string, string>();
  const finished = studying && hasFinished(course, done, passed);
  const mustPass = requiredQuizLessons(course).length;
  const certNotice = w.certNotices(MIN_CERT_NAME, MAX_CERT_NAME)[typeof query.cert === "string" ? query.cert : ""] ?? null;

  const all = lessonsInOrder(course);
  const total = lessonCount(course);
  const doneCount = all.filter(({ lesson }) => done.has(lesson.id)).length;
  const reachable = (entry: (typeof all)[number]) => isOpen(course, entry.unit, start!) && !held.has(entry.lesson.id);
  const next = open
    ? all.find((entry) => !done.has(entry.lesson.id) && reachable(entry)) ?? all.find(reachable)
    : null;
  const preview = all.find(({ lesson }) => lesson.preview);
  const base = `/@${store.handle}/course/${product.id}`;
  const selling = canSellProduct(store, product);
  // Said with every term the checkout will apply: a trial, a set number of
  // payments, an introductory price, a price the buyer chooses.
  const price = product.recurring
    ? membershipLine(store, product.recurring, said.money(product.priceCents), activeIntro(product, store.tiers))
    : activePwyw(product)
      ? w.pwywPrice(said.money(product.priceCents))
      : // A sale or a fair price for the visitor's country, as the checkout takes it off.
        said.money(salePrice(product.priceCents, offNow(store, product)));

  return (
    <div
      lang={said.lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-2xl px-4 py-12 sm:py-16">
        <div className="flex items-center justify-center gap-3">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={48} height={48} className="st-avatar !mx-0" style={{ width: 48, height: 48 }} />
          ) : (
            <span aria-hidden="true" className="st-avatar st-avatar-initial !mx-0" style={{ width: 48, height: 48, fontSize: "1.25rem" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="font-semibold">{store.name}</span>
        </div>

        <div className="st-card mt-6 p-6 sm:p-8">
          <p className="st-label">{w.courseLabel}</p>
          <h1 className="font-display mt-1 text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">{product.title}</h1>
          {product.summary ? <p className="st-muted mt-3 leading-relaxed">{product.summary}</p> : null}
          <p className="st-muted mt-3 text-sm font-semibold">
            {[w.outline(total, course.modules.length), course.certificate ? w.withCertificate : null].filter(Boolean).join(" · ")}
          </p>

          {notice ? (
            <div className="st-note mt-6" role="status">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
              <p className="mt-1 text-sm">{notice.body}</p>
            </div>
          ) : null}

          {open && access.learner.owner ? (
            <div className="st-note mt-6">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{w.ownTitle}</p>
              <p className="mt-1 text-sm">{w.ownBody}</p>
              {course.certificate ? (
                <p className="mt-2 text-sm">
                  <Link href={`/@${store.handle}/certificate/sample?product=${product.id}`} className="font-semibold underline underline-offset-4" style={{ color: "var(--st-text)" }}>
                    {w.seeSample}
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}

          {access.state === "ended" ? (
            <div className="st-note mt-6" role="status">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{w.endedTitle}</p>
              <p className="mt-1 text-sm">{w.endedBody}</p>
              {canManage(store) ? (
                <p className="mt-2 text-sm">
                  {w.endedPayment}
                  <Link href={`/@${store.handle}/manage`} className="font-semibold underline underline-offset-4" style={{ color: "var(--st-text)" }}>
                    {w.manageMembership}
                  </Link>
                  .
                </p>
              ) : null}
            </div>
          ) : null}

          {open ? (
            <div className="mt-6">
              {!access.learner.owner ? (
                <>
                  <p className="text-sm font-semibold" style={{ color: "var(--st-text)" }}>
                    {w.doneOf(doneCount, total)}
                  </p>
                  <div
                    className="mt-2 h-2 overflow-hidden rounded-full"
                    style={{ background: "var(--st-accent-soft)" }}
                    role="progressbar"
                    aria-label={w.yourProgress}
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={doneCount}
                  >
                    <div className="h-full rounded-full" style={{ width: `${total ? Math.round((doneCount / total) * 100) : 0}%`, background: "var(--st-accent)" }} />
                  </div>
                </>
              ) : null}
              {next ? (
                <Link href={`${base}/${next.lesson.id}`} className="btn st-btn btn-lg mt-5">
                  {doneCount === 0 ? w.startFirst : doneCount >= total ? w.startOver : w.continueOn}
                </Link>
              ) : (
                <p className="st-muted mt-5 text-sm">{w.opensSoon}</p>
              )}

              {studying && course.certificate ? (
                <div id="certificate" className="mt-6 scroll-mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line-strong)" }}>
                  <p className="st-label">{w.certLabel}</p>
                  {certificate ? (
                    <>
                      <p className="st-muted mt-1 text-sm">{w.issuedTo(certificate.name)}</p>
                      <Link href={`/@${store.handle}/certificate/${certificate.id}`} className="btn st-btn mt-3">
                        {w.openCertificate}
                      </Link>
                    </>
                  ) : finished ? (
                    <form action="/api/store/course/certificate" method="post" className="mt-2">
                      <input type="hidden" name="handle" value={store.handle} />
                      <input type="hidden" name="product" value={product.id} />
                      <label htmlFor="cert-name" className="st-muted block text-sm">
                        {w.finishedName}
                      </label>
                      {certNotice ? (
                        <p className="mt-2 text-sm font-semibold" role="alert" style={{ color: "var(--st-text)" }}>
                          {certNotice}
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <input
                          id="cert-name"
                          name="name"
                          required
                          minLength={MIN_CERT_NAME}
                          maxLength={MAX_CERT_NAME}
                          autoComplete="name"
                          placeholder={w.fullName}
                          className="st-field min-w-0 flex-1"
                        />
                        <button type="submit" className="btn st-btn">{w.getCertificate}</button>
                      </div>
                    </form>
                  ) : (
                    <p className="st-muted mt-1 text-sm">{w.certHow(mustPass)}</p>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {selling ? (
                <form action="/api/store/checkout" method="post" target="_top" data-checkout="">
                  <input type="hidden" name="handle" value={store.handle} />
                  <input type="hidden" name="product" value={product.id} />
                  {/* A course is handed over at once: the box to start access first (lib/digital-consent.ts). */}
                  {/* Sent back here, not to the product's page, when the box was not checked (app/api/store/checkout, `from`). */}
                  <input type="hidden" name="from" value="course" />
                  <DigitalConsentBox id={`dc-course-${product.id}`} lang={store.language} refused={query.consent === "needed"} className="mb-5" />
                  <button type="submit" className="btn st-btn btn-lg btn-block">{w.buyCourse(access.state === "ended", price)}</button>
                </form>
              ) : paypalReady(store, product) ? (
                <Link href={`/@${store.handle}/p/${productSegment(product)}#buy`} className="btn st-btn btn-lg btn-block">{w.buyWithPayPal(price)}</Link>
              ) : (
                <p className="st-muted text-sm">{w.noPayments(store.name)}</p>
              )}
              {preview ? (
                <p className="text-sm">
                  <Link href={`${base}/${preview.lesson.id}`} className="font-semibold underline underline-offset-2" style={{ color: "var(--st-text)" }}>
                    {w.tryFree(preview.lesson.title)}
                  </Link>
                </p>
              ) : null}
              {access.state === "ended" ? null : (
              <form action="/api/store/course/link" method="post" className="rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }}>
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="product" value={product.id} />
                <label htmlFor="course-email" className="st-label">{w.alreadyBought}</label>
                <p className="st-muted mt-1 text-sm">{w.alreadyBoughtNote}</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
                  <EmailField id="course-email" name="email" className="st-field w-full" wrapClassName="min-w-0 flex-1" required autoComplete="email" placeholder={said.w.emailPlaceholder} language={store.language} />
                  <button type="submit" className="btn st-btn">{w.sendLink}</button>
                </div>
              </form>
              )}
            </div>
          )}
        </div>

        <div className="st-card mt-6 p-6 sm:p-8">
          <h2 className="font-display text-xl font-semibold">{w.inside}</h2>
          {/*
            A course that runs to a timetable says so here, above the
            outline, and says it to a visitor as well as to a student.

            Somebody who has bought and is waiting needs to be told they are
            waiting on a date and not on something they failed to do — a page
            of locked modules with no explanation reads as a broken purchase.
            Somebody who has not bought needs it before they pay, because a
            course that begins in three weeks is a different thing from one
            that begins when you press the button, and finding that out after
            paying is the kind of surprise that earns a refund.
          */}
          {isCohort(course) ? (
            <p className="st-muted mt-3 text-sm">
              <WithDay text={beforeStart(course) ? w.cohortBefore : w.cohortAfter} seconds={course.startsAt!} locale={said.lang.locale} />
            </p>
          ) : null}
          <div className="mt-4">
            <CourseOutline course={course} base={base} start={start} done={done} held={held} language={store.language} />
          </div>
        </div>

        <div className="mt-6 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {said.w.backTo(store.name)}
          </Link>
        </div>
      </main>
    </div>
  );
}
