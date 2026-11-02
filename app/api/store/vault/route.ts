import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import { reserveStoreUpload, reserveUploadControl } from "@/lib/upload-budget";
import { openReservedVault, closeReservedVault, abortReservedVault } from "@/lib/vault-storage";
import type { NextRequest } from "next/server";
import { readKind } from "@/lib/catalog";
import { ITEM_ID_PATTERN, findLesson, readCourses } from "@/lib/course";
import { rememberFolderOwner } from "@/lib/delivery";
import { ALLOWED_CONTENT_TYPES, MAX_FILE_BYTES, safeFileName } from "@/lib/product-file";
import { costPauseCode, storageRefusal, standingOf } from "@/lib/plan-standing";
import { storageBrakeFor } from "@/lib/storage-quota";
import { ownsDeliveryId, storeFolder, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { isVaultConfigured, signPieces } from "@/lib/vault";
import { PIECES_PER_ASK, readVaultPath } from "@/lib/vault-rules";

/** Uploads one store may open in an hour, and times it may ask for addresses: a full catalog, moved in one sitting. */
const OPENS_PER_HOUR = 600;
const ASKS_PER_HOUR = 6_000;

/**
 * The door a sold file goes through from the studio's browser straight to
 * the file store that charges nothing for a download (lib/vault.ts).
 *
 *   { action: "open", ownerId, name, bytes, type }   opens an upload onto a
 *       product, a price option or a lesson, and answers its path and how
 *       many pieces it goes up in
 *   { action: "sign", pathname, numbers }            addresses for those pieces
 *   { action: "done", pathname, etags }              joins the pieces; answers
 *       the file as the store itself measured it
 *   { action: "abort", pathname }                    gives the upload up
 *
 * Asked for only what a signed-in creator may do, exactly as the door into
 * the host's own store is (app/api/store/file): the product, option or
 * lesson has to be one of this store's own, the file of a kind that may be
 * sold and no bigger than a file here may be, and the store under the
 * storage brake (lib/storage-quota.ts). Every later step is for a path in
 * this store's own folder, read from the session and never from the request.
 *
 * Answers `off`, not found, while that store is not set up. The studio then
 * uploads the way it always has.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 60_000);
  if (!guarded.ok) return guarded.response;
  if (!isVaultConfigured()) return Response.json({ ok: false, error: "off" }, { status: 404 });
  const { ref, body } = guarded;
  const action = text(body.action, 10);
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

  let quotaRefusal = "storage_full";
  try {
    const store = await storeForEmail(ref);
    if (!store) return fail("none");
    const folder = await storeFolder(ref);

    if (action === "open") {
      const ownerId = text(body.ownerId, 40);
      const type = text(body.type, 120);
      const bytes = typeof body.bytes === "number" && Number.isFinite(body.bytes) ? Math.floor(body.bytes) : 0;
      if (!ALLOWED_CONTENT_TYPES.includes(type)) return fail("wrong_type");
      if (bytes <= 0) return fail("invalid");
      if (bytes > MAX_FILE_BYTES) return fail("too_big");
      // A price option owns a folder exactly as a product does, and a lesson
      // of one of the store's courses owns one too.
      if (!ownsDeliveryId(store, ownerId)) {
        const courseIds = (await readKind(store, "course")).flatMap((p) => (p.course ? [p.course.id] : []));
        const courses = ITEM_ID_PATTERN.test(ownerId) ? await readCourses(courseIds) : new Map();
        if (![...courses.values()].some((course) => findLesson(course, ownerId) !== null)) return fail("unknown", 404);
      }
      const refused = await withinServiceWhy("vault-open", folder, OPENS_PER_HOUR, 3600, store);
      if (refused) return serviceRefusedJson(refused, "slow_down");
      // What a store may keep goes by where it stands with its plan (lib/plan-standing.ts).
      const standing = standingOf(store);
      quotaRefusal = storageRefusal(standing);
      if (body.multipart !== true) return fail("upload_refresh", 409);
      // Nothing new is stored while a renewal is unpaid (232 [CA1] unit 4).
      { const paused = costPauseCode(store); if (paused) return fail(paused, 409); }
      if (!(await reserveStoreUpload(store, bytes, "r2"))) return fail("upload_budget_unavailable", 503);
      await rememberFolderOwner(folder, ref);

      const opened = await openReservedVault({ folder, ownerId, name: safeFileName(text(body.name, 200)), bytes, type, multipart: true }, storageBrakeFor(standing, store.tier));
      if (!opened.ok) return fail(opened.reason === "off" ? "off" : opened.reason === "invalid" ? "invalid" : "files_unavailable", opened.reason === "off" ? 404 : opened.reason === "invalid" ? 400 : 503);
      return Response.json({ ok: true, upload: opened.upload }, { headers: { "Cache-Control": "no-store" } });
    }

    const pathname = text(body.pathname, 400);
    if (readVaultPath(pathname)?.folder !== folder) return fail("unknown", 404);

    if (action === "sign") {
      const numbers = Array.isArray(body.numbers) ? body.numbers.filter((n): n is number => Number.isInteger(n)) : [];
      if (!numbers.length || numbers.length > PIECES_PER_ASK) return fail("invalid");
      const refused = await withinServiceWhy("vault-sign", folder, ASKS_PER_HOUR, 3600, store);
      if (refused) return serviceRefusedJson(refused, "slow_down");
      if (!(await reserveUploadControl(store))) return fail("upload_budget_unavailable", 503);
      const pieces = await signPieces(pathname, numbers);
      if (!pieces) return fail("unknown", 404);
      return Response.json({ ok: true, pieces }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "done") {
      const etags = Array.isArray(body.etags) ? body.etags.filter((e): e is string => typeof e === "string") : [];
      // Completion was authorized with the original upload. Do not strand it
      // because the current admission budget is paused or the month changed.
      const closed = await closeReservedVault(pathname, etags);
      if (!closed.ok) {
        const status = closed.reason === "unknown" ? 404 : closed.reason === "unavailable" ? 503 : closed.reason === "off" ? 404 : 400;
        return fail(closed.reason === "unavailable" ? "files_unavailable" : closed.reason, status);
      }
      return Response.json({ ok: true, file: closed.file }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "abort") {
      if (!(await abortReservedVault(pathname))) return fail("files_unavailable", 503);
      return Response.json({ ok: true });
    }

    return fail("invalid");
  } catch (error) {
    if (error instanceof Error && error.message === "storage_limit") return fail(quotaRefusal);
    if (error instanceof Error && (error.message === "storage_pending" || error.message === "storage_busy")) return fail("uploads_pending", 409);
    if (error instanceof Error && error.message === "busy") return fail("slow_down", 429);
    if (error instanceof Error && error.message.startsWith("storage_")) return fail("files_unavailable", 503);
    console.error("a file upload's door failed", error);
    return fail("server_error", 500);
  }
}
