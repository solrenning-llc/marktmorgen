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
import CertificatePage, { generateMetadata as certificateMeta } from "@/app/[handle]/certificate/[id]/page";
import { GET as certificatePdfRoute } from "@/app/[handle]/certificate/[id]/pdf/route";
import CoursePage from "@/app/[handle]/course/[product]/page";
import LessonPage from "@/app/[handle]/course/[product]/[lesson]/page";
import { GET as courseFileRoute } from "@/app/api/store/course/file/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { saveCourse, type Course } from "@/lib/course";
import { coursesWords } from "@/lib/buyer-words/courses";
import { putMember } from "@/lib/team";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setProductHidden, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "kiln@example.com";
const EDITOR = "editor@example.com";
const STRANGER = "someone@example.com";
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
          { id: "lesson000002", title: "Paid lesson", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null },
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
  const sessions = { stranger: "", owner: await openSession(OWNER), editor: await openSession(EDITOR), signedInStranger: await openSession(STRANGER) };
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
    is("its preview lesson is not shown", (await lesson(who)).startsWith("redirect "), true);
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

  part("A session that cannot be read is a no");
  const broken = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => String(c[0]) === "GET" && String(c[1]).startsWith("nl:auth:session"))) throw new Error("store down");
    return broken(commands);
  }) as typeof redis.pipeline;
  const unread = await sample("editor");
  is("the draft's sample is not drawn", unread.status, 404);
  redis.pipeline = broken as typeof redis.pipeline;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
