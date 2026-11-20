/**
 * The daily plans cron says when one of its passes failed (#4280, Codex U through Claude 1): a pass that threw was
 * logged, its field was null, and the run answered `ok: true` with HTTP 200, so a scheduler reading the status never
 * saw members' failed renewals or invite credit failing on every run. Now every pass but the two the route names as
 * best-effort (the demo store and the research pruning) makes the run a failed one, and the answer names it.
 * Every job is a stand-in (tests/plans-cron-billing-ok-world.ts); the lock is the in-memory Redis. Synthetic only.
 */
import { GET } from "@/app/api/cron/plans/route";
import { world, type Billing } from "./plans-cron-billing-ok-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const settled: Billing = { seen: 3, updated: 1, adopted: 0, checked: 2, failed: 0, complete: true };
const request = () => new Request("https://marktmorgen.com/api/cron/plans") as unknown as Parameters<typeof GET>[0];

async function run(...throwing: string[]) {
  redis.clear();
  world.billing = settled;
  world.billingThrows = false;
  world.throwing = new Set(throwing);
  const response = await GET(request());
  const body = (await response.json()) as { ok: boolean; failedPasses?: string[] };
  return { status: response.status, ok: body.ok, failed: body.failedPasses ?? [] };
}

async function main() {
  part("Control: every pass ran");
  is("ok, 200, nothing named", await run().then((r) => [r.ok, r.status, r.failed]), [true, 200, []]);

  part("#4280: a pass that moves money or credit and threw fails the run, and is named");
  for (const name of ["recoverFailedPayments", "settleInvites"]) {
    is(`${name} threw: not ok, 500, named`, await run(name).then((r) => [r.ok, r.status, r.failed]), [false, 500, [name]]);
  }
  part("So does every other pass the route does not name as best-effort");
  for (const name of ["sendWinBacks", "sendMemberNudges", "sendYearlyAsks", "sendVerified", "refreshRanges", "moveAllStores"]) {
    is(`${name} threw: not ok, 500, named`, await run(name).then((r) => [r.ok, r.status, r.failed]), [false, 500, [name]]);
  }
  part("The two best-effort passes never fail the run");
  is("the demo store and the research pruning threw: still ok, 200, nothing named", await run("ensureDemoStore", "pruneResearch").then((r) => [r.ok, r.status, r.failed]), [true, 200, []]);
  done();
}
main();
