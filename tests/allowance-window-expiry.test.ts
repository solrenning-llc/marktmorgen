/**
 * A plan allowance's count never outlives its window (Claude 7, follow-up to #4541 and the review of #3369).
 *
 * Before: lib/store-allowance.ts counted with `["SET", k, "0", "NX", "EX", s], ["INCRBY", k, n]`. An Upstash pipeline
 * is not one step: when the key was there for the SET (so it did nothing) and expired before the INCRBY, the INCRBY
 * made it again with no expiry. Every later SET NX did nothing, the window's count only grew, and the store was
 * refused that allowance for good, a paying store included. Now the INCRBY comes first and the expiry is set when the
 * key has none (EXPIRE … NX), as lib/window-count.ts does.
 *
 * Synthetic: the in-memory Redis stand-in, whose pipeline is made to let the key expire between the first command and
 * the next, the worst moment.
 */
import { forceAllowance, holdAllowanceAt, takeAllowance } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** When set, the key the pipeline's first command names expires right after that command runs. */
let expireBetween = false;
redis.pipeline = (async (commands: Command[]) => {
  if (!expireBetween || commands.length < 2) return real(commands);
  expireBetween = false;
  const key = String(commands[0][1]);
  const first = await real([commands[0]]);
  await real([["DEL", key]]);
  return [...first, ...(await real(commands.slice(1)))];
}) as typeof redis.pipeline;

let sequence = 0;
const owner = () => ({ sid: String(++sequence).padStart(32, "7"), handle: `windowexpiry${sequence}`, statsId: null, tier: "creator" as const, cycle: "month" as const, subscriptionId: "sub_WindowExpiry0001", subscriptionActive: true, trialEnds: 0, planEndedAt: "", period: paidPeriod() });

/** Every allowance key with no expiry. */
const forever = () => (redis.run(["SCAN", "0", "MATCH", "*", "COUNT", 100_000]) as [string, string[]])[1].filter((k) => k.includes("allow") && redis.run(["TTL", k]) === -1);

async function main(): Promise<void> {
  for (const [name, count] of [
    ["takeAllowance", (s: ReturnType<typeof owner>) => takeAllowance(s, "studio")],
    ["forceAllowance", (s: ReturnType<typeof owner>) => forceAllowance(s, "studio", 1)],
    ["holdAllowanceAt (this window)", (s: ReturnType<typeof owner>) => holdAllowanceAt(s, "studio", 1, Date.now())],
  ] as const) {
    part(`${name}: the key expires between the two commands`);
    redis.clear();
    const store = owner();
    await count(store);
    is("a count is kept", forever().length === 0 && (redis.run(["SCAN", "0", "MATCH", "*", "COUNT", 100_000]) as [string, string[]])[1].some((k) => k.includes("allow")), true);
    expireBetween = true;
    await count(store);
    is("no allowance count is left without an expiry", forever(), []);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
