/**
 * 273 [BK1] (inbox C1-20261108-1353-C4-33, C1-20261108-1530-C4-34, C1-20261108-2017-C4-36): the backup's Vercel route,
 * its schedule and the external dead-man alarm. Synthetic only: no real monitor, bucket or request. The backup stays
 * off: BACKUP_COST_REVIEW is null, and the route then sends nothing at all.
 *
 * What fails here:
 *   - BACKUP_RUN_CUTOFF_MS above 700 s, a route without maxDuration of 800 s, a route that runs without CRON_SECRET in
 *     production, a route that sends a single database command or request while BACKUP_COST_REVIEW is null;
 *   - vercel.json without the backup route twice a day, hours apart;
 *   - the alarm's sign of life sent after anything but a clean success, or no failure signal on prune_*, room_* and
 *     last_good_copy_lost; an alarm address that is not https or carries credentials taken as on; a monitor's failure
 *     thrown; an alarm address with a query taken as on (Claude 5, 9 November 2026), or with a fragment, even an empty
 *     one (Claude 6's N3);
 *   - the cost model pricing a route duration other than the route's maxDuration, or still saying no route runs.
 */
import { readFileSync } from "node:fs";
import { BACKUP_COST_REVIEW, BACKUP_LOCK_MS, BACKUP_RUN_CUTOFF_MS, type BackupRunResult } from "@/lib/backup-run";
import * as backupCost from "@/lib/backup-cost";
import { BACKUP_ALARM_CRITICAL_HOURS, BACKUP_ALARM_WARN_HOURS, backupAlarmConfig, backupAlarmSignal, sendBackupAlarm } from "@/lib/backup-alarm";
import { REDIS_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { GET as backupRoute, maxDuration } from "@/app/api/cron/backup/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  let sent = 0;
  const real = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
    sent += list.length;
    return real(list);
  }) as typeof redis.pipeline;

  part("The run's cutoff and its route on Vercel (C4-36 item 4)");
  is("the cutoff: 700 s", BACKUP_RUN_CUTOFF_MS, 700_000);
  is("the lock still outlives the cutoff and the admission's two requests", BACKUP_LOCK_MS >= BACKUP_RUN_CUTOFF_MS + 2 * REDIS_TIMEOUT_MS + 60_000, true);
  is("the route's maxDuration: 800 s, explicit", maxDuration, 800);
  is("no reviewed cost ceiling exists: the backup is off", BACKUP_COST_REVIEW, null);
  // Claude 5's LOW (6732278950, 6732268011): the cost model prices the route this PR built, at its own maxDuration.
  is("the cost model's route duration is the route's maxDuration", (backupCost as Record<string, unknown>).BACKUP_ROUTE_SECONDS, maxDuration);
  is("no open unknown still says no route runs the backup", backupCost.BACKUP_COST_UNKNOWNS.filter((u) => u.includes("no route runs the backup yet")), []);
  {
    const env = process.env as Record<string, string | undefined>;
    const was = { secret: env.CRON_SECRET, node: env.NODE_ENV, alarm: env.BACKUP_ALARM_PING_URL };
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => (fetched++, new Response("ok"))) as typeof fetch;
    env.NODE_ENV = "production";
    delete env.CRON_SECRET;
    const before = sent;
    const bare = await backupRoute(new Request("https://marktmorgen.com/api/cron/backup") as never);
    is("production without CRON_SECRET: refused, nothing sent", [bare.status, sent - before, fetched], [401, 0, 0]);
    env.CRON_SECRET = "s".repeat(40);
    const wrong = await backupRoute(new Request("https://marktmorgen.com/api/cron/backup", { headers: { authorization: "Bearer nope" } }) as never);
    is("a wrong secret: refused", wrong.status, 401);
    env.BACKUP_ALARM_PING_URL = "https://monitor.example.test/ping/abc";
    const right = await backupRoute(new Request("https://marktmorgen.com/api/cron/backup", { headers: { authorization: `Bearer ${"s".repeat(40)}` } }) as never);
    is("the right secret, no review: off, zero database commands, zero requests, no alarm", [right.status, await right.json(), sent - before, fetched], [200, { ok: false, reason: "off_review" }, 0, 0]);
    globalThis.fetch = realFetch;
    env.CRON_SECRET = was.secret;
    env.NODE_ENV = was.node;
    if (was.alarm === undefined) delete env.BACKUP_ALARM_PING_URL;
    else env.BACKUP_ALARM_PING_URL = was.alarm;
  }
  {
    const crons = (JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] }).crons.filter((c) => c.path === "/api/cron/backup");
    const m = /^(\d{1,2}) (\d{1,2}),(\d{1,2}) \* \* \*$/.exec(crons[0]?.schedule ?? "");
    is("vercel.json: one backup entry, a daily run and a second try hours later", [crons.length, m !== null, m ? Number(m[3]) - Number(m[2]) >= 4 : false, m ? Number(m[1]) % 30 !== 0 : false], [1, true, true, true]);
  }

  part("The external dead-man alarm (C4-34 item 1, C4-36 item 4): code only, off");
  is("warn at 26 h, critical at 48 h of silence", [BACKUP_ALARM_WARN_HOURS, BACKUP_ALARM_CRITICAL_HOURS], [26, 48]);
  const ok = (prune: string, extra: object = {}) => ({ ok: true, id: "x", keys: 1, bytes: 1, parts: 1, pruned: 0, prune, ...extra }) as BackupRunResult;
  is("a clean success: the sign of life", backupAlarmSignal(ok("done")), { kind: "alive" });
  for (const state of ["prune_error", "prune_pages", "prune_cutoff", "prune_locked", "prune_shrunk", "prune_unverified"]) {
    is(`a copy with ${state}: a failure signal, never alive`, backupAlarmSignal(ok(state)), { kind: "fail", reason: state });
  }
  is("a copy that found the last good copy lost: a failure signal", backupAlarmSignal(ok("done", { note: "last_good_copy_lost" })), { kind: "fail", reason: "last_good_copy_lost" });
  for (const reason of ["room_error", "room_pages", "room_cutoff", "room_unverified", "room_locked", "room_shrunk", "verify", "export_error", "mark_error"]) {
    is(`a failed run (${reason}): a failure signal`, backupAlarmSignal({ ok: false, reason } as BackupRunResult), { kind: "fail", reason });
  }
  for (const reason of ["off_review", "off_store", "off_key", "already_ran", "busy"]) {
    is(`${reason}: no signal at all`, backupAlarmSignal({ ok: false, reason } as BackupRunResult), null);
  }
  {
    const env = process.env as Record<string, string | undefined>;
    delete env.BACKUP_ALARM_PING_URL;
    is("no monitor address: off", backupAlarmConfig(), null);
    env.BACKUP_ALARM_PING_URL = "http://monitor.example.test/ping/abc";
    is("not https: off", backupAlarmConfig(), null);
    env.BACKUP_ALARM_PING_URL = "https://user:pw@monitor.example.test/ping/abc";
    is("with credentials in the address: off", backupAlarmConfig(), null);
    // Claude 5's MEDIUM (6732278950): "/fail" added to an address with a query lands in the query, and a monitor that
    // reads the path takes the failure as a sign of life. Such an address is no address (rule 24: unknown fails closed).
    env.BACKUP_ALARM_PING_URL = "https://hc-ping.example.test/abc-uuid?rid=1";
    is("an address with a query: off, never a failure sent to the sign of life's path", backupAlarmConfig(), null);
    env.BACKUP_ALARM_PING_URL = "https://hc-ping.example.test/abc-uuid?";
    is("an address with an empty query: off", backupAlarmConfig(), null);
    // Claude 6's N3 (9 November 2026): a trailing "#" is an empty fragment (url.hash is ""), and "/fail" added to it
    // lands in the fragment, never sent: the failure would reach the sign of life's path.
    env.BACKUP_ALARM_PING_URL = "https://hc-ping.example.test/abc-uuid#";
    is("an address with an empty fragment: off", backupAlarmConfig(), null);
    env.BACKUP_ALARM_PING_URL = "https://hc-ping.example.test/abc-uuid#x";
    is("an address with a fragment: off", backupAlarmConfig(), null);
    env.BACKUP_ALARM_PING_URL = "https://monitor.example.test/ping/abc";
    const config = backupAlarmConfig();
    is("an https address: on", config !== null, true);
    const calls: { url: string; body: string }[] = [];
    const fake = (async (url: string, init?: RequestInit) => (calls.push({ url: String(url), body: String(init?.body ?? "") }), new Response("OK"))) as unknown as typeof fetch;
    is("alive: sent to the address", [await sendBackupAlarm({ kind: "alive" }, config!, fake), calls[0]?.url], ["sent", "https://monitor.example.test/ping/abc"]);
    is("fail: sent to /fail with the reason only", [await sendBackupAlarm({ kind: "fail", reason: "prune_shrunk" }, config!, fake), calls[1]], ["sent", { url: "https://monitor.example.test/ping/abc/fail", body: "prune_shrunk" }]);
    const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    is("a monitor that answers 500: failed, never thrown", await sendBackupAlarm({ kind: "alive" }, config!, down), "failed");
    const dead = (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    is("a monitor unreachable: failed, never thrown", await sendBackupAlarm({ kind: "alive" }, config!, dead), "failed");
    delete env.BACKUP_ALARM_PING_URL;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
