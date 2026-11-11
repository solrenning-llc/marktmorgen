import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { isRedisConfigured } from "@/lib/redis";
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
  // Ours only on OK or our own value read back (CX-123 rule 24, L9); not known: nothing settled, and said so.
  const lock = claimValue();
  const got = await claimMark("nl:share:lock", 330, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got === "unknown") return Response.json({ ok: false, error: "lock unknown" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    const counts = await settleShares(Date.now() + 270_000);
    console.log(`shares: ${JSON.stringify(counts)}`);
    return Response.json({ ok: counts.failed === 0, counts }, { headers: { "Cache-Control": "no-store" } });
  } finally {
    await releaseMark("nl:share:lock", lock);
  }
}
