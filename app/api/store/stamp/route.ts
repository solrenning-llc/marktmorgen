import type { NextRequest } from "next/server";
import { filesOnProduct, setProductStamp } from "@/lib/store";
import { jsonAccess } from "@/lib/studio-route";
import { guardStoreWrite, text } from "@/lib/store-request";
import { stampProblems } from "@/lib/pdf-stamp";
import { readListing } from "@/lib/catalog";
import { isEpub } from "@/lib/product-file";

/**
 * Stamping a product's PDFs and EPUBs with each buyer's email.
 *
 * GET `?id=<product>`: which of its PDFs and EPUBs are handed over unstamped,
 * and why — too big to stamp, a file the stamp could not be written into, or
 * an EPUB that is signed or encrypted (lib/pdf-stamp.ts, StampProblem).
 * POST `{ id, on }`: switches it on or off.
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  const id = request.nextUrl.searchParams.get("id") ?? "";
  try {
    const store = access.store;
    const product = await readListing(store, id);
    if (!store || !product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    const files = filesOnProduct(product);
    const problems = await stampProblems(files);
    return Response.json(
      {
        ok: true,
        problems: files
          .filter((file) => problems.has(file.pathname))
          .map((file) => ({ name: file.name, bytes: file.bytes, kind: isEpub(file) ? "epub" : "pdf", reason: problems.get(file.pathname) })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("reading stamp notes failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products");
  if (!guarded.ok) return guarded.response;
  const id = text(guarded.body.id, 40);
  if (!id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  try {
    const result = await setProductStamp(guarded.ref, id, guarded.body.on === true);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "unknown" ? 404 : 400 });
    return Response.json({ ok: true, id: result.product.id, on: result.product.stamp });
  } catch (error) {
    console.error("changing stamping failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
