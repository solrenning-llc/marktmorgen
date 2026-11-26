/**
 * The closing journey (tests/closing-journey.ts) against a real Redis,
 * built with the real "@/lib/redis" by scripts/test_closed_store_redis.py,
 * which serves Upstash's REST pipeline in front of a dedicated, empty Redis
 * database and tears it down after. The file store is an in-memory
 * stand-in, never the real bucket. Not a *.test.ts: npm
 * test does not run it, the product checks' Redis job does.
 */
import { type Sent, type StripeWorld, runClosingJourney, standIns } from "./closing-journey";
// TEAM_INDEX_OFF_TEAM on a real Redis (#5010 row 133), which the in-memory stand-in cannot show.
import { runTeamIndexShapeCheck } from "./team-index-real-redis";

const sent: Sent[] = [];
const stripe: StripeWorld = { sessions: [], memberships: [], posted: [] };
const realFetch = globalThis.fetch;
const proxy = String(process.env.UPSTASH_REDIS_REST_URL ?? "");
globalThis.fetch = standIns(stripe, sent, async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!proxy || !url.startsWith(proxy)) throw new Error(`no network in this check: ${new URL(url).hostname}`);
  return realFetch(input as string, init);
});

let checks = 0;
let failures = 0;
const is = (what: string, got: unknown, want: unknown) => {
  checks += 1;
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`PASS: ${what}`);
    return;
  }
  failures += 1;
  console.log(`FAIL: ${what}\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`);
};

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_closed_store_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_closed_store_only_a_stand_in";
  for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[name];
  await runClosingJourney(is, sent, stripe);
  await runTeamIndexShapeCheck(is);
  console.log(failures ? `${checks} checks, ${failures} failing.` : `${checks} checks, all passing.`);
  process.exit(failures ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
