import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import { takeData } from "@/lib/store-data";
import { reserveStoreUpload } from "@/lib/upload-budget";
import type { NextRequest } from "next/server";
import { readKind } from "@/lib/catalog";
import { ITEM_ID_PATTERN, VIDEO_TYPES, findLesson, readCourses } from "@/lib/course";
import { rememberFolderOwner } from "@/lib/delivery";
import { MAX_FILE_BYTES, safeFileName } from "@/lib/product-file";
import { costPauseCode, storageRefusal, standingOf } from "@/lib/plan-standing";
import { fits, storageBrakeFor, storageUsed } from "@/lib/storage-quota";
import { storeFolder, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { isStreamConfigured, openUpload } from "@/lib/stream";
import { VIDEO_RECORD_BYTES } from "@/lib/stream-rules";

/** Doors one store may ask for in an hour. A course of two hundred lessons filled in one sitting asks for two hundred. */
const DOORS_PER_HOUR = 300;

/**
 * Opens the door for a lesson's video to go from the studio's browser
 * straight to the service that keeps it in several sizes (lib/stream.ts).
 *
 * `{ lessonId, name, bytes, type }`. The answer is the service's address and
 * the four values it wants with every piece, good for that one video for a
 * day, and the path to tell the lesson when the last piece is in
 * (app/api/store/course, action "media").
 *
 * Asked for only what a signed-in creator may do, as the door into the file
 * store is (app/api/store/file): the lesson has to be one of this store's
 * own, the file a video of a kind every browser plays and no bigger than a
 * file here may be, and the store under the storage brake
 * (lib/storage-quota.ts), which counts what the service keeps too.
 *
 * Answers `off`, not found, while the service is not set up. The studio
 * then uploads the video the way it always has, into the file store.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 4_000);
  if (!guarded.ok) return guarded.response;
  if (!isStreamConfigured()) return Response.json({ ok: false, error: "off" }, { status: 404 });
  const { ref, body } = guarded;

  const lessonId = text(body.lessonId, 20);
  const type = text(body.type, 60);
  const bytes = typeof body.bytes === "number" && Number.isFinite(body.bytes) ? Math.floor(body.bytes) : 0;
  if (!ITEM_ID_PATTERN.test(lessonId)) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  if (!VIDEO_TYPES.includes(type)) return Response.json({ ok: false, error: "video_type" }, { status: 400 });
  if (bytes <= 0) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  if (bytes > MAX_FILE_BYTES) return Response.json({ ok: false, error: "too_big" }, { status: 400 });

  try {
    const store = await storeForEmail(ref);
    if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });
    const courseIds = (await readKind(store, "course")).flatMap((p) => (p.course ? [p.course.id] : []));
    const courses = await readCourses(courseIds);
    if (![...courses.values()].some((course) => findLesson(course, lessonId) !== null)) {
      return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    }

    // An unbounded direct-provider grant is unavailable; the studio can use
    // its existing R2 file fallback instead, subject to that path's budget.
    // Nothing new is stored while a renewal is unpaid (232 [CA1] unit 4).
    { const paused = costPauseCode(store); if (paused) return Response.json({ ok: false, error: paused }, { status: 409 }); }
    if (!(await reserveStoreUpload(store, bytes, "stream"))) return Response.json({ ok: false, error: "off" }, { status: 404 });
    const folder = await storeFolder(ref);
    const refused = await withinServiceWhy("stream-door", folder, DOORS_PER_HOUR, 3600, store);
    if (refused) return serviceRefusedJson(refused, "slow_down");
    // What a store may keep goes by where it stands with its plan (lib/plan-standing.ts).
    const standing = standingOf(store);
    const held = await storageUsed(folder, storageBrakeFor(standing, store.tier));
    if (held.available === false) return Response.json({ ok: false, error: "video_unavailable" }, { status: 503 });
    if (!fits(held, bytes)) return Response.json({ ok: false, error: storageRefusal(standing) }, { status: 400 });
    await rememberFolderOwner(folder, ref);
    // The video's records (what the service says of it, its captions' languages) take room in the store's data room first.
    if (!(await takeData(store, [{ slot: "sv", bytes: VIDEO_RECORD_BYTES }])).ok) return Response.json({ ok: false, error: "store_full" }, { status: 409 });

    const opened = await openUpload({ folder, lessonId, name: safeFileName(text(body.name, 200)), bytes, type });
    if (!opened.ok) {
      return Response.json({ ok: false, error: opened.reason === "off" ? "off" : "video_unavailable" }, { status: opened.reason === "off" ? 404 : 503 });
    }
    return Response.json({ ok: true, door: opened.door }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "storage_unavailable") return Response.json({ ok: false, error: "video_unavailable" }, { status: 503 });
    console.error("opening the door for a lesson video failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
