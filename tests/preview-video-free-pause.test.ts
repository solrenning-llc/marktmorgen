/**
 * A preview lesson's video is played to anyone, signed in or not: a free copy
 * of a file, exactly like a preview lesson's download. Kept as an uploaded
 * file (not by the video service), it is handed out as a signed address
 * straight from storage and counted against the store's month
 * (lib/learn.ts, signedMedia). Past FREE_PAUSE_ABOVE_BYTES, free copies pause
 * (lib/serve-file.ts, lib/delivery.ts): the page must say the video is paused
 * rather than sign another address for a visitor. A student who holds the
 * course is unaffected.
 *
 * Real page, in-memory Redis; only Blob's signed token is a stand-in
 * (tests/blob-download-attachment-world.ts).
 */
import { renderToReadableStream } from "react-dom/server";
import LessonPage from "@/app/[handle]/course/[product]/[lesson]/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { emailKey, storeKey } from "@/lib/learn";
import { saveCourse, type Course } from "@/lib/course";
import { coursesWords } from "@/lib/buyer-words/courses";
import { FREE_PAUSE_ABOVE_BYTES, monthKey } from "@/lib/delivery";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { NextRequest } from "next/server";
import { answering } from "./security/next-headers";
import { blobWorld, resetBlobWorld } from "./blob-download-attachment-world";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "kiln@example.com";
const STUDENT = "student@example.com";
const BASE = "https://marktmorgen.com";

async function html(run: () => Promise<unknown>): Promise<string> {
  const node = await run();
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return await new Response(stream).text();
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_kiln00001", subscriptionId: "sub_kiln00001", active: true, tier: "creator", period: paidPeriod() });
  const folder = await storeFolder(OWNER);
  const made = await addProduct(OWNER, "Glazing masterclass", "", "149", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const video = { pathname: `stores/${folder}/lesson000001/first-look.mp4`, name: "first-look.mp4", bytes: 2 * 1024 * 1024 * 1024, contentType: "video/mp4", addedAt: "2026-11-05T00:00:00.000Z" };
  const course: Course = {
    id: "d".repeat(32),
    certificate: false,
    startsAt: null,
    modules: [
      {
        id: "module000001",
        title: "Clay bodies",
        dripDays: 0,
        lessons: [{ id: "lesson000001", title: "Free first look", preview: true, video, files: [], link: null, hasBody: false, quiz: null }],
      },
    ],
  } as unknown as Course;
  await saveCourse(course, ROOM, true);
  const attached = await setProductCourse(OWNER, id, { id: course.id, lessons: 1 });
  if (!attached.ok) throw new Error(`no course: ${attached.reason}`);
  const store = (await storeForEmail(OWNER)) as Store;
  const w = coursesWords(store.language);

  // The store's month is past the line where free copies pause.
  await redis.pipeline([["SET", `nl:store:delivery:${folder}:${monthKey()}`, String(FREE_PAUSE_ABOVE_BYTES + 1)]]);

  const page = (cookie?: string) => {
    answering(new NextRequest(`${BASE}/@kilnworks/course/${id}/lesson000001`, { headers: cookie ? { cookie } : {} }));
    return html(() => LessonPage({ params: Promise.resolve({ handle: "@kilnworks", product: id, lesson: "lesson000001" }), searchParams: Promise.resolve({}) }));
  };

  part("a visitor on a preview lesson, past the free pause");
  resetBlobWorld();
  const visitor = await page();
  is("no address to the file is signed for them", blobWorld.issued, 0);
  is("the page says the video is paused", visitor.includes(w.pausedStrong), true);
  // The store has a paid plan: the plan-hours sentence would be untrue here (VR rule 2).
  is("the page does not say the store has no paid plan", visitor.includes("has no paid plan"), false);
  is("it says free previews are paused until next month", visitor.includes("paused until next month"), true);
  is("and that what the visitor bought is unaffected", visitor.includes("Anything you have bought is unaffected"), true);

  part("a student who holds the course: their video plays");
  const started = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([["SET", `nl:learn:paid:${storeKey(store)}:${emailKey(STUDENT)}`, JSON.stringify({ p: { [id]: started }, x: [], r: [] }), "EX", 600]]);
  resetBlobWorld();
  const student = await page(`${SESSION_COOKIE}=${await openSession(STUDENT)}`);
  is("an address is signed for them", blobWorld.issued, 1);
  is("not paused", student.includes(w.pausedStrong), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
