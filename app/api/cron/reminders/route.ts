import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { isBillingConfigured } from "@/lib/billing";
import { sendFailedPlanNotices, sendReminders } from "@/lib/billing-reminders";
import { runBreaks } from "@/lib/plan-pause";
import { PLAN_BREAKS_ENABLED } from "@/lib/plan-pause-rules";
import { sendTrialNudges } from "@/lib/trial-nudges";
import { sendDueReminders } from "@/lib/payment-requests";

/** Four passes over our subscriptions, one after another. */
export const maxDuration = 60;

/**
 * Run on a schedule by Vercel: warns every creator before a trial turns into
 * a charge, and before a yearly plan renews, and tells one whose payment
 * failed where to pay it. And ends the breaks creators chose: told a week
 * before, and the plan started again on the day (lib/plan-pause.ts). And
 * writes twice during a trial to a store that has not sold yet, with the one
 * step that would help it most (lib/trial-nudges.ts). And reminds the
 * people a creator sent a payment request, on the days the creator chose
 * (lib/payment-requests.ts).
 *
 * Safe to run more than once: each charge is warned of once, only to the person
 * paying it, and one run at a time.
 */
export async function GET(request: NextRequest) {
  // Vercel sends the secret with every scheduled run, compared here in
  // constant time. Without one set, only a local development server runs the
  // job on request; in production that is a closed door, not an open one.
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured() || !isBillingConfigured()) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  // One run at a time, on an exact claim (lib/claim-mark.ts): held by another run is busy; an unknown answer
  // runs nothing this time, and the lock is let go at the end only while it still holds this run's own value.
  const lock = claimValue();
  const got = await claimMark("nl:remind:lock", 300, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  try {
    const counts = await sendReminders();
    const failed = await sendFailedPlanNotices();
    const breaks = PLAN_BREAKS_ENABLED ? await runBreaks() : { told: 0, restarted: 0, failed: 0, dropped: 0 };
    const nudges = await sendTrialNudges();
    // Creators' payment requests still unpaid, reminded on the day they asked for (lib/payment-requests.ts), within what is left of the run.
    const requests = await sendDueReminders(Date.now() + 20_000).catch((error) => {
      console.error("sending payment request reminders failed", error);
      return { sent: 0, skipped: 0 };
    });
    return Response.json({ ok: true, ...counts, failedPayments: failed, breaks, nudges, requests }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("sending billing reminders failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await releaseMark("nl:remind:lock", lock);
  }
}
