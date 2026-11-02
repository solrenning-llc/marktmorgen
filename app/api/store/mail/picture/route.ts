import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { costPauseCode } from "@/lib/plan-standing";
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
    const kept = await keepMailPicture(ref, checked);
    return Response.json({ ok: true, ...kept });
  } catch (error) {
    console.error("keeping an email's picture failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
