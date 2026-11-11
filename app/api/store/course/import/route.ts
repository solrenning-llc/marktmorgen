import type { NextRequest } from "next/server";
import { dropBody, lessonCount, lessonsInOrder, readCourse, readCourseExact, saveCourse, saveNewBodies } from "@/lib/course";
import { previewCourseImport } from "@/lib/course-import";
import { IMPORT_MAX_BYTES, importUnits, planCourseImport } from "@/lib/course-import-apply";
import { readListing } from "@/lib/catalog";
import { communityOf, courseChanged } from "@/lib/community-index";
import { registerDrip } from "@/lib/learn";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { setCourseLessons, storeForEmail } from "@/lib/store";
import { DataRoomError } from "@/lib/store-data";
import { guardStoreWrite, text } from "@/lib/store-request";
import { countStudio, refusedJson } from "@/lib/studio-route";

/**
 * A course outline imported into a product's new course (260 [KJ5], unit
 * 3b): `{ id, outline }` previews it, `{ id, outline, confirm: true }`
 * saves it. The outline is the creator's own file in Marktmorgen's course
 * outline format (lib/course-import.ts), sent as text and checked here, on
 * the server, both times; a preview is never permission to save.
 *
 * Its own route because the course route reads a few dozen kilobytes and
 * counts one studio request: here the outline's size and its lessons take
 * their studio requests (importUnits) before any of it is read or written.
 *
 * Saving happens only on a course exactly as it is made (lib/course-templates.ts,
 * templateFits), under the course's lock: the lesson texts first, all at
 * once and all or nothing (saveNewBodies), then the outline in one write;
 * if that write fails, the texts go too. Videos and files are not
 * uploaded: they are listed, for the creator to upload through the studio's
 * own uploads, which check the plan's storage and video rights.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", IMPORT_MAX_BYTES, () => "import");
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const id = text(body.id, 40);
  const raw = body.outline;
  if (!id || typeof raw !== "string") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  const confirm = body.confirm === true;

  try {
    const store = await storeForEmail(ref);
    if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });
    const product = await readListing(store, id);
    if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    if (!product.course) return Response.json({ ok: false, error: "not_course" }, { status: 400 });

    // The outline's size is paid for before it is read, in UTF-8 bytes, as the body limit and a studio request's transfer are.
    const bytes = Buffer.byteLength(raw, "utf8");
    const reading = importUnits(bytes, null);
    if (reading > 0) {
      const counted = await countStudio(store, null, reading);
      if (!counted.ok) return refusedJson(counted.reason, counted.message);
    }
    const preview = previewCourseImport(raw);
    if (!preview.ok) return Response.json({ ok: false, error: "invalid", path: preview.path, reason: preview.reason }, { status: 400 });

    const courseInfo = product.course;
    if (!confirm) {
      const course = await readCourse(courseInfo.id);
      if (!course) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
      const plan = planCourseImport(course, preview.draft);
      if (!plan.ok) return Response.json({ ok: false, error: plan.why === "not-new" ? "not_new" : "invalid" }, { status: plan.why === "not-new" ? 409 : 400 });
      // The new lessons' ids are this plan's own, made again when it is saved: the preview says each by its place.
      const places = new Map<string, string>();
      plan.course.modules.forEach((unit, mi) => unit.lessons.forEach((lesson, li) => places.set(lesson.id, `modules[${mi}].lessons[${li}]`)));
      return Response.json({
        ok: true,
        state: "preview",
        modules: plan.course.modules.length,
        lessons: lessonCount(plan.course),
        toUpload: plan.toUpload.map(({ lessonId, kind, path }) => ({ at: places.get(lessonId), kind, path })),
        changed: plan.changed,
      });
    }

    const saving = importUnits(bytes, preview.lessonCount) - reading;
    const counted = await countStudio(store, null, saving);
    if (!counted.ok) return refusedJson(counted.reason, counted.message);

    return await withLock(`nl:course:${courseInfo.id}:lock`, 60, 15_000, async () => {
      const course = await readCourse(courseInfo.id);
      if (!course) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
      const plan = planCourseImport(course, preview.draft);
      if (!plan.ok) return Response.json({ ok: false, error: plan.why === "not-new" ? "not_new" : "invalid" }, { status: plan.why === "not-new" ? 409 : 400 });
      await saveNewBodies(course.id, plan.bodies, store);
      try {
        await saveCourse(plan.course, store);
      } catch (error) {
        // The write may have been kept though its reply was lost: read the outline back exactly first.
        // Kept: the import stands. Not kept: its texts go, so nothing of it is left behind. Unreadable: nothing is taken away.
        const after = await readCourseExact(course.id).catch(() => undefined);
        if (after === undefined) throw error;
        if (!after || JSON.stringify(after) !== JSON.stringify(plan.course)) {
          for (const { lessonId } of plan.bodies) await dropBody(course.id, lessonId, store).catch(() => {});
          throw error;
        }
      }
      const community = communityOf(store);
      if (community) await courseChanged(community, product, course, plan.course).catch(() => {});
      await setCourseLessons(ref, id, lessonCount(plan.course));
      await registerDrip(store, product, plan.course);
      return Response.json({ ok: true, course: plan.course, toUpload: plan.toUpload, changed: plan.changed, lessons: lessonsInOrder(plan.course).length });
    });
  } catch (error) {
    if (error instanceof LockBusyError) return Response.json({ ok: false, error: "busy" }, { status: 409 });
    if (error instanceof DataRoomError) return Response.json({ ok: false, error: "store_full", message: error.message }, { status: 409 });
    console.error("importing a course failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
