import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { runRightsQueue } from "@/lib/rights-queue";

export const maxDuration = 60;
const TIME_BUDGET_MS = 45_000;

/**
 * Run every hour by Vercel: the deletions people asked for that a month's
 * rights budget could not pay for at once (lib/rights-budget.ts), each done
 * within the month the law gives (lib/rights-queue.ts). Most runs find none
 * due and read one key. One run at a time, on an exact claim
 * (lib/claim-mark.ts): held by another run is busy; an unknown answer runs
 * nothing this time.
 */
export async function GET(request: NextRequest) {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  const lock = claimValue();
  const got = await claimMark("nl:rights:lock", 120, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  try {
    const run = await runRightsQueue(Date.now(), Date.now() + TIME_BUDGET_MS);
    if (run.done || run.waiting || run.unknown) console.log(`rights: ${run.done} deletions done, ${run.waiting} waiting, ${run.unknown} not read`);
    return Response.json({ ok: true, ...run }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("doing scheduled deletions failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await releaseMark("nl:rights:lock", lock).catch(() => {});
  }
}
