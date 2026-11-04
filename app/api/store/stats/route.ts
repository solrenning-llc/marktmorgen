import type { NextRequest } from "next/server";
import { jsonAccess } from "@/lib/studio-route";
import { SalesNotCounted, readAllTimeSales, readsSales } from "@/lib/stats";
import { salesCount } from "@/lib/segments";
import { NOT_COUNTED, countLedger } from "@/lib/person-agenda-read";

/**
 * All-time sales, read from the creator's own Stripe account when they ask
 * for them in the studio — the one reading too long to make on every visit
 * to it — and kept ten minutes. What it reads is counted in the studio's
 * requests before it is read: the copy by its size, Stripe and the PayPal
 * sales again as a reading of the buyers (lib/segments.ts, salesCount).
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "stats");
  if (access instanceof Response) return access;
  const store = access.store;
  if (!readsSales(store)) return Response.json({ ok: false, error: "stripe" }, { status: 400 });
  const counting = countLedger(store);
  try {
    const sales = await readAllTimeSales(store, salesCount(store, counting.count));
    return Response.json({ ok: true, sales }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof SalesNotCounted) return Response.json({ ok: false, error: "studio_used", message: counting.said.message || NOT_COUNTED }, { status: 429 });
    console.error("reading all-time sales failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 502 });
  }
}
