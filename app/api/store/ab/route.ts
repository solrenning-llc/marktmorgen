import type { NextRequest } from "next/server";
import { jsonAccess } from "@/lib/studio-route";
import { readPage } from "@/lib/sales-page-store";
import { declaredMeasure, runningTest } from "@/lib/sales-page";
import { expectedShareB, readCounts } from "@/lib/headline-test";

/** How a product's page test is going, a second headline or a second version: `?id=<product>` (lib/headline-test.ts). */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  const id = (request.nextUrl.searchParams.get("id") ?? "").slice(0, 40);
  const store = access.store;
  if (!store || !id) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  try {
    // A page read whose answer is not known is said so, never taken for a page running no test (unit B).
    const page = await readPage(store.statsId, id).catch(() => null);
    if (!page) return Response.json({ ok: false, error: "page_unread" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
    const test = runningTest(page);
    if (!test) return Response.json({ ok: false, error: "none" }, { status: 404 });
    const counts = await readCounts(store.statsId, id, test);
    if(counts.unavailable)return Response.json({ok:false,error:"unavailable"},{status:503,headers:{"Cache-Control":"private, no-store"}});
    return Response.json({ ok: true, counts, currency: store.currency, declared: declaredMeasure(page), shareB: expectedShareB(test) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("reading a page test failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
