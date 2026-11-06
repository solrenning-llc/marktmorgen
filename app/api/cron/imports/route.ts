import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { withCutoff } from "@/lib/fetch-timeout";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { advanceImports, sendMoveReminders } from "@/lib/imports";
import { readMetaDue } from "@/lib/meta-ads";
import { sendWelcomeReminders } from "@/lib/welcome-offer-send";
import { storeForId } from "@/lib/store";
import { noticeCreator } from "@/lib/account-notice";

export const maxDuration = 60;

/**
 * Run every five minutes by Vercel, two minutes after the email job so the
 * two do not start together (vercel.json lists the minutes, 2, 7, … 57,
 * rather than a stepped range, the plainest form a scheduler reads): works through the imports a creator started
 * and then left (lib/imports.ts), a chunk at a time, for fifty of its sixty
 * seconds. The studio's page does the same while it is open, and each
 * import's own lock keeps the two from working on one import at once.
 * Then, for five seconds at most, what the stores' Meta ad accounts spent,
 * read once a day each (lib/meta-ads.ts). What time is left goes to the one
 * reminder each moved member is owed (lib/move-members.ts).
 */
export async function GET(request: NextRequest) {
  // Every request to Redis, Stripe and the rest is given up by 57 s
  // (lib/fetch-timeout.ts), inside the sixty Vercel gives the job.
  return withCutoff(Date.now() + 57_000, () => run(request));
}

async function run(request: NextRequest): Promise<Response> {
  // Vercel sends the secret with every scheduled run, compared here in
  // constant time. Without one set, only a local development server runs the
  // job on request; in production that is a closed door, not an open one.
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  // One run at a time, on an exact claim (lib/claim-mark.ts, CX-123 rule 24): held by another run is busy; an
  // unknown answer runs nothing this time, and the lock is let go at the end only while it still holds this run's
  // own value, so a run never deletes another run's lock.
  const lock = claimValue();
  const got = await claimMark("nl:imports:lock", 90, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  const started = Date.now();
  try {
    const counts = await advanceImports(started + 40_000);
    // What the stores' Meta ad accounts spent, each read once a day, for five seconds at most (lib/meta-ads.ts).
    const metaAds = await readMetaDue(Math.min(started + 45_000, Date.now() + 5_000), storeForId, (owner) => noticeCreator(owner, { kind: "metaads-broken" }).then(() => {})).catch((error: unknown) => {
      console.error("reading Meta ad spend failed", error);
      return null;
    });
    // The welcome offers' one reminder each, as they come due (lib/welcome-offer-send.ts).
    const welcome = await sendWelcomeReminders(Math.min(started + 47_000, Date.now() + 4_000)).catch((error: unknown) => {
      console.error("sending welcome offer reminders failed", error);
      return null;
    });
    // Then the one reminder to members moved from another platform who have not kept theirs yet.
    const reminded = await sendMoveReminders(started + 50_000);
    return Response.json({ ok: true, ...counts, metaAds, welcome, reminded }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("the import job failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await releaseMark("nl:imports:lock", lock);
  }
}
