import type { NextRequest } from "next/server";
import { setPhotoId, storeForEmail } from "@/lib/store";
import {
  MAX_PHOTO_BYTES,
  decodePhoto,
  deletePhoto,
  writePhoto,
} from "@/lib/store-photo";
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
 * The new picture is written and the store pointed at it before the old one is
 * deleted, so the page never points at a photo that is not there.
 */
export async function POST(request: NextRequest) {
  // Base64 is a third bigger than the bytes it carries, plus the JSON around it.
  // Taking the photo off deletes it: named apart, for a session let in without its second step (lib/two-step.ts).
  const guarded = await guardStoreWrite(request, "page", Math.ceil(MAX_PHOTO_BYTES * 1.4) + 1_000, (sent) => (sent.remove === true ? "remove" : ""));
  if (!guarded.ok) return guarded.response;
  // So does a new one, which deletes the one there.
  if (guarded.store.photoId && (await lockedFor(request, "page", "replace"))) return refusedJson("locked");

  try {
    if (guarded.body.remove === true) {
      const result = await setPhotoId(guarded.ref, null);
      if (!result.ok) {
        return Response.json({ ok: false, error: result.reason }, { status: 400 });
      }
      await deletePhoto(result.was);
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

    const id = await writePhoto(decoded.bytes, decoded.type);
    const result = await setPhotoId(guarded.ref, id);
    if (!result.ok) {
      await deletePhoto(id);
      return Response.json({ ok: false, error: result.reason }, { status: 400 });
    }
    await deletePhoto(result.was);
    return Response.json({ ok: true, photoId: id });
  } catch (error) {
    console.error("saving the store photo failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
