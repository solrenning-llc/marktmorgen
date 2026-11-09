import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { withCutoff } from "@/lib/fetch-timeout";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { recountStep } from "@/lib/data-recount";
import { REVIEW_RECOUNT_HOUR_UTC, recountWaiting } from "@/lib/reviews";

export const maxDuration = 60;

/**
 * Run every hour by Vercel until it is done: the one-time count of what
 * every store already kept in the database before its data room counted it
 * (lib/data-recount.ts). Each run reads as much as its minute allows and
 * writes down where it stopped; once every store is counted each run is one
 * read and nothing more, until the count's version changes. One run at a
 * time.
 *
 * Once a day, at REVIEW_RECOUNT_HOUR_UTC, it first counts again the products
 * whose review numbers were left waiting by a recount that failed for a
 * moment (lib/reviews.ts, recountWaiting): capped, inside its own ten seconds,
 * never on a page that shows them.
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
    if (new Date().getUTCHours() === REVIEW_RECOUNT_HOUR_UTC) {
      // Its own try: a failure here never stops the data count below, and is tried again the next day.
      try {
        const reviews = await recountWaiting(Date.now() + 10_000);
        if (reviews.recounted || reviews.unsure || reviews.busy || reviews.capped) console.log(`reviews: daily recount; ${reviews.stores} stores read, ${reviews.recounted} products counted again, ${reviews.unsure} unsure, ${reviews.busy} busy${reviews.capped ? ", the rest on the next pass" : ""}`);
      } catch (error) {
        console.error("the daily recount of review numbers left waiting failed; tried again tomorrow", error);
      }
    }
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
