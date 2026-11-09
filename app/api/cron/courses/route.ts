import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { isSenderConfigured } from "@/lib/email";
import { storeForHandle } from "@/lib/store";
import { readCourse } from "@/lib/course";
import { sendDripEmails } from "@/lib/learn";
import { SITE_URL } from "@/lib/site-url";
import { sweepTaskUploads } from "@/lib/assignment";
import { deleteFile } from "@/lib/file-store";
import { sweepCommunityUploads } from "@/lib/community-files";
import { del } from "@/lib/blob";
import { sweepPictureDoors } from "@/lib/picture-door";

/**
 * Run on a schedule by Vercel: tells each student when a module of their
 * course opens for them. Once per student and module, one run at a time.
 * And deletes files students uploaded for an assignment and never handed
 * in (lib/assignment.ts), and community pictures never put in a post
 * (lib/community-files.ts), a day on, and studio pictures let in through the
 * picture door and never put on anything (lib/picture-door.ts), 30 days on.
 */
export async function GET(request: NextRequest) {
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
    const counts = await sendDripEmails(storeForHandle, readCourse, SITE_URL);
    const stale = await sweepTaskUploads(deleteFile).catch((error: unknown) => {
      console.error("could not sweep unused assignment uploads", error);
      return [] as string[];
    });
    // Not swept (the list could not be read exactly): said in the log and the answer, never "0 swept"; the next run sweeps.
    const pictures = await sweepCommunityUploads().catch((error: unknown) => {
      console.error("could not sweep unused community pictures", error);
      return null;
    });
    const studioPictures = await sweepPictureDoors(del).catch((error: unknown) => {
      console.error("could not sweep unused studio pictures", error);
      return null;
    });
    return Response.json(
      {
        ok: true,
        ...counts,
        unusedUploads: stale.length,
        unusedPictures: pictures,
        ...(pictures === null ? { picturesFailed: true } : {}),
        unusedStudioPictures: studioPictures === null ? null : studioPictures.length,
        ...(studioPictures === null ? { studioPicturesFailed: true } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("sending course emails failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await releaseMark("nl:courses:lock", lock);
  }
}
