import type { NextRequest } from "next/server";
import { setProductPublication } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";

/**
 * The creator's answer to whether a product is an electronically supplied publication (an e-book, an e-magazine, an
 * e-newspaper), for VAT (lib/catalog.ts, Product.publication; 789 [IV1] step 3, unit 5a).
 *
 * POST `{ id, publication }`: `true` (it is one), `false` (it is not) or `null` (not answered). Anything else is refused
 * with 400, so a bad value never reads as "not a publication" and VAT is never collected on a guess.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products");
  if (!guarded.ok) return guarded.response;
  const id = text(guarded.body.id, 40);
  if (!id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const value = guarded.body.publication;
  if (value !== true && value !== false && value !== null) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  try {
    const result = await setProductPublication(guarded.ref, id, value);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "unknown" ? 404 : 400 });
    return Response.json({ ok: true, id: result.product.id, publication: result.product.publication ?? null });
  } catch (error) {
    console.error("changing the publication answer failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
