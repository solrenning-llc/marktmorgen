/**
 * A course lesson's file that anyone may preview is a free copy: nobody paid
 * for it, and anyone who knows the address can fetch it without signing in.
 * It must pause with the store's other free downloads past
 * FREE_PAUSE_ABOVE_BYTES (lib/serve-file.ts, lib/delivery.ts), exactly as a
 * free product's copy and a PDF preview do. A lesson that is not a preview
 * goes to a student who holds the course and is served as a paid file,
 * whatever the counter says.
 *
 * Real route, in-memory Redis; the file stores are not set up here, so a file
 * that gets past the door answers 502 (no address could be signed).
 */
import { NextRequest } from "next/server";
import { GET as courseFileRoute } from "@/app/api/store/course/file/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { emailKey, storeKey } from "@/lib/learn";
import { saveCourse, type Course } from "@/lib/course";
import { FREE_PAUSE_ABOVE_BYTES, monthKey } from "@/lib/delivery";
import { REDIRECT_ABOVE_BYTES } from "@/lib/product-file";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "kiln@example.com";
const STUDENT = "student@example.com";
const BASE = "https://marktmorgen.com";
const PAUSED = "This free download is paused until next month. This store has reached its free download allowance for this month. Anything you have bought is unaffected. Please try again next month or contact the creator.";

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
  // A big file, as a recorded lesson's slides can be: past the size that is redirected, in this store's folder.
  const sheet = { pathname: `stores/${folder}/lesson000001/slides.pdf`, name: "slides.pdf", bytes: REDIRECT_ABOVE_BYTES + 1, contentType: "application/pdf", addedAt: "2026-11-05T00:00:00.000Z" };
  const course: Course = {
    id: "d".repeat(32),
    certificate: false,
    startsAt: null,
    modules: [
      {
        id: "module000001",
        title: "Clay bodies",
        dripDays: 0,
        lessons: [
          { id: "lesson000001", title: "Free first look", preview: true, video: null, files: [sheet], link: null, hasBody: false, quiz: null },
          { id: "lesson000002", title: "Paid lesson", preview: false, video: null, files: [{ ...sheet, pathname: `stores/${folder}/lesson000002/answers.pdf`, name: "answers.pdf" }], link: null, hasBody: false, quiz: null },
        ],
      },
    ],
  } as unknown as Course;
  await saveCourse(course, ROOM, true);
  const attached = await setProductCourse(OWNER, id, { id: course.id, lessons: 2 });
  if (!attached.ok) throw new Error(`no course: ${attached.reason}`);
  const store = (await storeForEmail(OWNER)) as Store;

  // The store's month is past the line where free copies pause.
  await redis.pipeline([["SET", `nl:store:delivery:${folder}:${monthKey()}`, String(FREE_PAUSE_ABOVE_BYTES + 1)]]);

  const ask = (lesson: string, cookie?: string) => {
    const request = new NextRequest(`${BASE}/api/store/course/file?h=kilnworks&p=${id}&l=${lesson}&i=0`, { headers: cookie ? { cookie } : {} });
    answering(request);
    return courseFileRoute(request);
  };

  part("a preview lesson's file, fetched by anyone, past the free pause");
  const free = await ask("lesson000001");
  is("paused like every other free copy", [free.status, await free.text()], [429, PAUSED]);

  part("a lesson a student paid for: served whatever the counter says");
  const started = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([["SET", `nl:learn:paid:${storeKey(store)}:${emailKey(STUDENT)}`, JSON.stringify({ p: { [id]: started }, x: [], r: [] }), "EX", 600]]);
  const paid = await ask("lesson000002", `${SESSION_COOKIE}=${await openSession(STUDENT)}`);
  is("not paused (the file store is absent here, so it cannot be signed)", paid.status !== 429 && paid.status !== 403 && paid.status !== 404, true);
  const theirs = await ask("lesson000001", `${SESSION_COOKIE}=${await openSession(STUDENT)}`);
  is("the preview lesson's file, to a student who holds the course: theirs, not paused", theirs.status !== 429 && theirs.status !== 403 && theirs.status !== 404, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
