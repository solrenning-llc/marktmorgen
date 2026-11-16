import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { isDiscordConfigured } from "@/lib/discord";
import { sweepDiscord } from "@/lib/discord-access";

/** How long one run may go on checking; the rest wait for the next. */
const BUDGET_MS = 45_000;

/**
 * Run on a schedule by Vercel: checks again everyone a store's Discord
 * server gave roles to, each at most every few hours (lib/discord-access.ts),
 * and takes back what is no longer theirs. One run at a time.
 */
export async function GET(request: NextRequest) {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured() || !isDiscordConfigured()) return Response.json({ ok: true, off: true });
  // One run at a time, on an exact claim (lib/claim-mark.ts): held by another run is busy; an unknown answer
  // runs nothing this time, and the lock is let go at the end only while it still holds this run's own value.
  const lock = claimValue();
  const got = await claimMark("nl:dc:lock", 120, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  try {
    const counts = await sweepDiscord(Date.now() + BUDGET_MS);
    return Response.json({ ok: true, ...counts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("checking Discord members failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await releaseMark("nl:dc:lock", lock);
  }
}
