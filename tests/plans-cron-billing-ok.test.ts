/**
 * The daily plans cron (app/api/cron/plans/route.ts) answers "ok" only when the
 * subscription sync (lib/billing-sync.ts) settled every subscription it read: a
 * run where a store's paid-up state could not be applied or checked is a failed
 * run, not a healthy one, so the failure shows instead of hiding in the log.
 * Every job is a stand-in (tests/plans-cron-billing-ok-world.ts); the lock is the
 * in-memory Redis.
 */
import { GET } from "@/app/api/cron/plans/route";
import { world, type Billing } from "./plans-cron-billing-ok-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const counts = (failed: number, complete = true): Billing => ({ seen: 3, updated: 1, adopted: 0, checked: 2, failed, complete });
const request = () => new Request("https://marktmorgen.com/api/cron/plans") as unknown as Parameters<typeof GET>[0];

async function run() {
  redis.clear();
  const response = await GET(request());
  const body = (await response.json()) as { ok: boolean; billing: Billing | null };
  return { status: response.status, ok: body.ok, billing: body.billing };
}

async function main() {
  part("Healthy control: every subscription settled");
  world.billing = counts(0); world.billingThrows = false;
  is("ok, 200", await run().then((r) => [r.ok, r.status]), [true, 200]);

  part("Healthy control: the deadline stopped the walk, nothing failed (it carries on tomorrow)");
  world.billing = counts(0, false);
  is("ok, 200", await run().then((r) => [r.ok, r.status]), [true, 200]);

  part("A subscription whose state could not be applied or checked fails the run");
  world.billing = counts(1);
  const failed = await run();
  is("not ok, 500, with the counts in the answer", [failed.ok, failed.status, failed.billing?.failed], [false, 500, 1]);
  world.billing = counts(4, false);
  is("several failures, incomplete: not ok, 500", await run().then((r) => [r.ok, r.status]), [false, 500]);

  part("Control: a sync that threw is still not ok");
  world.billing = null; world.billingThrows = true;
  is("not ok, 500", await run().then((r) => [r.ok, r.status]), [false, 500]);
  done();
}
main();
