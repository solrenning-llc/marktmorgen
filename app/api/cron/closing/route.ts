import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { withCutoff } from "@/lib/fetch-timeout";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { closeEnded } from "@/lib/plan-closing";
import { releaseRestarted } from "@/lib/closing-holds";
import { tellStaysOpen } from "@/lib/closing-buyers";
import { retryPlanUndos } from "@/lib/closing-plan-guard";
import { finishPlanRefunds } from "@/lib/plan-refund-flow";
import { retryStoreForgets } from "@/lib/store-forget-retry";

export const maxDuration = 60;

/**
 * Run once a day by Vercel, after the job that brings every store's plan in
 * line with Stripe (app/api/cron/plans): looks at each store whose plan has
 * ended, and at what it still keeps (lib/plan-closing.ts).
 *
 * Every store whose plan ended since 18 October 2026, and one whose plan
 * ended before that keeps more than a store with no plan may, is written to
 * when its plan ends, two weeks before the day and a week before it; on the
 * day, and never sooner than a week after the last of those, what it keeps
 * is removed, once Stripe itself has said that day that the store has no
 * plan, and a store that closes is put in line for the deletion of its
 * records (app/api/cron/closed-data).
 *
 * A job of its own, with the whole minute to itself, because removing what
 * a large store keeps is many requests, and whatever is not finished is
 * finished the next day. One run at a time.
 */
export async function GET(request: NextRequest) {
  return withCutoff(Date.now() + 57_000, () => run(request));
}

async function run(request: NextRequest): Promise<Response> {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  // One run at a time, on an exact claim (lib/claim-mark.ts, CX-123 rule 24): held by another run is busy; an
  // unknown answer runs nothing this time, and the lock is let go at the end only while it still holds this run's
  // own value, so a run never deletes another run's lock.
  const lock = claimValue();
  const got = await claimMark("nl:closing:lock", 120, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  try {
    // Stores whose plan was started again before their closing: their members
    // go on being charged as they were, and their buyers are told it stays
    // (lib/closing-holds.ts, queue item 307 [EC1]). First, and briefly.
    const start = Date.now();
    const released = await releaseRestarted(start + 12_000, tellStaysOpen);
    for (const row of released) if (row.state === "held") console.error("plan-closing: a restarted store's members or buyers are not all reached yet; tried again tomorrow");
    // Plans paid for stores already closing, not ended or returned in full
    // yet (lib/closing-plan-guard.ts): tried again on every run, never dropped.
    const undone = await retryPlanUndos(start + 20_000).catch((error) => {
      console.error("returning plans paid for closing stores failed", error);
      return null;
    });
    if (undone?.left) console.error(`plan-closing: ${undone.left} plans paid for closing stores are not all returned yet; tried again on the next run`);
    // Plan refunds a request did not finish (lib/plan-refund-flow.ts, 305 [SY1]): a refund found ends its plan, one
    // never made takes back the stop set for it. Before the closing below, so a store ended here is looked at today.
    const refunds = await finishPlanRefunds(start + 26_000).catch((error) => {
      console.error("finishing plan refunds failed", error);
      return null;
    });
    if (refunds?.left) console.error(`plan-refund: ${refunds.left} plan refunds are not finished yet; tried again on the next run`);
    // Deleted stores whose webhooks, API keys or assistant notes could not be forgotten at the delete (lib/store-forget-retry.ts):
    // tried again, at most FORGET_TRIES times in all; what is given up is counted for the owner's report.
    const forgets = await retryStoreForgets(start + 32_000).catch((error) => {
      console.error("trying again to forget deleted stores' webhooks, keys and assistant notes failed", error);
      return null;
    });
    if (forgets && (forgets.failed || forgets.gaveUp || forgets.left)) console.error(`store-forget: ${forgets.done} done, ${forgets.failed} failed again, ${forgets.gaveUp} given up, ${forgets.left} left for the next run`);
    const looked = await closeEnded(start + 52_000);
    const count = (state: string) => looked.filter((row) => row.state === state).length;
    const counts = { looked: looked.length, told: count("told"), waiting: count("waiting"), removed: count("removed"), held: count("held"), running: count("running") };
    if (counts.told || counts.removed || counts.held) {
      console.log(`plan-closing: ${counts.looked} stores with an ended plan; ${counts.told} written to, ${counts.removed} had what they kept removed, ${counts.held} left for tomorrow`);
      for (const row of looked) if (row.state === "held") console.error(`plan-closing: left for tomorrow: ${row.note ?? "no reason given"}`);
    }
    return Response.json({ ok: true, ...counts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("the job for stores whose plan ended failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  } finally {
    await releaseMark("nl:closing:lock", lock);
  }
}
