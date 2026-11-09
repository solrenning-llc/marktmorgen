import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { costPauseCode, standingOf, storageRefusal } from "@/lib/plan-standing";
import { storageBrakeFor } from "@/lib/storage-quota";
import { ImageSpaceRefused } from "@/lib/image-space";
import { checkMailPicture, keepMailPicture } from "@/lib/mail-pictures";
import { MAX_MAIL_PICTURE_BYTES } from "@/lib/mail-picture-rules";

/** The picture, as text, and room for the words around it. */
const MAX_BODY_BYTES = 2_000 + Math.ceil(MAX_MAIL_PICTURE_BYTES * 1.4);

/**
 * A picture for an email (lib/mail-pictures.ts): `{ picture }`, a JPEG the
 * studio made smaller, as a data address. Answers with the address the email
 * shows it from. Whoever may write a draft may add one; up to 60 an hour.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "draft", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { ref, store, body } = guarded;
  const raw = typeof body.picture === "string" ? body.picture : "";
  const checked = raw ? checkMailPicture(raw) : "picture";
  if (checked === "picture") return Response.json({ ok: false, error: "picture" }, { status: 400 });
  // Nothing new is stored while a renewal is unpaid (232 [CA1] unit 4).
  { const paused = costPauseCode(store); if (paused) return Response.json({ ok: false, error: paused }, { status: 409 }); }
  const refused = await withinServiceWhy("mail-picture", store.statsId ?? ref, 60, 3_600, store);
  if (refused) return serviceRefusedJson(refused, "slow");
  try {
    const standing = standingOf(store);
    const kept = await keepMailPicture(ref, checked, storageBrakeFor(standing, store.tier));
    return Response.json({ ok: true, ...kept });
  } catch (error) {
    // The store's space (lib/image-space.ts): full is the plan's storage sentence, a room that cannot be read a try-again-later.
    if (error instanceof ImageSpaceRefused) {
      return error.reason === "full"
        ? Response.json({ ok: false, error: storageRefusal(standingOf(store)) }, { status: 409 })
        : Response.json({ ok: false, error: "pictures_room_unknown" }, { status: 503 });
    }
    console.error("keeping an email's picture failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
