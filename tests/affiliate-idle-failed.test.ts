/**
 * Issue #4092 (Codex U; rule 24): the affiliates' daily job (app/api/cron/affiliates) sweeps idle affiliates of every
 * store that asked for it (lib/affiliates.ts idleSweep). A store whose sweep threw was only logged, and the run still
 * said `idle.complete: true` and `ok: true` with HTTP 200, so the run's report and any monitor took a store that was
 * not swept for one that was. Now a store that failed is counted (`idle.failed`), the run is not complete, and the
 * job answers `ok: false, error: "failed"` with HTTP 500, as the weekly and monthly jobs do; the other stores are
 * still swept and counted.
 *
 * Synthetic only: the in-memory Redis, two synthetic stores; idleSweep and the payday passes are stand-ins
 * (tests/aliases/affiliate-idle-failed.test.ts.json).
 */
import { NextRequest } from "next/server";
import { GET as runJob } from "@/app/api/cron/affiliates/route";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { claimHandle, ensureStatsId, setAffiliateSetting } from "@/lib/store";
import { swept } from "./affiliate-idle-failed-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_affiliate_idle_failed";
process.env.CRON_SECRET = "cron-secret-idle-failed";

type Answer = { ok?: boolean; error?: string; idle?: { warned: number; removed: number; complete: boolean; failed?: number } };

async function storeWithIdle(owner: string, handle: string): Promise<void> {
  if (!(await claimHandle(owner, handle, handle, "")).ok) throw new Error(`no store ${handle}`);
  await ensureStatsId(owner);
  await setAffiliateSetting(owner, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, idle: 90, idleOn: Date.now() }));
}

async function run(): Promise<{ status: number; json: Answer }> {
  const response = await runJob(new NextRequest("https://marktmorgen.test/api/cron/affiliates", { headers: { authorization: "Bearer cron-secret-idle-failed" } }));
  return { status: response.status, json: (await response.json()) as Answer };
}

async function main(): Promise<void> {
  redis.clear();
  await storeWithIdle("idle-ok@example.com", "idleok");

  part("Control: every store swept");
  const control = await run();
  is("HTTP 200", control.status, 200);
  is("ok", control.json.ok, true);
  is("complete, with the store's counts", control.json.idle, { warned: 2, removed: 1, complete: true, failed: 0 });

  part("One store's sweep throws: the run is not complete, and says so");
  await storeWithIdle("idle-fail@example.com", "idlefail");
  swept.length = 0;
  const failed = await run();
  is("both stores were tried", [...swept].sort(), ["idlefail", "idleok"]);
  is("HTTP 500", failed.status, 500);
  is("not ok, failed", [failed.json.ok, failed.json.error], [false, "failed"]);
  is("one failure counted, not complete; the other store's counts kept", failed.json.idle, { warned: 2, removed: 1, complete: false, failed: 1 });

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
