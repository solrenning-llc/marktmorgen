import type { NextRequest } from "next/server";
import { jsonAccess } from "@/lib/studio-route";
import { readPage } from "@/lib/sales-page-store";
import { reachShares, readDepth } from "@/lib/page-depth";
import { timeShares } from "@/lib/page-depth-rules";
import { readingsPartial } from "@/lib/page-read";

/** How far down a product's sales page visitors read: `?id=<product>` (lib/page-depth.ts). */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  const id = (request.nextUrl.searchParams.get("id") ?? "").slice(0, 40);
  const store = access.store;
  if (!store || !id) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  try {
    const [page, depth, partial] = await Promise.all([readPage(store.statsId, id), readDepth(store.statsId, id), readingsPartial(store)]);
    // While a second version of the whole page is tested, each visitor reads
    // one of two pages, so how far down "the page" is read is not a number
    // that means anything: none is given until the test ends.
    // What stops visitors, and how far a video is watched, are about the product, not one of two pages: said either way.
    // How long measured visitors stayed (639 [GL7](25)) is about the product too, so it is said either way.
    // Whether this month's readings went past their ceiling, so these are partial (lib/page-read.ts, readingsPartial).
    const extra = { whyNot: depth.whyNot, videos: depth.videos, asking: store.askWhyNot, time: timeShares(depth.time), partial };
    if (page.variant) return Response.json({ ok: true, shares: {}, visitors: 0, ...extra }, { headers: { "Cache-Control": "private, no-store" } });
    const result = reachShares(page.blocks.map((b) => b.id), depth.stopped, depth.visitors);
    return Response.json({ ok: true, ...result, ...extra }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("reading how far a page is read failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
