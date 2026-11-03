import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isSenderConfigured } from "@/lib/email";
import { sendPaydayEmails } from "@/lib/affiliate-payday";
import { settleAllPayPal } from "@/lib/paypal-payouts";
import { idleSweep } from "@/lib/affiliates";
import { readIdleDays } from "@/lib/affiliate-idle-rules";
import { storesAfter } from "@/lib/store";

/** Long enough to walk every store, short enough to end before the platform does. */
const RUN_MS = 50_000;

/**
 * Run on a schedule by Vercel: first writes into each book what PayPal says
 * it paid from creators' own PayPal (lib/paypal-payouts.ts); then, on the
 * day a creator told their affiliates they pay, sends the batch that is due
 * — or, for a creator who asked, pays it from their PayPal by itself.
 *
 * Last, for a creator who asked for it, warns and later removes affiliates
 * who brought no sale and no lead for the days they chose (630 [HN6](3),
 * lib/affiliates.ts idleSweep), with what is left of the run.
 *
 * Safe to run more than once: each store's month is claimed before its email
 * goes out, a warning is written down on the affiliate once it is sent, and
 * one run at a time.
 */
export async function GET(request: NextRequest) {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured() || !isSenderConfigured()) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  const [got] = await redisPipeline([["SET", "nl:aff:payday:lock", "1", "NX", "EX", 300]]);
  if (got === null) return Response.json({ ok: true, busy: true });
  try {
    const started = Date.now();
    const settled = await settleAllPayPal(started + RUN_MS / 3);
    const counts = await sendPaydayEmails(started + RUN_MS);
    // Only with what the payday left: a payment day is never cut short for this, which can wait for tomorrow.
    const idle = counts.complete ? await idleAll(started + RUN_MS) : { warned: 0, removed: 0, complete: false };
    return Response.json({ ok: true, settled, ...counts, idle }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("sending affiliate payday emails failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await redisPipeline([["DEL", "nl:aff:payday:lock"]]).catch(() => {});
  }
}

/** Every store that asked for idle affiliates to be removed, until the deadline; the rest wait for tomorrow. */
async function idleAll(deadline: number): Promise<{ warned: number; removed: number; complete: boolean }> {
  const out = { warned: 0, removed: 0, complete: false };
  let cursor = "0";
  for (let step = 0; step < 10_000; step += 1) {
    if (Date.now() >= deadline) return out;
    const { stores, next } = await storesAfter(cursor);
    for (const store of stores) {
      if (readIdleDays(store.affiliates.idle) === 0) continue;
      if (Date.now() >= deadline) return out;
      try {
        const done = await idleSweep(store);
        out.warned += done.warned;
        out.removed += done.removed;
      } catch (error) {
        console.error("sweeping idle affiliates failed", error);
      }
    }
    cursor = next;
    if (cursor === "0") break;
  }
  out.complete = true;
  return out;
}
