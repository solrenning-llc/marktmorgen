import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readListingExactly } from "@/lib/catalog";
import { isTakenDown, makeDraftPreview, revokeDraftPreview } from "@/lib/draft-preview";
import { heldRefusal } from "@/lib/child-safety";

/**
 * A draft's private preview link (754 [STN1], unit 4a; lib/draft-preview.ts).
 *
 * `{ action: "make", id }` makes the link of a product that is not on the store
 * yet, in place of the one before, and answers its code once with when it ends;
 * `{ action: "revoke", id }` ends it at once. Whoever can edit the store's
 * products may do either (lib/team-roles.ts). A published product gets no link:
 * its own page is the preview, and so is a product taken down after a notice
 * until it is published again, and every product of a store switched off.
 * Nothing here reads or writes anything else.
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
    // A store switched off after notices shows nothing, previews included (Claude 6 on #3439).
    if (guarded.store.suspended) return Response.json({ ok: false, error: "suspended" }, { status: 409, headers: noStore });
    const product = await readListingExactly(guarded.store, id);
    if (product === "unknown") throw new Error("The product could not be read");
    if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404, headers: noStore });
    if (!product.hidden) return Response.json({ ok: false, error: "not_draft" }, { status: 409, headers: noStore });
    // Held for a child-safety report (lib/child-safety.ts): no link, for anyone; a mark that cannot be read is not a yes.
    const held = await heldRefusal(guarded.store, product.id);
    if (held) return held;
    // Taken down after a notice: no link until it is published again (lib/takedown.ts, the product route).
    if (await isTakenDown(guarded.store, product.id)) return Response.json({ ok: false, error: "taken_down" }, { status: 409, headers: noStore });
    const made = await makeDraftPreview(guarded.store, product.id);
    return Response.json({ ok: true, code: made.code, expiresAt: made.expiresAt }, { headers: noStore });
  } catch (error) {
    console.error("draft preview link failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 503, headers: noStore });
  }
}
