import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured } from "@/lib/redis";
import { settleHeld } from "@/lib/takedown";

export const maxDuration = 120;

/**
 * Run every day by Vercel: links held after a copyright notice (lib/takedown-hold.ts) go back once their
 * counter-notice is 12 full weekdays old, and are deleted when their window ends without one, or after the sender
 * said they went to court (lib/takedown.ts, settleHeld). One run at a time; what cannot be read is left as it is and
 * looked at again. Nobody else can start it: only Vercel's scheduled call carries the secret.
 */
export async function GET(request: NextRequest) {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  try {
    const counts = await settleHeld(Date.now());
    console.log(`takedowns: ${JSON.stringify(counts)}`);
    return Response.json({ ok: counts.failed === 0, counts }, { status: counts.failed === 0 ? 200 : 500, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("settling held links failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
