/**
 * Codex X6's two LOWs on #3630 (confirmed by Claude 1, 7067118104), lib/made-to-order.ts keepMadeOrder:
 *   1. Two keeps of the same sale at once, one whose SET answer was lost before it landed: the other's record must
 *      not read back as the first one's own, so exactly one of them says "kept".
 *   2. A retry of a sale already on the store's list (its record never written) must end its record no later than
 *      the list's own score, so the person's copy and erasure can always find it.
 * Synthetic data, the in-memory database; nothing real is reached.
 */
import { startOrder } from "@/lib/made-to-order-rules";
import { CLOCK_SLACK_SECONDS, KEEP_SECONDS, keepMadeOrder } from "@/lib/made-to-order";
import type { DataStore } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis) as Pipeline;

const STATS = "mto-stats-ct";
const SHOP: DataStore = { sid: "mto-store-ct", statsId: STATS, tier: "creator", subscriptionActive: true, subscriptionId: "sub_mto_ct", trialEnds: 0, planEndedAt: "" };
const NOW = Date.now();
const NOW_S = Math.floor(NOW / 1000);
const ANN = "ann@example.com";
const sale = (n: number) => `cs_test_${String(n).padStart(12, "0")}`;
const list = `nl:mto:i:${STATS}`;
const recordSet = (commands: Commands) => commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:mto:o:");
const reset = () => {
  redis.pipeline = real;
  redis.clear();
};

void (async () => {
  part("1. Same sale at once, one SET answer lost before it landed: one keep only");
  reset();
  const order = startOrder({ paidAt: NOW_S - 3_600, days: 14 })!;
  let other: string | null = null;
  let lost = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!lost && recordSet(commands)) {
      lost = true;
      // This SET never lands; meanwhile another keep of the same sale runs whole, then this answer is lost.
      redis.pipeline = real;
      other = await keepMadeOrder(SHOP, { sale: sale(1), email: ANN, order }, NOW);
      redis.pipeline = wrapped;
      return ["lost"];
    }
    return real(commands);
  }) as Pipeline;
  const wrapped = redis.pipeline;
  const first = await keepMadeOrder(SHOP, { sale: sale(1), email: ANN, order }, NOW);
  redis.pipeline = real;
  is("the other keep wrote the record", other, "kept");
  is("the keep whose answer was lost does not take the other's record as its own", first === "kept", false);
  is("exactly one says kept", [first, other].filter((r) => r === "kept").length, 1);

  part("2. A retry of a sale already listed ends no later than the list's score");
  reset();
  const ahead = startOrder({ paidAt: NOW_S + 200, days: 14 })!;
  // The first keep lists the sale, then its SET is refused before it lands: nothing is written.
  redis.pipeline = (async (commands: Commands) => (recordSet(commands) ? ["lost"] : real(commands))) as Pipeline;
  const firstTry = await keepMadeOrder(SHOP, { sale: sale(2), email: ANN, order: ahead }, NOW);
  redis.pipeline = real;
  is("control: the first try did not say kept", firstTry === "kept", false);
  const [members] = await real([["ZRANGE", list, 0, -1, "WITHSCORES"]]);
  const score = Array.isArray(members) && members.length === 2 ? Number(members[1]) : NaN;
  is("control: the sale is on the list, ending KEEP_SECONDS from the first try", score, NOW_S + KEEP_SECONDS);
  // The retry comes 250 s later, after the payment time (inside CLOCK_SLACK_SECONDS).
  const later = NOW + 250_000;
  let ttl: number | null = null;
  redis.pipeline = (async (commands: Commands) => {
    if (recordSet(commands)) ttl = Number(commands[0][commands[0].length - 1]);
    return real(commands);
  }) as Pipeline;
  const retry = await keepMadeOrder(SHOP, { sale: sale(2), email: ANN, order: ahead }, later);
  redis.pipeline = real;
  is("control: 250 s is inside the clock slack", 250 < CLOCK_SLACK_SECONDS, true);
  is("the retry keeps the record", retry, "kept");
  is("the record ends no later than the list's score", ttl !== null && Math.floor(later / 1000) + ttl <= score, true);
  done();
})().catch((error: unknown) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  process.exit(1);
});
