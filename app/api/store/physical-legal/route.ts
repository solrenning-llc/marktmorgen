import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { StoreFullError, setProductLegal } from "@/lib/store";
import { checkLegalWrite } from "@/lib/physical-legal-record";

/**
 * Saves the legal information of a product the creator ships (618 [SZ2];
 * lib/physical-legal-record.ts): `{ id, legal: { safety, prop65, quantities } }`,
 * or `{ id, legal: null }` to clear it. Every value is checked here; anything
 * invalid is refused with the fields it is about (`problems`), never cut.
 * Information fields only: saving them says nothing about compliance.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 16_000);
  if (!guarded.ok) return guarded.response;
  const { body, ref } = guarded;
  const id = text(body.id, 40);
  if (!id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  if (!Object.hasOwn(body, "legal")) return Response.json({ ok: false, error: "legal_shape" }, { status: 400 });
  let legal = null;
  if (body.legal !== null) {
    const read = checkLegalWrite(body.legal);
    if (!read.ok) return Response.json({ ok: false, error: "invalid", problems: read.problems }, { status: 400 });
    legal = read.legal;
  }
  try {
    const result = await setProductLegal(ref, id, legal);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "unknown" ? 404 : 400 });
    return Response.json({ ok: true, product: result.product });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("saving legal fields failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
