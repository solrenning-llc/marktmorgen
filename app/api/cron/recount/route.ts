import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { withCutoff } from "@/lib/fetch-timeout";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { recountStep } from "@/lib/data-recount";
import { notePodcastProducts } from "@/lib/podcast-access";

export const maxDuration = 60;

/**
 * Run every hour by Vercel until it is done: the one-time count of what
 * every store already kept in the database before its data room counted it
 * (lib/data-recount.ts). Each run reads as much as its minute allows and
 * writes down where it stopped; once every store is counted each run is one
 * read and nothing more, until the count's version changes. One run at a
 * time.
 *
 * The same runs, after the count, walk the private podcast feeds granted
 * before their products were noted (lib/podcast-access.ts,
 * notePodcastProducts; #4471), until that walk is done too; then it is one
 * read a run. Until it is done a person's deletion says it is not finished.
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
  const got = await claimMark("nl:recount:lock", 120, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  try {
    const started = Date.now();
    const report = await recountStep(started + 45_000);
    if (!report.done) console.log(`data-recount: ${report.phase}; ${report.stores} stores read, ${report.pages} pages, ${report.measured} keys measured, ${report.applied} rooms set`);
    const podcastNotes = await notePodcastProducts(started + 52_000);
    if (!podcastNotes.done) console.log(`podcast-notes: ${podcastNotes.pages} pages, ${podcastNotes.noted} products noted`);
    return Response.json({ ok: true, ...report, podcastNotes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("the one-time count of what stores keep failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await releaseMark("nl:recount:lock", lock);
  }
}
