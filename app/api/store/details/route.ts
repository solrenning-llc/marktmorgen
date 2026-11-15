import type { NextRequest } from "next/server";
import { MAX_BIO_LENGTH, MAX_NAME_LENGTH, updateDetails } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { storeImitation } from "@/lib/brand-imitation-rules";

/** Changes the name and the description shown on the creator's public page. */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page");
  if (!guarded.ok) return guarded.response;

  const name = text(guarded.body.name, MAX_NAME_LENGTH);
  const bio = text(guarded.body.bio, MAX_BIO_LENGTH);
  // Never a name or a line that reads as Marktmorgen's own (568 [GD2] (c), unit 3); nothing is saved.
  const posing = storeImitation({ name, bio });
  if (posing) return Response.json({ ok: false, error: "brand_imitation", field: posing.field }, { status: 409 });

  try {
    const result = await updateDetails(guarded.ref, name, bio);
    if (!result.ok) {
      return Response.json({ ok: false, error: result.reason }, { status: 400 });
    }
    return Response.json({
      ok: true,
      name: result.store.name,
      bio: result.store.bio,
    });
  } catch (error) {
    console.error("saving the store details failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
