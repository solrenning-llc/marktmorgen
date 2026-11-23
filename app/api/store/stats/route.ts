import type { NextRequest } from "next/server";
import { jsonAccess } from "@/lib/studio-route";
import { NOT_COUNTED, countLedger } from "@/lib/person-agenda-read";
import { AllTimeNotCounted, readAllTimeSales, readsSales } from "@/lib/stats";

/**
 * All-time sales, read from the creator's own Stripe account when they ask
 * for them in the studio — the one reading too long to make on every visit
 * to it — and kept ten minutes. What the reading costs beyond this request
 * (its copy by size, Stripe's pages and the PayPal records) is counted in
 * studio requests before anything big is read (lib/stats.ts
 * readAllTimeSales; tests/plan-cost-registry.ts, ALL_TIME_READ); when they
 * cannot be counted, nothing is read and the creator is told why.
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "stats");
  if (access instanceof Response) return access;
  const store = access.store;
  if (!readsSales(store)) return Response.json({ ok: false, error: "stripe" }, { status: 400 });
  const counting = countLedger(store);
  try {
    const sales = await readAllTimeSales(store, counting.count);
    return Response.json({ ok: true, sales }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AllTimeNotCounted) {
      return Response.json({ ok: false, error: "studio_used", message: counting.said.message || NOT_COUNTED }, { status: 429, headers: { "Cache-Control": "private, no-store" } });
    }
    console.error("reading all-time sales failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 502 });
  }
}
