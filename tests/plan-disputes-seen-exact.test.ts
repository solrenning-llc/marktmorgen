/**
 * The plan disputes already seen, read in an unknown shape (rule 24). Read
 * as "none seen", a dispute still open that the list no longer reaches was
 * never re-read and the run said it was complete; every listed dispute was
 * also handled as new (its subscription asked of Stripe again, an
 * "unmatched" retry window started afresh). Unknown now throws, which the
 * daily job catches and logs, so the next run reads it.
 * Synthetic only: the Redis stub and a stand-in for Stripe.
 */
import { SEEN_KEY, syncPlanDisputes } from "@/lib/plan-disputes";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_dispute_seen_only";
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    asked.push(url.pathname);
    if (url.pathname === "/v1/disputes") return Response.json({ object: "list", data: [], has_more: false });
    return new Response(JSON.stringify({ error: { message: "missing" } }), { status: 404 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  await real([["HSET", SEEN_KEY, "du_StillOpen1", "open:0123456789abcdef0123456789abcdef"]]);

  part("Control: the open dispute the list no longer reaches is asked by id");
  asked.length = 0;
  const healthy = await syncPlanDisputes(Date.now() + 10_000);
  is("asked of Stripe by id", asked.includes("/v1/disputes/du_StillOpen1"), true);
  is("counted as a failed re-read", healthy.failed, 1);

  for (const [label, reply] of [["no reply", []], ["undefined", [undefined]], ["a number", [1]], ["an odd list", [["du_StillOpen1"]]], ["a list with a number", [["du_StillOpen1", 5]]], ["two replies", [[], []]]] as const) {
    part(`The seen disputes answer ${label}`);
    asked.length = 0;
    redis.pipeline = (async (c: Commands) => (c[0]?.[0] === "HGETALL" && c[0][1] === SEEN_KEY ? [...reply] : real(c))) as typeof redis.pipeline;
    let outcome: string;
    try {
      const counts = await syncPlanDisputes(Date.now() + 10_000);
      outcome = counts.complete ? "complete" : "incomplete";
    } catch {
      outcome = "rejected";
    } finally {
      redis.pipeline = real;
    }
    is("never a complete run on a guess", outcome, "rejected");
    is("and Stripe was not asked on it", asked.length, 0);
  }
  done();
}

void main();
