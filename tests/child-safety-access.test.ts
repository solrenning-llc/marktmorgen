/**
 * Only the store's owner reads a product held for a child-safety report
 * (C1-20261109-1546-TODOS-70, unit 3a; lib/child-safety.ts, isHeldForReport).
 *
 * While the 400-day preservation hold lasts, nobody but the store's owner
 * reads what the product holds: not its students, not a listener with their
 * own feed, not a visitor on a free preview lesson, not someone on the
 * store's team, and nothing of it goes to an AI provider. A mark that cannot
 * be read refuses too, never shows the content. The products are neutral
 * and synthetic; nothing here names or describes reported material.
 *
 * Real pages and routes, against the in-memory store of the tests; next/headers
 * reads the request each call answers (tests/security/next-headers.ts), and the
 * shared card's drawer is a stand-in that keeps what it would draw
 * (tests/child-safety-access-og.ts).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import CoursePage from "@/app/[handle]/course/[product]/page";
import LessonPage from "@/app/[handle]/course/[product]/[lesson]/page";
import PodcastPage from "@/app/[handle]/podcast/[product]/page";
import ProductPage from "@/app/[handle]/p/[product]/page";
import OpengraphImage from "@/app/[handle]/p/[product]/opengraph-image";
import { GET as courseFileRoute } from "@/app/api/store/course/file/route";
import { GET as feedRoute } from "@/app/api/store/podcast/feed/[token]/route";
import { GET as playRoute } from "@/app/api/store/podcast/play/[token]/[episode]/route";
import { GET as previewRoute } from "@/app/api/store/preview/route";
import { GET as downloadRoute } from "@/app/api/store/file/download/route";
import { GET as courseGetRoute } from "@/app/api/store/course/route";
import { POST as aiRoute } from "@/app/api/store/ai/route";
import { feedToken } from "@/lib/podcast-access";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { emailKey, storeKey } from "@/lib/learn";
import { saveCourse, type Course } from "@/lib/course";
import { putMember } from "@/lib/team";
import { holdReported } from "@/lib/child-safety";
import { PIN_HEADER } from "@/lib/studio-route";
import { addOption, addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setProductFile, setProductHidden, setProductPodcast, setProductPreview, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { answering } from "./security/next-headers";
import { drawn } from "./child-safety-access-og";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "held-owner@example.com";
const EDITOR = "held-editor@example.com";
const STUDENT = "held-student@example.com";
const BASE = "https://marktmorgen.com";
const HANDLE = "heldshop";

/** What a page did: drawn, sent elsewhere (and where), or not found. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const node = await run();
    const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
    await stream.allReady;
    const page = await new Response(stream).text();
    return page.includes("Held Product") ? "shown" : "drawn without it";
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    if (digest.includes("404")) return "not found";
    throw error;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Held Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_held00001", subscriptionId: "sub_held00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const folder = await storeFolder(OWNER);

  // A course with a free preview lesson and a paid one, each with a worksheet.
  const courseMade = await addProduct(OWNER, "Held Product course", "", "149", null);
  if (!courseMade.ok) throw new Error("no course product");
  const courseId = courseMade.product.id;
  const sheet = { pathname: `${folder}/sheet.pdf`, name: "sheet.pdf", bytes: 10, contentType: "application/pdf", addedAt: "2026-11-09T00:00:00.000Z" };
  const course = {
    id: "c".repeat(32),
    certificate: false,
    startsAt: null,
    modules: [
      {
        id: "module000001",
        title: "First part",
        dripDays: 0,
        lessons: [
          { id: "lesson000001", title: "Free first look", preview: true, video: null, files: [sheet], link: null, hasBody: false, quiz: null },
          { id: "lesson000002", title: "Paid lesson", preview: false, video: null, files: [{ ...sheet, pathname: `${folder}/sheet2.pdf`, name: "sheet2.pdf" }], link: null, hasBody: false, quiz: null },
        ],
      },
    ],
  } as unknown as Course;
  await saveCourse(course, ROOM, true);
  if (!(await setProductCourse(OWNER, courseId, { id: course.id, lessons: 2 })).ok) throw new Error("no course");

  // A private podcast.
  const showMade = await addProduct(OWNER, "Held Product podcast", "", "29", null);
  if (!showMade.ok) throw new Error("no podcast product");
  const showId = showMade.product.id;
  if (!(await setProductPodcast(OWNER, showId, { id: "e".repeat(32), episodes: 1 })).ok) throw new Error("no podcast");

  // A PDF with its first pages open to anyone, and one more that is never held.
  const pdfMade = await addProduct(OWNER, "Held Product guide", "", "19", null);
  const freeMade = await addProduct(OWNER, "Free guide", "", "19", null);
  if (!pdfMade.ok || !freeMade.ok) throw new Error("no pdf product");
  const pdfId = pdfMade.product.id;
  const freeId = freeMade.product.id;
  for (const [id, name] of [[pdfId, "guide.pdf"], [freeId, "free.pdf"]]) {
    const filed = await setProductFile(OWNER, id, { pathname: `${folder}/${name}`, name, bytes: 2_000, contentType: "application/pdf", addedAt: "2026-11-09T00:00:00.000Z" });
    if (!filed.ok) throw new Error(`no file: ${JSON.stringify(filed)}`);
    if (!(await setProductPreview(OWNER, id, 2)).ok) throw new Error("no preview");
  }

  const store = (await storeForEmail(OWNER)) as Store;
  if (!store.sid) throw new Error("no store id");
  if (!(await putMember(store, EDITOR, "editor"))) throw new Error("no editor");
  const sessions = { stranger: "", owner: await openSession(OWNER), editor: await openSession(EDITOR), student: await openSession(STUDENT) };
  type Who = keyof typeof sessions;
  const asked = (who: Who, path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}), ...(sessions[who] ? { cookie: `${SESSION_COOKIE}=${sessions[who]}` } : {}) };
    const request = new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body });
    answering(request);
    return request;
  };

  // The student bought the course, and has their own feed of the podcast.
  const started = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([["SET", `nl:learn:paid:${storeKey(store)}:${emailKey(STUDENT)}`, JSON.stringify({ p: { [courseId]: started }, x: [], r: [] }), "EX", 600]]);
  const listener = await feedToken(store, showId, STUDENT);
  if (!listener) throw new Error("no feed token");

  const front = (who: Who) => {
    asked(who, `/@${HANDLE}/course/${courseId}`);
    return outcome(() => CoursePage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: courseId }), searchParams: Promise.resolve({}) }));
  };
  const lesson = (who: Who, lessonId = "lesson000001") => {
    asked(who, `/@${HANDLE}/course/${courseId}/${lessonId}`);
    return outcome(() => LessonPage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: courseId, lesson: lessonId }), searchParams: Promise.resolve({}) }));
  };
  const courseFile = async (who: Who, lessonId = "lesson000001") => {
    const response = await courseFileRoute(asked(who, `/api/store/course/file?h=${HANDLE}&p=${courseId}&l=${lessonId}&i=0`));
    return [response.status, await response.text()];
  };
  const podcastPage = (who: Who, query: Record<string, string> = {}) => {
    asked(who, `/@${HANDLE}/podcast/${showId}`);
    return outcome(() => PodcastPage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: showId }), searchParams: Promise.resolve(query) }));
  };
  const feed = async () => {
    const response = await feedRoute(asked("stranger", `/api/store/podcast/feed/${listener}.xml`), { params: Promise.resolve({ token: `${listener}.xml` }) });
    return [response.status, response.headers.get("cache-control"), (await response.text()).includes("Held Product")];
  };
  const play = async () => {
    const response = await playRoute(asked("stranger", `/api/store/podcast/play/${listener}/ep1.mp3`), { params: Promise.resolve({ token: listener, episode: "ep1.mp3" }) });
    return [response.status, response.headers.get("cache-control")];
  };
  const preview = async (product: string) => {
    const response = await previewRoute(asked("stranger", `/api/store/preview?handle=${HANDLE}&product=${product}`, { headers: { "x-forwarded-for": "198.51.100.40" } }));
    return [response.status, response.headers.get("cache-control"), await response.text()];
  };
  const card = async (product: string) => {
    drawn.length = 0;
    await OpengraphImage({ params: Promise.resolve({ handle: `@${HANDLE}`, product }) });
    const stream = await renderToReadableStream(drawn[0] as React.ReactElement);
    await stream.allReady;
    return (await new Response(stream).text()).includes("Held Product");
  };
  const download = async (who: Who, product: string) => {
    const response = await downloadRoute(asked(who, `/api/store/file/download?id=${product}`, { headers: { [PIN_HEADER]: store.sid ?? "" } }));
    return [response.status, await response.text()];
  };
  const ai = async (body: Record<string, unknown>) => {
    const request = asked("owner", "/api/store/ai", { method: "POST", headers: { "content-type": "application/json", origin: BASE, host: "marktmorgen.com" }, body: JSON.stringify(body) });
    const response = await aiRoute(request);
    return [response.status, ((await response.json()) as { error?: string }).error];
  };

  part("Before any hold: the content is there for those it is for");
  is("the student opens the course", await front("student"), "shown");
  is("the listener's feed lists the podcast", (await feed())[0], 200);
  is("a published PDF's preview gets past the door (the file store is absent here)", (await preview(pdfId))[2], "This product has no preview right now.");
  is("its shared card names it", await card(pdfId), true);

  part("A child-safety report holds the course, the podcast and the PDF");
  for (const id of [courseId, showId, pdfId]) {
    is(`held: ${id === courseId ? "course" : id === showId ? "podcast" : "PDF"}`, await holdReported({ kind: "child_safety", url: `${BASE}/@${HANDLE}/p/${id}` }, (await storeForEmail(OWNER)) as Store), "held");
  }

  part("A held course: only the store's owner sees it");
  is("the owner sees its front door", await front("owner"), "shown");
  is("the owner sees its lessons", [await lesson("owner"), await lesson("owner", "lesson000002")], ["shown", "shown"]);
  is("someone on the store's team does not", await front("editor"), `redirect /@${HANDLE}`);
  is("nor its lessons", await lesson("editor"), `redirect /@${HANDLE}`);
  is("its student does not, although they bought it", await front("student"), `redirect /@${HANDLE}`);
  is("nor a lesson they paid for", await lesson("student", "lesson000002"), `redirect /@${HANDLE}`);
  is("nor its free preview lesson", await lesson("student"), `redirect /@${HANDLE}`);
  is("a visitor goes where an id that does not exist goes", [await front("stranger"), await lesson("stranger")], [`redirect /@${HANDLE}`, `redirect /@${HANDLE}`]);
  is("its worksheets are handed to nobody: the student", [await courseFile("student"), await courseFile("student", "lesson000002")], [[404, "Not found."], [404, "Not found."]]);
  is("the team", await courseFile("editor"), [404, "Not found."]);
  is("the owner too (the studio is where they work on it)", await courseFile("owner"), [404, "Not found."]);

  part("A held podcast: not for its listeners");
  is("the feed is gone, and kept by no cache", await feed(), [404, "no-store", false]);
  is("an episode is not handed out, and kept by no cache", await play(), [404, "no-store"]);
  is("the listener's own page sends them to the store", await podcastPage("stranger", { t: listener }), `redirect /@${HANDLE}`);
  is("so does the team's", await podcastPage("editor"), `redirect /@${HANDLE}`);
  is("the owner still sees it", await podcastPage("owner"), "shown");

  part("A held product's public page and studio file");
  asked("stranger", `/@${HANDLE}/p/${pdfId}`);
  is("its public page is not served to a visitor", await outcome(() => ProductPage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: pdfId }), searchParams: Promise.resolve({}) })), `redirect /@${HANDLE}`);
  const editorDownload = await download("editor", pdfId);
  is("someone on the team cannot download its file from the studio", [editorDownload[0], String(editorDownload[1]).includes("on hold")], [403, true]);
  const ownerDownload = await download("owner", pdfId);
  is("the owner gets past that door (the file store is absent here)", ownerDownload[0] !== 403 && ownerDownload[0] !== 401, true);
  is("the team still downloads a product that is not held", (await download("editor", freeId))[0] !== 403, true);
  const optioned = await addOption(OWNER, pdfId, "Option A", "29");
  if (!optioned.ok) throw new Error("no option");
  const optionId = (await readListing((await storeForEmail(OWNER))!, pdfId))!.options[0].id;
  is("nor by naming one of its price options", (await download("editor", optionId))[0], 403);
  const lessonFor = async (who: Who) => {
    const response = await courseGetRoute(asked(who, `/api/store/course?id=${courseId}&lessonId=lesson000002`));
    return [response.status, ((await response.json()) as { error?: string }).error ?? "ok"];
  };
  is("someone on the team does not read its lessons from the studio", await lessonFor("editor"), [409, "on_hold"]);
  is("the owner still does", (await lessonFor("owner"))[1] !== "on_hold", true);

  part("Nothing of a held product goes to an AI provider, even for the owner");
  is("a page drafted from its PDF is refused before the file is read", await ai({ kind: "page", product: pdfId, readFile: true }), [409, "on_hold"]);
  is("an email sequence that follows it is refused before anything of it is read", await ai({ kind: "sequence", trigger: "product", productId: pdfId }), [409, "on_hold"]);
  is("a quiz drafted from a held course's lesson is refused", await ai({ kind: "quiz", id: courseId, lessonId: "lesson000002", count: 5 }), [409, "on_hold"]);
  is("a product that is not held gets past it (it has no readable file here)", (await ai({ kind: "page", product: freeId, readFile: true }))[1] !== "on_hold", true);
  is("the writing box says it is on hold, not that the allowance is unknown", readFileSync("components/ai-assist.tsx", "utf8").includes('on_hold: "This product is on hold'), true);

  part("A hold whose taking off the store did not go through: still read by nobody but the owner");
  if (!(await setProductHidden(OWNER, pdfId, false)).ok) throw new Error("not shown again");
  is("its preview is refused, and kept by no cache", await preview(pdfId), [404, "no-store", "This product has no preview."]);
  is("its shared card does not name it", await card(pdfId), false);
  is("another product's preview is not touched by it", (await preview(freeId))[2], "This product has no preview right now.");

  part("A mark that cannot be read refuses, never shows the content");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => (commands.some((command) => String(command[1] ?? "").startsWith("nl:csa:keep:")) ? commands.map(() => 42) : real(commands))) as typeof redis.pipeline;
  is("the student is sent away from the course", [await front("student"), await lesson("student")], [`redirect /@${HANDLE}`, `redirect /@${HANDLE}`]);
  is("a worksheet: try again later", (await courseFile("student"))[0], 503);
  is("the feed: try again later, kept by no cache", (await feed()).slice(0, 2), [503, "no-store"]);
  is("an episode: try again later, kept by no cache", await play(), [503, "no-store"]);
  is("the listener's page sends them to the store", await podcastPage("stranger", { t: listener }), `redirect /@${HANDLE}`);
  is("a preview: try again later", (await preview(pdfId))[0], 503);
  is("the shared card does not name it", await card(pdfId), false);
  is("the team's studio download: try again later", (await download("editor", pdfId))[0], 503);
  is("the AI: try again later, nothing sent", await ai({ kind: "page", product: pdfId, readFile: true }), [503, "unavailable"]);
  is("the owner still sees the course", await front("owner"), "shown");
  redis.pipeline = real as typeof redis.pipeline;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
