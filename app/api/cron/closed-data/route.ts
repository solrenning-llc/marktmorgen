import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { withCutoff } from "@/lib/fetch-timeout";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { PREPARE_TRIES, eraseClosed } from "@/lib/closed-store-data";
import { finishClosed } from "@/lib/plan-closing";

export const maxDuration = 60;

/**
 * Run every hour by Vercel: deletes the records of the stores that closed
 * (lib/closed-store-data.ts). Most runs find no store due and read two keys;
 * one a day at the most starts a walk of the database for every store that
 * came due since the last, and the runs after it carry it on to the end and
 * email each store's owner when theirs is done. One run at a time. A store
 * whose first step fails is tried again, and once parked is said on every
 * run that looks at the line (lib/closed-store-data.ts, PREPARE_TRIES).
 */
export async function GET(request: NextRequest) {
  return withCutoff(Date.now() + 57_000, () => run(request));
}

async function run(request: NextRequest): Promise<Response> {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  const [got] = await redisPipeline([["SET", "nl:closed:lock", "1", "NX", "EX", 120]]);
  if (got === null) return Response.json({ ok: true, busy: true });
  try {
    const report = await eraseClosed(Date.now() + 45_000, finishClosed);
    if (report.stores || report.finished || report.failed || !report.done) console.log(`closed-data: ${report.stores} stores begun, ${report.failed} whose first step failed (tried again), ${report.pages} pages read, ${report.deleted} keys deleted, ${report.pruned} list members taken out, ${report.finished} stores done`);
    // Said on every run that looks at the line until each is put back: a parked store's records are kept, not deleted.
    if (report.parked) console.error(`closed-data: ${report.parked} closed stores are parked after failing their first step ${PREPARE_TRIES} times; their records are kept until the cause is fixed and they are put back in line (lib/closed-store-data.ts)`);
    return Response.json({ ok: true, ...report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("deleting closed stores' records failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await redisPipeline([["DEL", "nl:closed:lock"]]).catch(() => {});
  }
}
