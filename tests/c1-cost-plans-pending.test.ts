/**
 * The daily job that gives payment plans their end (lib/plans.ts, settlePlans)
 * reads at most the members it settles in a run, never the whole pending set.
 *
 * Every plan checkout opened (app/api/store/checkout, 20 per connection and
 * store every ten minutes) adds a member to nl:plans:pending, and only the
 * daily job takes members out, at most 200 a run. Read with SMEMBERS, the job
 * pulled the whole set on every run whatever it then settled: with 1,000
 * checkouts open, 1,000 members came back to settle 200, and a backlog that
 * grows by every day over 200 is read whole, every day, for good.
 *
 * Synthetic: a stand-in for Stripe, the in-memory Redis.
 */
import { rememberPlan, settlePlans } from "@/lib/plans";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plans_pending_only";

const ACCOUNT = "acct_1TestPend";
const OPENED = 1_000;
const PER_RUN = 200;

// Every checkout is still open at Stripe: the job keeps each for its two days.
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session) return new Response(JSON.stringify({ id: session[1], status: "open", subscription: null, metadata: { kind: "plan", plan_payments: "3", plan_interval: "month" } }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

/** The most members of nl:plans:pending one reply carried during `run`. */
async function widestRead(run: () => Promise<unknown>): Promise<number> {
  const original = redis.pipeline.bind(redis);
  let widest = 0;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    const answers = await original(batch);
    batch.forEach((command, i) => {
      if (command[1] === "nl:plans:pending" && Array.isArray(answers[i])) widest = Math.max(widest, (answers[i] as unknown[]).length);
    });
    return answers;
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = original;
  }
  return widest;
}

async function main(): Promise<void> {
  redis.clear();
  part("A thousand plan checkouts open, the job settling two hundred a run");
  for (let n = 0; n < OPENED; n += 1) await rememberPlan(ACCOUNT, `cs_test_pend${String(n).padStart(8, "0")}`);
  is("all of them are pending", redis.run(["SCARD", "nl:plans:pending"]), OPENED);
  let counts: Awaited<ReturnType<typeof settlePlans>> | null = null;
  const widest = await widestRead(async () => {
    counts = await settlePlans();
  });
  is(`the run read at most the ${PER_RUN} members it settles, not the whole set`, widest <= PER_RUN, true);
  is("it looked at 200 and kept each open one for its two days", [counts!.open, counts!.done, counts!.dropped, counts!.failed], [PER_RUN, 0, 0, 0]);
  is("nothing open was let go", redis.run(["SCARD", "nl:plans:pending"]), OPENED);
  done();
}

void main();
