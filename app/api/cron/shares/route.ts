import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { platformKey } from "@/lib/stripe-account";
import { COMMISSION_LIVE } from "@/lib/plan";
import { settleShares } from "@/lib/share-settle";

export const maxDuration = 300;

/**
 * Run every day by Vercel: keeps every share of a sale taken to what is owed
 * (lib/share-settle.ts). Nothing to do while the share is off. Nobody else
 * can start it: only Vercel's scheduled call carries the secret.
 */
export async function GET(request: NextRequest) {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!COMMISSION_LIVE) return Response.json({ ok: true, off: true }, { headers: { "Cache-Control": "no-store" } });
  if (!isRedisConfigured() || !platformKey()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  // One run at a time, on an exact claim (lib/claim-mark.ts, CX-123 rule 24): held by another run is busy; an
  // unknown answer runs nothing this time, and the lock is let go at the end only while it still holds this run's
  // own value, so a run never deletes another run's lock.
  const lock = claimValue();
  const got = await claimMark("nl:share:lock", 330, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  try {
    const counts = await settleShares(Date.now() + 270_000);
    console.log(`shares: ${JSON.stringify(counts)}`);
    return Response.json({ ok: counts.failed === 0, counts }, { headers: { "Cache-Control": "no-store" } });
  } finally {
    await releaseMark("nl:share:lock", lock);
  }
}
