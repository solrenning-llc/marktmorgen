import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor, stringList } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { isSenderConfigured } from "@/lib/email";
import { visitedFolders } from "@/lib/traffic";
import { monthKey } from "@/lib/delivery";
import { storeOf } from "@/lib/usage-billing";
import { checkQuiet } from "@/lib/quiet-sales";
import { checkAlerts } from "@/lib/store-alerts";
import { runStoreJob } from "@/lib/store-lock-wait";

/**
 * Once a day for each store with visits this month or last, whether its
 * sales have stopped (lib/quiet-sales.ts), and whether its numbers went off
 * course in another way (lib/store-alerts.ts). Runs every hour and keeps the
 * stores the day's runs have walked, so each store is reached once a day
 * however many there are, a store first visited later in the day is reached
 * that day wherever it sorts (issue #4005), and a run after the last store
 * reads nothing; each store is also marked looked-at for the day before
 * anything is read, so a store reached twice is read once.
 */
export const maxDuration = 60;
const TIME_BUDGET_MS = 45_000;

export async function GET(request: NextRequest) {
  // A scheduled job: every store write inside it waits the job's wait, not a person's (lib/store-lock-wait.ts, #5010 row 182).
  return runStoreJob(() => runJob(request));
}

async function runJob(request: NextRequest) {
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
  const out = { sent: 0, fine: 0, skipped: 0, seen: 0, failed: 0, alerts: 0 };
  try {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const folders = [...new Set([...(await visitedFolders(monthKey(now))), ...(await visitedFolders(monthKey(lastMonth)))])].sort();
    const doneKey = `nl:quiet:done:${now.toISOString().slice(0, 10)}`;
    // The stores today's runs have walked, read exactly (CX-123 rule 24): a list of folders, an empty one at the start;
    // anything else is unknown, and nothing is read on it and nothing is written. Kept by folder, not by a place in
    // the sorted list: a store first visited later in the day sorts anywhere, before the place too (issue #4005).
    const kept = repliesFor(await redisPipeline([["SMEMBERS", doneKey]]), 1);
    const walked = kept ? stringList(kept[0]) : null;
    if (!walked) {
      console.error("quiet: which stores today's walk has reached is unknown; nothing read this run");
      return Response.json({ ok: false, error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const already = new Set(walked);
    const left = folders.filter((folder) => !already.has(folder));
    const reached: string[] = [];
    let at = 0;
    while (at < left.length && Date.now() - started <= TIME_BUDGET_MS) {
      // A store that cannot be read is tried again at once. If it still cannot be, it is counted as failed and said
      // in the log, never passed over as "no store"; the walk goes on to the stores after it, so one store never
      // holds back the rest, and the next day's walk tries it again.
      const folder = left[at];
      at += 1;
      reached.push(folder);
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
    if (reached.length) await redisPipeline([["SADD", doneKey, ...reached], ["EXPIRE", doneKey, 2 * 86400]]);
    console.log(`quiet: ${JSON.stringify(out)}`);
    return Response.json({ ok: true, ...out }, { headers: { "Cache-Control": "no-store" } });
  } finally {
    await releaseMark("nl:quiet:lock", lock);
  }
}
