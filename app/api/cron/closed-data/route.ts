import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { withCutoff } from "@/lib/fetch-timeout";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { eraseClosed } from "@/lib/closed-store-data";
import { finishClosed } from "@/lib/plan-closing";

export const maxDuration = 60;

/**
 * Run every hour by Vercel: deletes the records of the stores that closed
 * (lib/closed-store-data.ts). Most runs find no store due and read two keys;
 * one a day at the most starts a walk of the database for every store that
 * came due since the last, and the runs after it carry it on to the end and
 * email each store's owner when theirs is done. One run at a time.
 */
export async function GET(request: NextRequest) {
  return withCutoff(Date.now() + 57_000, () => run(request));
}

async function run(request: NextRequest): Promise<Response> {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  // One run at a time, on an exact claim (lib/claim-mark.ts, CX-123 rule 24): held by another run is busy; an
  // unknown answer runs nothing this time, and the lock is let go at the end only while it still holds this run's
  // own value, so a run never deletes another run's lock.
  const lock = claimValue();
  const got = await claimMark("nl:closed:lock", 120, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  try {
    const report = await eraseClosed(Date.now() + 45_000, finishClosed);
    if (report.stores || report.finished || !report.done) console.log(`closed-data: ${report.stores} stores begun, ${report.pages} pages read, ${report.deleted} keys deleted, ${report.pruned} list members taken out, ${report.finished} stores done`);
    return Response.json({ ok: true, ...report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("deleting closed stores' records failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await releaseMark("nl:closed:lock", lock);
  }
}
