import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { repliesFor } from "@/lib/redis-reply";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isDemoCheckoutConfigured } from "@/lib/demo-store";
import { type Check, verifyCartShipping, verifyPackages, verifyTaxDocuments, verifyTiers } from "@/lib/verify-stripe";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { SITE_URL } from "@/lib/site-url";
import { STATUS_CHECKS, statusRunCommands } from "@/lib/status-page";

// A run takes about half a minute, most of it Stripe charging and updating
// test subscriptions; room is left so a slow day at Stripe is not cut off.
export const maxDuration = 180;

const LAST = "nl:stripe-check:last";

/**
 * Run every day by Vercel: session packages, membership tiers, the tax
 * documents a checkout carries and a cart that ships, against Stripe's test mode
 * (lib/verify-stripe.ts). The last answer is kept; the site's own inbox hears
 * when a check fails, and again when all pass after a failure. Nobody else
 * can start it: only Vercel's scheduled call carries the secret.
 */
export async function GET(request: NextRequest) {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured() || !isDemoCheckoutConfigured()) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  // One run at a time, on an exact claim (lib/claim-mark.ts, CX-123 rule 24): held by another run is busy; an
  // unknown answer runs nothing this time, and the lock is let go at the end only while it still holds this run's
  // own value, so a run never deletes another run's lock. It is held longer than maxDuration (180 s) with room, so it
  // cannot run out while this run still works and let a second run start beside it.
  const lock = claimValue();
  const got = await claimMark("nl:stripe-check:lock", 210, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  try {
    let checks: Check[];
    try {
      checks = [...(await verifyTiers()), ...(await verifyPackages(SITE_URL)), ...(await verifyTaxDocuments(SITE_URL)), ...(await verifyCartShipping(SITE_URL))];
    } catch (error) {
      checks = [{ check: "the run itself", ok: false, detail: error instanceof Error ? error.message : "failed" }];
    }
    const ok = checks.length > 0 && checks.every((c) => c.ok);
    // In Vercel's logs for every run, passing or not.
    console.log(`stripe-check ${ok ? "pass" : "FAIL"}: ${checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.check} (${c.detail})`).join(" | ")}`);
    const read = repliesFor(await redisPipeline([["GET", LAST]]), 1);
    const previous = read?.[0];
    const failedBefore = typeof previous === "string" && previous.includes('"ok":false');
    // An unknown reply is not an earlier pass either: no "passing again" is
    // claimed, but a recovery it may hide is said in the log, not dropped.
    if (ok && (!read || (previous !== null && typeof previous !== "string"))) {
      console.error('stripe-check passes, but the previous result could not be read: no "passing again" notice was sent');
    }
    const at = Date.now();
    await redisPipeline([["SET", LAST, JSON.stringify({ at, ok, checks }), "EX", 30 * 86_400]]);
    if ((!ok || failedBefore) && isSenderConfigured()) {
      await sendEmail({ meter: { by: "company" },
        from: NIMBUS_FROM,
        to: SUPPORT_EMAIL,
        subject: ok ? "Stripe check: all passing again" : "Stripe check failed: packages, membership tiers, tax documents or cart shipping",
        text: [
          ok
            ? "Every check of session packages, membership tiers, tax documents and cart shipping against Stripe's test mode passes again."
            : "A check of session packages, membership tiers, tax documents or cart shipping against Stripe's test mode failed. Real checkouts may be affected.",
          "",
          ...checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.check}\n      ${c.detail}`),
        ].join("\n"),
      }).catch((error) => console.error("sending the Stripe check result failed", error));
    }
    // Kept for the public status page (lib/status-page.ts), after the save and the notice and apart from them, so
    // its failure stops neither: its time and result only. Every check here is an answer from Stripe's test mode.
    await redisPipeline(statusRunCommands(STATUS_CHECKS[1].key, at, ok)).catch((error) => console.error("keeping the Stripe check's run for the status page failed", error));
    return Response.json({ ok, checks }, { headers: { "Cache-Control": "no-store" } });
  } finally {
    await releaseMark("nl:stripe-check:lock", lock);
  }
}
