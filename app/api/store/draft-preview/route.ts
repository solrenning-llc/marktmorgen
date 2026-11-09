import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readListing } from "@/lib/catalog";
import { makeDraftPreview, revokeDraftPreview } from "@/lib/draft-preview";

/**
 * A draft's private preview link (754 [STN1], unit 4a; lib/draft-preview.ts).
 *
 * `{ action: "make", id }` makes the link of a product that is not on the store
 * yet, in place of the one before, and answers its code once with when it ends;
 * `{ action: "revoke", id }` ends it at once. Whoever can edit the store's
 * products may do either (lib/team-roles.ts). A published product gets no link:
 * its own page is the preview. Nothing here reads or writes anything else.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 1_000);
  if (!guarded.ok) return guarded.response;
  const action = text(guarded.body.action, 10);
  const id = text(guarded.body.id, 40);
  if ((action !== "make" && action !== "revoke") || !id) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  const noStore = { "Cache-Control": "private, no-store" };
  try {
    if (action === "revoke") {
      await revokeDraftPreview(guarded.store, id);
      return Response.json({ ok: true }, { headers: noStore });
    }
    const product = await readListing(guarded.store, id);
    if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404, headers: noStore });
    if (!product.hidden) return Response.json({ ok: false, error: "not_draft" }, { status: 409, headers: noStore });
    const made = await makeDraftPreview(guarded.store, product.id);
    return Response.json({ ok: true, code: made.code, expiresAt: made.expiresAt }, { headers: noStore });
  } catch (error) {
    console.error("draft preview link failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 503, headers: noStore });
  }
}
