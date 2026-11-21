/**
 * A use refused for going over the figure is given back without ever making a counter below zero with no expiry.
 *
 * takeAllowance and holdAllowanceAt gave a refused use back with a bare DECRBY. A counter gone between the count and
 * that give-back (its expiry at the window's edge, the store erased) was made again at -n with no expiry: n more uses
 * in that window than the plan has, and a key kept for ever (Codex L on #4072, mq-pre of cfb2244a17). Both now give
 * back through GIVE_ALLOWANCE_BACK, as giveAllowance and giveAllowanceIn already did.
 */
import { holdAllowanceAt, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const owner = {
  sid: "8".repeat(32),
  handle: "refusedgiveback",
  statsId: null,
  tier: "creator" as const,
  cycle: "month" as const,
  subscriptionId: "sub_RefusedGiveBack01",
  subscriptionActive: true,
  trialEnds: 0,
  planEndedAt: "",
  period: paidPeriod(),
};
const counters = () => redis.keys().filter((k) => k.startsWith("nl:allow:studio:"));
const original = redis.pipeline.bind(redis);

/** Deletes `key` right after the next command that counts it is answered: the counter gone before the give-back. */
function vanishAfterCount(key: () => string | undefined): void {
  let armed = true;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    const replies = await original(batch);
    const k = key();
    if (armed && k && batch.some((c) => (c[0] === "INCRBY" || c[0] === "INCR") && c[1] === k)) {
      armed = false;
      await original([["DEL", k]]);
    }
    return replies;
  }) as typeof redis.pipeline;
}

async function state(k: string): Promise<{ value: unknown; ttl: unknown }> {
  const [value, ttl] = await original([["GET", k], ["TTL", k]]);
  return { value, ttl };
}

async function main(): Promise<void> {
  const now = Date.now();
  const limit = allowanceFor(owner, "studio", now / 1000);
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error("a figure of at least 2 is needed");

  // takeAllowance: the figure filled, one more refused, its counter gone between the count and the give-back.
  redis.clear();
  is("the whole figure is taken", (await takeAllowance(owner, "studio", limit, now)).ok, true);
  const [taken] = counters();
  vanishAfterCount(() => taken);
  const over = await takeAllowance(owner, "studio", 1, now);
  redis.pipeline = original;
  is("one more is refused", [over.ok, over.ok ? "" : over.reason], [false, "used"]);
  is("the counter gone before the give-back stays gone: never made again below zero", (await state(taken)).value, null);

  // Control: the counter still there is given back to the figure, its expiry kept, never below zero.
  redis.clear();
  await takeAllowance(owner, "studio", limit, now);
  const [kept] = counters();
  await takeAllowance(owner, "studio", 1, now);
  const after = await state(kept);
  is("an existing counter is given back to the figure", Number(after.value), limit);
  is("and keeps its expiry", typeof after.ttl === "number" && after.ttl > 0, true);

  // holdAllowanceAt, for a later month: the same give-back on that month's counter.
  redis.clear();
  const later = now + 25 * 86_400_000;
  const held = await holdAllowanceAt(owner, "studio", limit, later, now);
  is("the later month's whole figure is held", held.ok, true);
  const [future] = counters();
  vanishAfterCount(() => future);
  const refused = await holdAllowanceAt(owner, "studio", 1, later, now);
  redis.pipeline = original;
  is("one more for that month is refused", [refused.ok, refused.ok ? "" : refused.reason], [false, "used"]);
  is("that month's counter gone before the give-back stays gone", (await state(future)).value, null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
