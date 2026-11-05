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
 * whose first step fails is tried again by itself, a day later and, once
 * parked, once a week; a store the walk could not finish is walked again with
 * the next walk. Both are said on every run (lib/closed-store-data.ts).
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
    // Said on every run: a parked store's record is kept until a weekly try succeeds; a store left is walked again.
    if (report.parked) console.error(`closed-data: ${report.parked} closed stores failed their first step ${PREPARE_TRIES} times or more; each is tried again once a week, and its record is kept until a try succeeds`);
    if (report.left) console.error(`closed-data: ${report.left} closed stores were not finished by the last walk (a key passed over, or a record not yet gone); they are walked again with the next walk, ${report.stuck} of them no longer by themselves`);
    if (report.stopped) console.error(`closed-data: ${report.stopped} closed stores failed their first step at every try; they are no longer tried by themselves, and their records are kept`);
    if (report.unread) console.error(`closed-data: ${report.unread} of the company's lists could not be read by the walk and were passed over (what they owe kept in nl:closed:prune, pruned when they read again)`);
    return Response.json({ ok: true, ...report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("deleting closed stores' records failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await redisPipeline([["DEL", "nl:closed:lock"]]).catch(() => {});
  }
}
