import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isDemoCheckoutConfigured } from "@/lib/demo-store";
import { type Check, verifyCartShipping, verifyPackages, verifyTaxDocuments, verifyTiers } from "@/lib/verify-stripe";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { SITE_URL } from "@/lib/site-url";

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
  const [got] = await redisPipeline([["SET", "nl:stripe-check:lock", "1", "NX", "EX", 120]]);
  if (got === null) return Response.json({ ok: true, busy: true });
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
    const [previous] = await redisPipeline([["GET", LAST]]);
    const failedBefore = typeof previous === "string" && previous.includes('"ok":false');
    await redisPipeline([["SET", LAST, JSON.stringify({ at: Date.now(), ok, checks }), "EX", 30 * 86_400]]);
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
    return Response.json({ ok, checks }, { headers: { "Cache-Control": "no-store" } });
  } finally {
    await redisPipeline([["DEL", "nl:stripe-check:lock"]]).catch(() => {});
  }
}
