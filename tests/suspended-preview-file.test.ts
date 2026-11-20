/**
 * A store switched off after a report (lib/takedown.ts) hands a free preview lesson's download to nobody but its
 * students, as the lesson page already does (C7 courses hunt).
 *
 * Before: app/api/store/course/file/route.ts skipped every check for a preview lesson and handed its file to anyone
 * who knew the product and lesson ids, while the lesson page (app/[handle]/course/[product]/[lesson]/page.tsx) sends
 * the same visitor away and the course page hides the link. Synthetic: the in-memory Redis stand-in; the file store is
 * absent, so a download that gets past the door answers something other than 404/403.
 */
import { NextRequest } from "next/server";
import LessonPage from "@/app/[handle]/course/[product]/[lesson]/page";
import { GET as courseFileRoute } from "@/app/api/store/course/file/route";
import { saveCourse, type Course } from "@/lib/course";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setProductCourse, setSubscription, storeFolder } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const OWNER = "suspended-kiln@example.com";
const BASE = "https://marktmorgen.com";

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "shown";
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return "redirect";
    if (digest.includes("404")) return "not found";
    throw error;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "suspkiln", "Suspended Kiln", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_susp00001", subscriptionId: "sub_susp00001", active: true, tier: "creator", period: paidPeriod() });
  const folder = await storeFolder(OWNER);
  const made = await addProduct(OWNER, "Glazing course", "", "149", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const sheet = { pathname: `${folder}/worksheet.pdf`, name: "worksheet.pdf", bytes: 10, contentType: "application/pdf", addedAt: "2026-11-05T00:00:00.000Z" };
  const course = {
    id: "e".repeat(32),
    certificate: true,
    startsAt: null,
    modules: [{ id: "module000001", title: "Clay", dripDays: 0, lessons: [{ id: "lesson000001", title: "Free first look", preview: true, video: null, files: [sheet], link: null, hasBody: false, quiz: null }] }],
  } as unknown as Course;
  await saveCourse(course, ROOM, true);
  const attached = await setProductCourse(OWNER, id, { id: course.id, lessons: 1 });
  if (!attached.ok) throw new Error(`no course: ${attached.reason}`);

  const asked = (path: string) => {
    const request = new NextRequest(`${BASE}${path}`);
    answering(request);
    return request;
  };
  const lesson = () => {
    asked(`/@suspkiln/course/${id}/lesson000001`);
    return outcome(() => LessonPage({ params: Promise.resolve({ handle: "@suspkiln", product: id, lesson: "lesson000001" }), searchParams: Promise.resolve({}) }));
  };
  const file = () => courseFileRoute(asked(`/api/store/course/file?h=suspkiln&p=${id}&l=lesson000001&i=0`));

  part("Open store: the free preview and its download, to anyone");
  is("the preview lesson", await lesson(), "shown");
  const open = await file();
  is("its download gets past the door", open.status !== 404 && open.status !== 403, true);

  part("Store switched off after a report");
  await noteTakedown(OWNER, null, true);
  is("the preview lesson sends a stranger away", await lesson(), "redirect");
  const shut = await file();
  is("and its download is not handed to them either", [403, 404].includes(shut.status), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
