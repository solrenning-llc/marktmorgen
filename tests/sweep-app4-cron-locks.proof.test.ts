/**
 * Sweep APP4 proof (CX-123 rules 24/30), synthetic only: Redis is the in-memory double, every provider a stand-in.
 *
 * Lot L10a (a1d9267a8) moved the courses, reminders, Discord and quiet-sales jobs to lib/claim-mark.ts: their run lock
 * is ours only on SET NX's own "OK" (or our value read back), an answer in another shape is "lock_unknown" (503, the
 * job does not run), and the lock is let go with releaseMark only while it still holds this run's value. Thirteen
 * other jobs kept the old shape:
 *
 *   const [got] = await redisPipeline([["SET", LOCK, "1", "NX", "EX", n]]);
 *   if (got === null) return busy;            // any other answer = ours
 *   ... finally { DEL LOCK }                  // whoever holds it
 *
 * So when the SET's answer is lost or in another shape while ANOTHER run holds the lock, the job runs beside it, and
 * its `finally` deletes the other run's lock, which lets a third run start too. Shown here on jobs whose bodies run
 * against an empty world: plans (payment-plan charges, subscriptions, recoveries, invites credit), mail (every
 * email queue, webhooks), closing (plan refunds and undos, store closings), affiliates (affiliate payday and PayPal
 * payouts), imports, closed-data (deletion of closed stores' records), recount, monthly and weekly (reports).
 * Same lines, not run here because their bodies need configuration this proof does not fake: stripe-check (demo
 * checkout key), shares (COMMISSION_LIVE false today), stream (Bunny), mail-check (mail checker settings).
 *
 * Each job: healthy control (the lock held by another run, nil answer: busy, the other run's lock kept), then the
 * DEFECT (the same, the SET answering in another shape: the job runs and the other run's lock is deleted).
 */
import { NextRequest } from "next/server";
import { GET as plansCron } from "@/app/api/cron/plans/route";
import { GET as mailCron } from "@/app/api/cron/mail/route";
import { GET as closingCron } from "@/app/api/cron/closing/route";
import { GET as affiliatesCron } from "@/app/api/cron/affiliates/route";
import { GET as importsCron } from "@/app/api/cron/imports/route";
import { GET as closedDataCron } from "@/app/api/cron/closed-data/route";
import { GET as recountCron } from "@/app/api/cron/recount/route";
import { GET as monthlyCron } from "@/app/api/cron/monthly/route";
import { GET as weeklyCron } from "@/app/api/cron/weekly/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sweep_app4_stand_in";
process.env.RESEND_API_KEY = "re_test_sweep_app4_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Commands = (string | number)[][];
type Job = (request: NextRequest) => Promise<Response>;

const jobs: [string, string, Job][] = [
  ["plans", "nl:plans:lock", plansCron as Job],
  ["mail", "nl:mail:lock", mailCron as Job],
  ["closing", "nl:closing:lock", closingCron as Job],
  ["affiliates", "nl:aff:payday:lock", affiliatesCron as Job],
  ["imports", "nl:imports:lock", importsCron as Job],
  ["closed-data", "nl:closed:lock", closedDataCron as Job],
  ["recount", "nl:recount:lock", recountCron as Job],
  ["monthly", "nl:monthly:lock", monthlyCron as Job],
  ["weekly", "nl:weekly:lock", weeklyCron as Job],
];

/** Runs the job with the lock's SET answered by `reply` (null: as Redis would; otherwise a shape it never gives). */
async function run(name: string, lock: string, GET: Job, reply: unknown): Promise<{ status: number; busy: boolean; ranAfterLock: number; lockAfter: unknown }> {
  redis.clear();
  redis.run(["SET", lock, "another-run", "EX", 300]);
  const real = redis.pipeline.bind(redis);
  let used = false;
  let ranAfterLock = 0;
  redis.pipeline = (async (commands: Commands) => {
    const first = commands[0];
    if (!used && first?.[0] === "SET" && first?.[1] === lock) {
      used = true;
      return reply === null ? real(commands) : reply;
    }
    if (used && !(first?.[0] === "DEL" && first?.[1] === lock)) ranAfterLock += 1;
    return real(commands);
  }) as typeof redis.pipeline;
  let response: Response;
  try {
    response = await GET(new NextRequest(`https://local.example/api/cron/${name}`));
  } finally {
    redis.pipeline = real;
  }
  const body = (await response.json().catch(() => ({}))) as { busy?: boolean };
  return { status: response.status, busy: body.busy === true, ranAfterLock, lockAfter: redis.run(["GET", lock]) };
}

async function main() {
  for (const [name, lock, GET] of jobs) {
    part(`cron/${name} — healthy control: another run holds ${lock}; SET NX answers nil`);
    const healthy = await run(name, lock, GET, null);
    is("healthy: busy, nothing else read or written, the other run's lock kept", [healthy.busy, healthy.ranAfterLock, healthy.lockAfter], [true, 0, "another-run"]);

    for (const [label, reply] of [["no reply", []], ["queued", ["QUEUED"]]] as [string, unknown][]) {
      part(`cron/${name} — DEFECT: the same, SET NX answering ${label}`);
      const out = await run(name, lock, GET, reply);
      is(`DEFECT (${label}): read as ours, the job ran beside the other run`, [out.busy, out.ranAfterLock > 0], [false, true]);
      is(`DEFECT (${label}): and its finally deleted the other run's lock`, out.lockAfter, null);
    }
  }
  done();
}

void main();
