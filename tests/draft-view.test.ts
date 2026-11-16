/**
 * A draft is left off the store, its own page and its checkout
 * (lib/catalog.ts, `hidden`), so whoever only knows its id learns nothing of
 * it (MM-SA-30, docs/security-audit-2026-10-28.md): not its title or price on
 * a sample certificate, not its outline on the course's front door, not its
 * preview lessons or their downloads. Its students still reach what they
 * bought, and the store's owner and team, signed in, still see it to work
 * on it (lib/draft-view.ts). A published course is shown as before.
 *
 * Real pages and routes, against the in-memory store of the tests; next/headers
 * reads the request each call answers (tests/security/next-headers.ts).
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import BookPage, { generateMetadata as bookMeta } from "@/app/[handle]/book/[product]/page";
import ReviewsPage, { generateMetadata as reviewsMeta } from "@/app/[handle]/p/[product]/reviews/page";
import FreePage from "@/app/[handle]/free/page";
import PodcastPage from "@/app/[handle]/podcast/[product]/page";
import { feedToken } from "@/lib/podcast-access";
import CertificatePage, { generateMetadata as certificateMeta } from "@/app/[handle]/certificate/[id]/page";
import { GET as certificatePdfRoute } from "@/app/[handle]/certificate/[id]/pdf/route";
import CoursePage from "@/app/[handle]/course/[product]/page";
import LessonPage from "@/app/[handle]/course/[product]/[lesson]/page";
import { GET as courseFileRoute } from "@/app/api/store/course/file/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { emailKey, storeKey } from "@/lib/learn";
import { saveCourse, type Course } from "@/lib/course";
import { coursesWords } from "@/lib/buyer-words/courses";
import { putMember, setRequireTwoStep } from "@/lib/team";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCall, setProductCourse, setProductHidden, setProductPodcast, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "kiln@example.com";
const EDITOR = "editor@example.com";
const STRANGER = "someone@example.com";
const STUDENT = "student@example.com";
const BASE = "https://marktmorgen.com";

/** What a page did: drawn, sent elsewhere (and where), or not found. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "shown";
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    if (digest.includes("404")) return "not found";
    throw error;
  }
}

/** A page drawn to HTML, as a browser gets it; or what it threw instead (a redirect, not found). */
async function html(run: () => Promise<unknown>): Promise<string> {
  try {
    const node = await run();
    const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
    await stream.allReady;
    return await new Response(stream).text();
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    if (digest) return `thrown ${digest}`;
    throw error;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_kiln00001", subscriptionId: "sub_kiln00001", active: true, tier: "creator", period: paidPeriod() });
  const folder = await storeFolder(OWNER);
  const made = await addProduct(OWNER, "Secret glazing masterclass", "", "149", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const sheet = { pathname: `${folder}/worksheet.pdf`, name: "worksheet.pdf", bytes: 10, contentType: "application/pdf", addedAt: "2026-11-05T00:00:00.000Z" };
  const course: Course = {
    id: "d".repeat(32),
    certificate: true,
    startsAt: null,
    modules: [
      {
        id: "module000001",
        title: "Clay bodies",
        dripDays: 0,
        lessons: [
          { id: "lesson000001", title: "Free first look", preview: true, video: null, files: [sheet], link: null, hasBody: false, quiz: null },
          { id: "lesson000002", title: "Paid lesson", preview: false, video: null, files: [{ ...sheet, pathname: `${folder}/answers.pdf`, name: "answers.pdf" }], link: null, hasBody: false, quiz: null },
        ],
      },
    ],
  } as unknown as Course;
  await saveCourse(course, ROOM, true);
  const attached = await setProductCourse(OWNER, id, { id: course.id, lessons: 2 });
  if (!attached.ok) throw new Error(`no course: ${attached.reason}`);
  const store = (await storeForEmail(OWNER)) as Store;
  if (!store.sid) throw new Error("no store id");
  if (!(await putMember(store, EDITOR, "editor"))) throw new Error("no editor");
  const sessions = { stranger: "", owner: await openSession(OWNER), editor: await openSession(EDITOR), signedInStranger: await openSession(STRANGER), student: await openSession(STUDENT) };
  type Who = keyof typeof sessions;
  const cookieOf = (who: Who): Record<string, string> => (sessions[who] ? { cookie: `${SESSION_COOKIE}=${sessions[who]}` } : {});
  const asked = (who: Who, path: string) => {
    const request = new NextRequest(`${BASE}${path}`, { headers: cookieOf(who) });
    answering(request);
    return request;
  };

  const sample = (who: Who) => certificatePdfRoute(asked(who, `/@kilnworks/certificate/sample/pdf?product=${id}`), { params: Promise.resolve({ handle: "@kilnworks", id: "sample" }) });
  const samplePage = (who: Who) => {
    asked(who, `/@kilnworks/certificate/sample?product=${id}`);
    const args = { params: Promise.resolve({ handle: "@kilnworks", id: "sample" }), searchParams: Promise.resolve({ product: id }) };
    return { page: () => outcome(() => CertificatePage(args)), meta: async () => (await certificateMeta(args)).title };
  };
  const front = (who: Who) => {
    asked(who, `/@kilnworks/course/${id}`);
    return outcome(() => CoursePage({ params: Promise.resolve({ handle: "@kilnworks", product: id }), searchParams: Promise.resolve({}) }));
  };
  const lesson = (who: Who, lessonId = "lesson000001") => {
    asked(who, `/@kilnworks/course/${id}/${lessonId}`);
    return outcome(() => LessonPage({ params: Promise.resolve({ handle: "@kilnworks", product: id, lesson: lessonId }), searchParams: Promise.resolve({}) }));
  };
  const file = (who: Who) => courseFileRoute(asked(who, `/api/store/course/file?h=kilnworks&p=${id}&l=lesson000001&i=0`));
  const w = coursesWords(store.language);
  const notFoundTitle = w.metaCertNotFound;

  part("Published: shown to anyone, as before");
  const published = await sample("stranger");
  is("the sample certificate's file, kept by the CDN as before", [published.status, published.headers.get("cache-control")], [200, "public, max-age=0, s-maxage=300"]);
  is("the sample certificate's page", await samplePage("stranger").page(), "shown");
  is("its tab names the course", await samplePage("stranger").meta(), w.metaCert(w.sampleName, "Secret glazing masterclass"));
  is("the course's front door", await front("stranger"), "shown");
  is("a preview lesson", await lesson("stranger"), "shown");
  is("a lesson that is not a preview goes to the front door", await lesson("stranger", "lesson000002"), `redirect /@kilnworks/course/${id}`);
  const publishedFile = await file("stranger");
  is("a preview lesson's download gets past the door (the file store is absent here)", [publishedFile.status !== 404 && publishedFile.status !== 403, await publishedFile.clone().text() !== "Not found."], [true, true]);

  const hid = await setProductHidden(OWNER, id, true);
  if (!hid.ok) throw new Error(`not hidden: ${hid.reason}`);

  for (const who of ["stranger", "signedInStranger"] as const) {
    part(`A draft, to ${who === "stranger" ? "a visitor who only knows its id" : "someone signed in who is not on the store's team"}`);
    const drawn = await sample(who);
    is("no sample certificate file: not found, and no PDF", [drawn.status, drawn.headers.get("content-type")?.startsWith("application/pdf") ?? false], [404, false]);
    is("no sample certificate page", await samplePage(who).page(), "not found");
    is("its tab does not name the draft", await samplePage(who).meta(), notFoundTitle);
    is("its front door sends them to the store", await front(who), "redirect /@kilnworks");
    is("its preview lesson sends them straight to the store, as an id that does not exist", [await lesson(who), await lesson(who, "lesson000002"), await lesson(who, "nosuchlesson")], ["redirect /@kilnworks", "redirect /@kilnworks", "redirect /@kilnworks"]);
    const missing = await courseFileRoute(asked(who, `/api/store/course/file?h=kilnworks&p=${id}&l=lesson000002&i=0`));
    is("a draft's other lesson answers its download as an id that does not exist", [missing.status, await missing.text()], [404, "Not found."]);
    const download = await file(who);
    is("its preview lesson's download is not handed out", [download.status, await download.text()], [404, "Not found."]);
  }

  for (const who of ["owner", "editor"] as const) {
    part(`A draft, to the store's ${who}, signed in`);
    const drawn = await sample(who);
    is("the sample certificate file is drawn, and kept by no shared cache", [drawn.status, drawn.headers.get("cache-control")], [200, "private, no-store"]);
    is("the sample certificate page", await samplePage(who).page(), "shown");
    is("its tab names the course", await samplePage(who).meta(), w.metaCert(w.sampleName, "Secret glazing masterclass"));
    is("the course's front door", await front(who), "shown");
    is("its preview lesson", await lesson(who), "shown");
    const download = await file(who);
    is("its preview lesson's download gets past the door", download.status !== 404 && download.status !== 403, true);
  }

  part("A draft, to a student who bought it before it went back to draft");
  // What Stripe would answer for this address, kept as the course's access reads it (lib/learn.ts, courseLedger).
  const started = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([["SET", `nl:learn:paid:${storeKey(store)}:${emailKey(STUDENT)}`, JSON.stringify({ p: { [id]: started }, x: [], r: [] }), "EX", 600]]);
  is("the course's front door", await front("student"), "shown");
  is("its preview lesson", await lesson("student"), "shown");
  is("a lesson it paid for", await lesson("student", "lesson000002"), "shown");
  const studied = await file("student");
  is("its preview lesson's download gets past the door", studied.status !== 404 && studied.status !== 403, true);
  const studentSample = await sample("student");
  is("the sample certificate stays the team's (a student gets their own when they finish)", studentSample.status, 404);

  part("A team that requires two-step sign-in, as the studio reads it");
  if (!(await setRequireTwoStep(store, true, OWNER))) throw new Error("two-step not required");
  is("a member whose session had no second step sees nothing of the draft", [(await sample("editor")).status, await front("editor")], [404, "redirect /@kilnworks"]);
  is("the owner still does", (await sample("owner")).status, 200);
  await setRequireTwoStep(store, false, OWNER);

  part("What cannot be read is a no");
  const real = redis.pipeline.bind(redis);
  const failing = (prefix: string) =>
    (redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => String(c[0]) === "GET" && String(c[1]).startsWith(prefix))) throw new Error("store down");
      return real(commands);
    }) as typeof redis.pipeline);
  failing("nl:auth:session");
  is("a session that cannot be read: the draft's sample is not drawn", (await sample("editor")).status, 404);
  failing("nl:team:");
  is("a team that cannot be read: not drawn for a member", (await sample("editor")).status, 404);
  redis.pipeline = real as typeof redis.pipeline;
  is("read again, the member sees it", (await sample("editor")).status, 200);

  part("Other addresses that name a product by id (independent review of #2523)");
  const callMade = await addProduct(OWNER, "Secret one to one review", "", "349", null);
  if (!callMade.ok) throw new Error("no call");
  const callId = callMade.product.id;
  const setup = { kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, sessions: [] };
  const callSet = await setProductCall(OWNER, callId, setup as unknown as CallSetup);
  if (!callSet.ok) throw new Error(`no call setup: ${callSet.reason}`);
  const ebook = await addProduct(OWNER, "Secret glazing ebook", "", "79", null);
  if (!ebook.ok) throw new Error("no ebook");
  const show = await addProduct(OWNER, "Secret kiln podcast", "", "29", null);
  if (!show.ok) throw new Error("no podcast");
  if (!(await setProductPodcast(OWNER, show.product.id, { id: "f".repeat(32), episodes: 1 })).ok) throw new Error("no podcast ref");
  for (const each of [callId, ebook.product.id, show.product.id]) if (!(await setProductHidden(OWNER, each, true)).ok) throw new Error("not hidden");
  const fresh = (await storeForEmail(OWNER)) as Store;
  const listener = await feedToken(fresh, show.product.id, STUDENT);
  if (!listener) throw new Error("no feed token");
  const book = async (who: Who) => {
    asked(who, `/@kilnworks/book/${callId}`);
    const meta = String((await bookMeta({ params: Promise.resolve({ handle: "@kilnworks", product: callId }), searchParams: Promise.resolve({}) })).title);
    return { meta, page: await html(() => BookPage({ params: Promise.resolve({ handle: "@kilnworks", product: callId }), searchParams: Promise.resolve({}) })) };
  };
  const reviews = async (who: Who, product: string) => {
    asked(who, `/@kilnworks/p/${product}/reviews`);
    const args = { params: Promise.resolve({ handle: "@kilnworks", product }), searchParams: Promise.resolve({}) };
    return { meta: String((await reviewsMeta(args)).title), page: await html(() => ReviewsPage(args)) };
  };
  const freeSent = async (who: Who, product: string) => {
    asked(who, `/@kilnworks/free?status=sent&product=${product}`);
    return html(() => FreePage({ params: Promise.resolve({ handle: "@kilnworks" }), searchParams: Promise.resolve({ status: "sent", product }) }));
  };
  const podcast = async (who: Who, query: Record<string, string> = {}) => {
    asked(who, `/@kilnworks/podcast/${show.product.id}`);
    return html(() => PodcastPage({ params: Promise.resolve({ handle: "@kilnworks", product: show.product.id }), searchParams: Promise.resolve(query) }));
  };
  const gone = await book("stranger");
  const nowhere = await (async () => {
    asked("stranger", "/@kilnworks/book/0123456789");
    return String((await bookMeta({ params: Promise.resolve({ handle: "@kilnworks", product: "0123456789" }), searchParams: Promise.resolve({}) })).title);
  })();
  is("a draft call's booking page: its tab is the one an unknown id gets, and the page sends them to the store", [gone.meta, gone.page], [nowhere, "redirect /@kilnworks"]);
  const signedOut = await book("signedInStranger");
  is("the same for someone signed in who is not on the team", [signedOut.meta.includes("Secret"), signedOut.page], [false, "redirect /@kilnworks"]);
  const owned = await book("owner");
  is("the owner, signed in, still sees the draft call's page, title and price", [owned.meta.includes("Secret one to one review"), owned.page.includes("Secret one to one review"), /\$349/.test(owned.page)], [true, true, true]);
  const draftReviews = await reviews("stranger", ebook.product.id);
  const unknownReviews = await reviews("stranger", "0123456789");
  is("a draft's reviews page: the tab and the page are those of an unknown id", [draftReviews.meta, draftReviews.page], [unknownReviews.meta, unknownReviews.page]);
  is("not even for its owner: a draft has no public page of its own", (await reviews("owner", ebook.product.id)).page, "redirect /@kilnworks");
  const sentDraft = await freeSent("stranger", ebook.product.id);
  is("the free page's 'we emailed you' never names a draft", [sentDraft.startsWith("<"), sentDraft.includes("Secret glazing ebook")], [true, false]);
  is("a draft podcast's page: a visitor is sent to the store", await podcast("stranger"), "redirect /@kilnworks");
  is("so is someone with a feed token that is not this podcast's", await podcast("stranger", { t: "0".repeat(48) }), "redirect /@kilnworks");
  const own = await podcast("stranger", { t: listener });
  is("a listener with their own feed token still gets their feed, on any device", [own.includes("Secret kiln podcast"), own.includes(`/api/store/podcast/feed/${listener}.xml`)], [true, true]);
  is("the store's team still sees it", (await podcast("editor")).includes("Secret kiln podcast"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
