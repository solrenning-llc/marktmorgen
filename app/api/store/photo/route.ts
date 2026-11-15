import type { NextRequest } from "next/server";
import { dropPhotoUpload, notePhotoUpload, setPhotoId, settlePhotos, storeForEmail, storeForEmailSeen } from "@/lib/store";
import { MAX_PHOTO_BYTES, decodePhoto, deletePhoto, newPhotoId, writePhoto } from "@/lib/store-photo";
import { guardStoreWrite } from "@/lib/store-request";
import { refusedJson } from "@/lib/studio-route";
import { lockedFor } from "@/lib/two-step";

/**
 * Puts a photo on the creator's page, or takes it off.
 *
 * The body is JSON: `{ "photo": "<base64>" }` to set one, `{ "remove": true }`
 * to clear it. The size cap is checked before the body is read, and what the
 * bytes are is decided by the bytes themselves.
 *
 * The new picture is named in the store record before it is written, then
 * written, then the store pointed at it, and only then is the old one deleted,
 * so the page never points at a photo that is not there, and a photo left by a
 * step that failed is never kept where nothing finds it: the record names it
 * until its deletion is confirmed (Store.photoLeft in lib/store.ts), the next
 * upload deletes it, and the closing walk erases it with the store.
 *
 * A photo is said as gone only on a confirmed delete (CX-123 rule 24). A photo
 * taken off is deleted first and the store stops pointing at it after, so a
 * delete Redis does not confirm is answered as an error, the studio still
 * shows the photo, and the next try deletes it. When the old photo of a
 * replace is not confirmed deleted, the new one is on the page but the answer
 * is an error too; the old one stays named until a later try deletes it.
 */
/**
 * Whether the owner's store record is gone, exactly: its one GET answered an
 * exact nil. A record read back, a record of another owner or shape, a reply
 * of another shape or a read that throws is not known to be gone (rule 24).
 */
async function recordGoneExactly(ref: string): Promise<boolean> {
  let raw: unknown;
  try {
    if (await storeForEmailSeen(ref, (_commands, reply) => { raw = reply; })) return false;
  } catch {
    return false;
  }
  if (!Array.isArray(raw) || raw.length !== 1) return false;
  const entry = Object.getOwnPropertyDescriptor(raw, "0");
  return Boolean(entry && "value" in entry && entry.value === null);
}

export async function POST(request: NextRequest) {
  // Base64 is a third bigger than the bytes it carries, plus the JSON around it.
  // Taking the photo off deletes it: named apart, for a session let in without its second step (lib/two-step.ts).
  const guarded = await guardStoreWrite(request, "page", Math.ceil(MAX_PHOTO_BYTES * 1.4) + 1_000, (sent) => (sent.remove === true ? "remove" : ""));
  if (!guarded.ok) return guarded.response;
  // So does a new one, which deletes the one there.
  if (guarded.store.photoId && (await lockedFor(request, "page", "replace"))) return refusedJson("locked");

  try {
    if (guarded.body.remove === true) {
      const shown = guarded.store.photoId;
      await deletePhoto(shown);
      // Its deletion is confirmed, so it is not named as left.
      const result = await setPhotoId(guarded.ref, null, Date.now(), shown);
      if (!result.ok) {
        return Response.json({ ok: false, error: result.reason }, { status: 400 });
      }
      // One put on the page since this request was read, and any left by an earlier
      // failed step, is deleted too; not said as removed until that is confirmed.
      if (result.store.photoLeft?.length) await settlePhotos(guarded.ref);
      return Response.json({ ok: true, photoId: null });
    }

    const decoded = decodePhoto(guarded.body.photo);
    if (typeof decoded === "string") {
      return Response.json(
        { ok: false, error: decoded },
        { status: decoded === "too_big" ? 413 : 400 },
      );
    }

    // Checked before anything is written, so a signed-in account without a
    // store cannot fill Redis with pictures that belong to nothing.
    if (!(await storeForEmail(guarded.ref))) {
      return Response.json({ ok: false, error: "none" }, { status: 400 });
    }

    const id = newPhotoId();
    const noted = await notePhotoUpload(guarded.ref, id);
    if (!noted.ok) {
      // Photos from earlier tries are still waiting to be deleted: nothing is written for this one.
      return noted.reason === "busy"
        ? Response.json({ ok: false, error: "photo_wait" }, { status: 503 })
        : Response.json({ ok: false, error: noted.reason }, { status: 400 });
    }
    try {
      await writePhoto(decoded.bytes, decoded.type, id);
    } catch (error) {
      // The store was never pointed at it: deleted now when that is confirmed, else still named for later.
      await dropPhotoUpload(guarded.ref, id).catch((drop) => console.error("deleting an unsaved store photo failed", drop));
      throw error;
    }
    // When this throws the photo stays named as waiting, whether or not the store was pointed at it: never deleted
    // here while the store may show it; the next upload deletes it past the wait if the store does not. But the
    // record that names it may be gone: a closing walk prepared from a record read before this upload named the
    // photo, then removed the record (Codex G on #3614). The record is read again, exactly: only when the read
    // answers an exact nil (no record) is nothing left that could show or find this photo, so it goes now. A record
    // that is there, a record of another shape, a reply of another shape or a read that throws keeps the photo as
    // before (rule 24: unknown is never "gone"; Claude 3 on #3614).
    let result: Awaited<ReturnType<typeof setPhotoId>>;
    try {
      result = await setPhotoId(guarded.ref, id);
    } catch (error) {
      if (await recordGoneExactly(guarded.ref)) await deletePhoto(id).catch((drop) => console.error("deleting a store photo whose store closed failed", drop));
      throw error;
    }
    if (!result.ok) {
      // The record that named it is gone: nothing else can find this photo, so it goes now.
      await deletePhoto(id).catch((drop) => console.error("deleting a store photo with no store failed", drop));
      return Response.json({ ok: false, error: result.reason }, { status: 400 });
    }
    // The old photo is said as replaced only once its deletion is confirmed; until then it stays named.
    if (result.store.photoLeft?.length) await settlePhotos(guarded.ref);
    return Response.json({ ok: true, photoId: id });
  } catch (error) {
    console.error("saving the store photo failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
