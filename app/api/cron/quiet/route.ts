import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { isSenderConfigured } from "@/lib/email";
import { visitedFolders } from "@/lib/traffic";
import { monthKey } from "@/lib/delivery";
import { storeOf } from "@/lib/usage-billing";
import { checkQuiet } from "@/lib/quiet-sales";
import { checkAlerts } from "@/lib/store-alerts";
import { sendDueAlerts } from "@/lib/child-safety-alerts";
import { HIDE_BUDGET_MS, hideHeldProducts } from "@/lib/child-safety";

/**
 * Once a day for each store with visits this month or last, whether its
 * sales have stopped (lib/quiet-sales.ts), and whether its numbers went off
 * course in another way (lib/store-alerts.ts). Runs every hour and goes on from
 * where the day's last run stopped, so each store is reached once a day
 * however many there are, and a run after the last store reads nothing; each
 * store is also marked looked-at for the day before anything is read, so a
 * store reached twice is read once.
 */
export const maxDuration = 60;
const TIME_BUDGET_MS = 45_000;
/** How long the child-safety reminders may take, from the run's start. */
const REMINDERS_BUDGET_MS = 15_000;
/** The latest, from the run's start, the hide step tries another product: the reminders' time and its own budget. */
const HIDES_UNTIL_MS = REMINDERS_BUDGET_MS + HIDE_BUDGET_MS;

export async function GET(request: NextRequest) {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured() || !isSenderConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  // One run at a time, on an exact claim (lib/claim-mark.ts): held by another run is busy; an unknown answer
  // runs nothing this time, and the lock is let go at the end only while it still holds this run's own value.
  const lock = claimValue();
  const got = await claimMark("nl:quiet:lock", 120, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });
  const started = Date.now();
  const out = { sent: 0, fine: 0, skipped: 0, seen: 0, failed: 0, alerts: 0, reminders: 0, hidden: 0 };
  try {
    // The reminders of open child-safety reports first, under this lock: a bounded batch that never throws and leaves
    // what it cannot read for the next hour (lib/child-safety-alerts.ts). First, so nothing before them can spend their
    // time: the hide step below waits on busy store locks, which is what puts a product in its queue (Claude 4 on #3486).
    out.reminders = (await sendDueAlerts(started, started + REMINDERS_BUDGET_MS)).sent;
    // Then held products whose taking off the store did not go through, under this lock, with only the time left: its
    // own HIDE_BUDGET_MS, never past HIDES_UNTIL_MS from the start, a short wait on a busy store, never throws, and
    // leaves what it cannot confirm or reach for the next hour (lib/child-safety.ts, hideHeldProducts).
    out.hidden = (await hideHeldProducts(started, Math.min(Date.now() + HIDE_BUDGET_MS, started + HIDES_UNTIL_MS))).hidden;
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const folders = [...new Set([...(await visitedFolders(monthKey(now))), ...(await visitedFolders(monthKey(lastMonth)))])].sort();
    const atKey = `nl:quiet:at:${now.toISOString().slice(0, 10)}`;
    // Where today's walk goes on from, read exactly (CX-123 rule 24): nil is the start, a whole number the place;
    // anything else is unknown, and nothing is read on it and the place is left as it was. Within one UTC day the
    // list only grows (lib/traffic.ts adds folders and keeps them 400 days), so this pass never wrote a place past
    // its end: that is unknown too.
    const kept = repliesFor(await redisPipeline([["GET", atKey]]), 1);
    const place = kept ? kept[0] : undefined;
    let at = place === null ? 0 : typeof place === "string" && /^(0|[1-9][0-9]{0,8})$/.test(place) ? Number(place) : -1;
    if (at < 0 || at > folders.length) {
      console.error("quiet: where today's walk goes on from is unknown; nothing read this run");
      return Response.json({ ok: false, error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    while (at < folders.length && Date.now() - started <= TIME_BUDGET_MS) {
      // A store that cannot be read is tried again at once. If it still cannot be, it is counted as failed and said
      // in the log, never passed over as "no store"; the walk goes on to the stores after it, so one store never
      // holds back the rest, and the next day's walk tries it again.
      const folder = folders[at];
      at += 1;
      const store = await storeOf(folder).catch(() => storeOf(folder)).catch((error: unknown) => {
        console.error(`quiet: the store of folder ${folder} could not be read twice; counted as failed, tried again on the next day's walk`, error);
        return undefined;
      });
      if (store === undefined) {
        out.failed += 1;
        continue;
      }
      if (!store) continue;
      const result = await checkQuiet(store).catch((error) => {
        console.error("checking a store's sales failed", error);
        return "failed" as const;
      });
      out[result] += 1;
      // And the alerts on its numbers, in the same daily pass (lib/store-alerts.ts).
      const alerted = await checkAlerts(store).catch((error) => {
        console.error("checking a store's alerts failed", error);
        return { said: 0, skipped: true };
      });
      out.alerts += alerted.said;
    }
    await redisPipeline([["SET", atKey, at, "EX", 2 * 86400]]);
    console.log(`quiet: ${JSON.stringify(out)}`);
    return Response.json({ ok: true, ...out }, { headers: { "Cache-Control": "no-store" } });
  } finally {
    await releaseMark("nl:quiet:lock", lock);
  }
}
