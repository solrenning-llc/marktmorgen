import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { isSenderConfigured } from "@/lib/email";
import { storeForHandleExactly } from "@/lib/store-exact";
import { readCourseExact } from "@/lib/course";
import { sendDripEmails } from "@/lib/learn";
import { SITE_URL } from "@/lib/site-url";
import { sweepTaskUploads } from "@/lib/assignment";
import { deleteFile } from "@/lib/file-store";
import { sweepCommunityUploads } from "@/lib/community-files";
import { UnknownReplyError } from "@/lib/redis-reply";
import { withCutoff } from "@/lib/fetch-timeout";

export const maxDuration = 60;

/**
 * The store behind a drip course's address for sendDripEmails: null only when it is confirmed not there; a reply out of
 * shape throws, so the course is kept and tried again the next run, never taken out as gone (CX-123 rule 24).
 */
async function dripStore(handle: string) {
  const found = await storeForHandleExactly(handle);
  if (found === "unknown") throw new UnknownReplyError("a drip course's store");
  return found === "none" ? null : found;
}

/**
 * Run on a schedule by Vercel: tells each student when a module of their
 * course opens for them. Once per student and module, one run at a time.
 * And deletes files students uploaded for an assignment and never handed
 * in (lib/assignment.ts), and community pictures never put in a post
 * (lib/community-files.ts), a day on.
 *
 * Sixty seconds (maxDuration), every request given up by 57 s (withCutoff): the drip emails start nothing new after
 * 40 s and the next run starts where they stopped (lib/learn.ts), so the two sweeps always have their turn.
 */
export async function GET(request: NextRequest) {
  const started = Date.now();
  return withCutoff(started + 57_000, () => run(request, started));
}

async function run(request: NextRequest, started: number) {
  // Vercel sends the secret with every scheduled run, compared here in
  // constant time. Without one set, only a local development server runs the
  // job on request; in production that is a closed door, not an open one.
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured() || !isSenderConfigured()) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  // One run at a time, on an exact claim (lib/claim-mark.ts): held by another run is busy; an unknown answer
  // runs nothing this time, and the lock is let go at the end only while it still holds this run's own value.
  const lock = claimValue();
  const got = await claimMark("nl:courses:lock", 300, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  try {
    // Not walked (the drip set could not be read exactly): said in the log and the answer, never "0 sent"; the sweeps still run.
    const counts = await sendDripEmails(dripStore, readCourseExact, SITE_URL, Math.floor(started / 1000), started + 40_000).catch((error: unknown) => {
      console.error("could not send the drip emails", error);
      return null;
    });
    const stale = await sweepTaskUploads(deleteFile).catch((error: unknown) => {
      console.error("could not sweep unused assignment uploads", error);
      return [] as string[];
    });
    // Not swept (the list could not be read exactly): said in the log and the answer, never "0 swept"; the next run sweeps.
    const pictures = await sweepCommunityUploads().catch((error: unknown) => {
      console.error("could not sweep unused community pictures", error);
      return null;
    });
    return Response.json(
      { ok: true, ...(counts ?? { sent: null, dripsFailed: true }), unusedUploads: stale.length, unusedPictures: pictures, ...(pictures === null ? { picturesFailed: true } : {}) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("sending course emails failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await releaseMark("nl:courses:lock", lock);
  }
}
