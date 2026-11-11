/**
 * 260 [KJ5], unit 3b: the course import route (app/api/store/course/import).
 * Its own route, because the course route takes a few dozen kilobytes and
 * counts one studio request each. A preview is checked on the server and
 * saves nothing; saving needs `confirm: true`, under the course's lock, only
 * on a course exactly as it is made. Studio requests in proportion to the
 * outline's size and lessons are taken before the work. The texts go first,
 * all at once (saveNewBodies), then the outline in one write; if that write
 * fails, the texts go too. Videos and files are listed, never uploaded.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { POST as importRoute } from "@/app/api/store/course/import/route";
import { COURSE_IMPORT_FORMAT } from "@/lib/course-import";
import { IMPORT_BYTES_PER_UNIT, importUnits } from "@/lib/course-import-apply";
import { lessonCount, lessonsInOrder, readBody, readCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { takeData } from "@/lib/store-data";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const outline = (modules: unknown[]) => JSON.stringify({ format: COURSE_IMPORT_FORMAT, ownsContent: true, title: "Pottery basics", modules });
const good = outline([
  { title: "Start here", lessons: [
    { title: "Welcome", text: "Clay, water and patience.", video: "media/welcome.mp4", files: ["files/kit.pdf"] },
    { title: "Tools", text: "", video: null, files: [] },
  ] },
  { title: "Throwing", lessons: [{ title: "Centering", text: "Keep your elbows in.", video: null, files: [] }] },
]);

part("Studio requests in proportion to the work");
is("a small preview takes none more", importUnits(1_000, null), 0);
is("a large one takes one for each part of its size", importUnits(IMPORT_BYTES_PER_UNIT * 3 + 1, null), 3);
is("a save takes one for each lesson and one for the outline", importUnits(1_000, 3), 4);
const source = readFileSync("app/api/store/course/import/route.ts", "utf8");
is("taken before the texts are written", source.indexOf("countStudio(") > 0 && source.indexOf("countStudio(") < source.indexOf("saveNewBodies("), true);
is("the outline's size is taken before it is read", source.indexOf("importUnits(raw.length, null)") > 0 && source.indexOf("importUnits(raw.length, null)") < source.indexOf("previewCourseImport("), true);

async function main(): Promise<void> {
  const owner = "importer@example.com";
  await claimHandle(owner, "potteryschool", "Pottery School", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Importxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_imp", subscriptionId: "sub_imp", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(owner);
  const call = async (route: typeof importRoute, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const post = (body: Record<string, unknown>) => call(importRoute, "/api/store/course/import", body);
  const made = await addProduct(owner, "Pottery Basics", "", "40");
  const id = made.ok ? made.product.id : "";

  part("Only a product that has a course");
  is("refused", (await post({ id, outline: good })).body.error, "not_course");
  is("a course is made", (await call(courseRoute, "/api/store/course", { action: "enable", id })).body.ok, true);
  const courseId = (await readListing((await storeForEmail(owner))!, id))!.course!.id;

  part("A preview is checked on the server and saves nothing");
  const preview = await post({ id, outline: good });
  is("answered", [preview.status, preview.body.ok, preview.body.state], [200, true, "preview"]);
  is("what it would make", [preview.body.modules, preview.body.lessons], [2, 3]);
  is("what is left to upload, by place", preview.body.toUpload, [
    { at: "modules[0].lessons[0]", kind: "video", path: "media/welcome.mp4" },
    { at: "modules[0].lessons[0]", kind: "file", path: "files/kit.pdf" },
  ]);
  is("nothing changed by cleaning", preview.body.changed, []);
  is("the course is untouched", lessonCount((await readCourse(courseId))!), 0);

  part("An outline the preview refuses says where");
  const bad = await post({ id, outline: outline([{ title: "", lessons: [] }]), confirm: true });
  is("refused with its place", [bad.status, bad.body.error, typeof bad.body.path, typeof bad.body.reason], [400, "invalid", "string", "string"]);
  is("nothing saved", lessonCount((await readCourse(courseId))!), 0);
  is("not text: refused", (await post({ id, outline: { format: COURSE_IMPORT_FORMAT } })).status, 400);

  part("A full store gets nothing written");
  const store = (await storeForEmail(owner))!;
  // A change may grow the room only so far at once: filled in steps, each smaller, until even ten bytes do not fit.
  let n = 0;
  for (let step = 1_000_000; step >= 10; step = Math.floor(step / 10)) {
    while ((await takeData(store, [{ slot: `test:fill:${n}`, bytes: step, set: true }])).ok) n += 1;
  }
  is("filled", (await takeData(store, [{ slot: "test:last", bytes: 10, set: true }])).ok, false);
  const full = await post({ id, outline: good, confirm: true });
  is("said as full", [full.status, full.body.error], [409, "store_full"]);
  is("no lesson saved", lessonCount((await readCourse(courseId))!), 0);
  for (let i = 0; i < n; i += 1) await takeData(store, [{ slot: `test:fill:${i}`, bytes: 0, set: true }]);

  part("If the outline cannot be written, its texts go too");
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SET" && c[1] === `nl:course:${courseId}`)) throw new Error("synthetic outage");
    return original(commands);
  }) as typeof redis.pipeline;
  let broken: { status: number; body: Record<string, unknown> };
  try {
    broken = await post({ id, outline: good, confirm: true });
  } finally {
    redis.pipeline = original;
  }
  is("failed", broken.status, 500);
  is("no lesson saved", lessonCount((await readCourse(courseId))!), 0);
  is("no text left behind", redis.run(["SCAN", 0, "MATCH", `nl:course:${courseId}:body:*`, "COUNT", 1000]), ["0", []]);

  part("Saved only when confirmed, whole");
  const saved = await post({ id, outline: good, confirm: true });
  is("answered", [saved.status, saved.body.ok], [200, true]);
  const kept = (await readCourse(courseId))!;
  is("modules and lessons in order", lessonsInOrder(kept).map(({ lesson, unit }) => `${unit.title}/${lesson.title}`), ["Start here/Welcome", "Start here/Tools", "Throwing/Centering"]);
  const ids = lessonsInOrder(kept).map(({ lesson }) => lesson.id);
  is("texts kept", [await readBody(courseId, ids[0]), await readBody(courseId, ids[1]), await readBody(courseId, ids[2])], ["Clay, water and patience.", "", "Keep your elbows in."]);
  is("the product counts its lessons", (await readListing((await storeForEmail(owner))!, id))!.course!.lessons, 3);
  is("left to upload, by the new lessons", (saved.body.toUpload as { lessonId: string }[]).map((u) => u.lessonId), [ids[0], ids[0]]);

  part("A course with lessons is never written over");
  const again = await post({ id, outline: good, confirm: true });
  is("refused", [again.status, again.body.error], [409, "not_new"]);
  is("as it was", lessonCount((await readCourse(courseId))!), 3);
  done();
}

void main();
