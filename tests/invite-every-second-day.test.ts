/**
 * The invite-credit job runs every second day (owner, 17 November 2026: "A cada 2 dias", answering Claude 3 nuvem R's
 * HOLD on #4514). With #2803 in, the job's cost line at 31 daily runs took the Store's refunded first year to US$66.0262,
 * over the owner's US$66. Running on every second UTC day (an even day since the epoch) halves the runs a month can hold
 * (at most 16 in 31 days), and a credit comes at most a day later; it already waits INVITE_HOLD_DAYS before it is earned.
 * On a day the job does not run, it reads and writes nothing: no Stripe call and no Redis command.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { INVITE_EVERY_DAYS, settleInvites } from "@/lib/creator-invite-credit";
import { INVITE_JOB_MONTH_USD, INVITE_JOB_RUNS_PER_MONTH } from "./plan-cost-registry";

const DAY_MS = 86_400_000;
const EVEN = Date.UTC(2026, 9, 16, 12); // an even day since the epoch, as every invite test uses
const ODD = EVEN + DAY_MS;
let stripeCalls = 0;
globalThis.fetch = (async () => {
  stripeCalls++;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
let commands = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands += batch.length;
  return pipeline(batch);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invite_every_second_day";
  redis.clear();
  is("the days are what this test says", [Math.floor(EVEN / DAY_MS) % 2, Math.floor(ODD / DAY_MS) % 2], [0, 1]);

  part("On a day the job does not run, it reads and writes nothing");
  stripeCalls = 0;
  commands = 0;
  const skipped = await settleInvites(Date.now() + 60_000, ODD);
  is("no Stripe call and no Redis command", [stripeCalls, commands], [0, 0]);
  is("and nothing failed", [skipped.failed, skipped.complete], [0, true]);

  part("On the next day it runs as before");
  commands = 0;
  await settleInvites(Date.now() + 60_000, EVEN + 2 * DAY_MS);
  is("it reads its lists", commands > 0, true);

  part("Its cost line is priced at the runs a month can hold");
  is("every second day", INVITE_EVERY_DAYS, 2);
  is("at most 16 runs in a 31-day month", INVITE_JOB_RUNS_PER_MONTH, Math.ceil(31 / INVITE_EVERY_DAYS));
  is("and the company's fixed cost of the job is priced at them", Number.isFinite(INVITE_JOB_MONTH_USD) && INVITE_JOB_MONTH_USD > 0, true);
  done();
}
void main();
