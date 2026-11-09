import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { withCutoff } from "@/lib/fetch-timeout";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { recountStep } from "@/lib/data-recount";

export const maxDuration = 60;

/**
 * Run every hour by Vercel until it is done: the one-time count of what
 * every store already kept in the database before its data room counted it
 * (lib/data-recount.ts). Each run reads as much as its minute allows and
 * writes down where it stopped; once every store is counted each run is one
 * read and nothing more, until the count's version changes or a count of a
 * store's data could not be confirmed (lib/store-data.ts), which starts it
 * again. One run at a time; its worst month, every run working, is the
 * company's (RECOUNT_RUNS_PER_DAY, NOT_A_COST in tests/plan-cost-registry.ts).
 */
export async function GET(request: NextRequest) {
  return withCutoff(Date.now() + 57_000, () => run(request));
}

async function run(request: NextRequest): Promise<Response> {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  const [got] = await redisPipeline([["SET", "nl:recount:lock", "1", "NX", "EX", 120]]);
  if (got === null) return Response.json({ ok: true, busy: true });
  try {
    const report = await recountStep(Date.now() + 45_000);
    if (!report.done) console.log(`data-recount: ${report.phase}; ${report.stores} stores read, ${report.pages} pages, ${report.measured} keys measured, ${report.applied} rooms set`);
    return Response.json({ ok: true, ...report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("the one-time count of what stores keep failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await redisPipeline([["DEL", "nl:recount:lock"]]).catch(() => {});
  }
}
