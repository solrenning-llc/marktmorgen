/**
 * A store's public sold-count refresh (lib/sold-count.ts refreshSoldCounts, started after a store or product page is
 * sent) reads the creator's Stripe account, up to ALL_TIME_PAGES pages, and is priced per attempt (line
 * "sold-count-refresh" in tests/plan-cost-registry.ts). An attempt is bounded to one per store per SOLD_FRESH_MS,
 * whatever its outcome: a read that fails or keeps nothing must not let the next visit, five minutes later, read
 * Stripe again (coordinator 20261122T023645Z-claude-1-coord-0cb0 on #4966).
 *
 * Synthetic data, a stand-in read.
 */
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail, updateLook } from "@/lib/store";
import { DEFAULT_LOOK } from "@/lib/store-look";
import { SOLD_FRESH_MS, SOLD_REFRESH_ATTEMPTS_PER_DAY, SOLD_REFRESH_COMMANDS, refreshSoldCounts } from "@/lib/sold-count";
import { readAllTimeSales } from "@/lib/stats";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "sold-bound@example.com";

process.env.STRIPE_SECRET_KEY = "sk_test_sold_bound";
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path.endsWith("/checkout/sessions")) {
    return answer({
      data: [{ id: "cs_test_soldbound1", status: "complete", payment_status: "paid", amount_total: 5000, currency: "usd", created: 1_790_000_000, payment_intent: "pi_soldbound1", customer_details: { email: "a@example.com" }, metadata: { store: "soldbound", product: "p1" } }],
      has_more: false,
    });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Commands = (string | number)[][];
type Pipeline = (commands: Commands) => Promise<unknown[]>;
const realPipeline: Pipeline = redis.pipeline.bind(redis);
let hook: Pipeline | null = null;
(redis as unknown as { pipeline: Pipeline }).pipeline = (commands) => (hook ? hook(commands) : realPipeline(commands));

/**
 * Counts every command, and a script as itself plus each redis.call it runs, as Upstash bills it: the live fence runs
 * HGET, GET and SET for a store with an id (its branch for a store from before ids is never run here); any other
 * script is counted at every redis.call in its text, which is never less than it runs.
 */
function counting(): () => number {
  let commands = 0;
  hook = async (batch) => {
    for (const c of batch) {
      if (c[0] !== "EVAL") { commands += 1; continue; }
      const source = String(c[1]);
      commands += 1 + (source.startsWith("-- marktmorgen:store-cache-live:v3\n") && c[9] === "" ? 3 : (source.match(/redis\.call/g)?.length ?? 0));
    }
    return realPipeline(batch);
  };
  return () => commands;
}

async function freshStore() {
  redis.clear();
  await claimHandle(OWNER, "soldbound", "Sold Bound", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSoldBound1", true);
  await updateLook(OWNER, { ...DEFAULT_LOOK, sold: true });
  return (await storeForEmail(OWNER))!;
}

async function main(): Promise<void> {
  part("A failed read waits SOLD_FRESH_MS before Stripe is read again");
  {
    const store = await freshStore();
    let reads = 0;
    const failing = async () => {
      reads += 1;
      throw new Error("synthetic Stripe failure");
    };
    const now = 1_800_000_000_000;
    is("the first attempt reads and keeps nothing", [await refreshSoldCounts(store, failing, now), reads], [null, 1]);
    advance(301_000);
    is("a visit five minutes later reads nothing", [await refreshSoldCounts(store, failing, now + 301_000), reads], [null, 1]);
    advance(SOLD_FRESH_MS - 301_000 - 1_000);
    is("nor one just before SOLD_FRESH_MS", [await refreshSoldCounts(store, failing, now + SOLD_FRESH_MS - 1_000), reads], [null, 1]);
    advance(2_000);
    is("after SOLD_FRESH_MS it is read again", [await refreshSoldCounts(store, failing, now + SOLD_FRESH_MS + 1_000), reads], [null, 2]);
  }

  part("A read that answers nothing is bounded the same way");
  {
    const store = await freshStore();
    let reads = 0;
    const empty = async () => {
      reads += 1;
      return null;
    };
    await refreshSoldCounts(store, empty);
    advance(301_000);
    await refreshSoldCounts(store, empty);
    is("one read in five minutes", reads, 1);
  }

  part("One attempt at its worst, a cache miss with the real all-time reading, bills at most SOLD_REFRESH_COMMANDS");
  {
    const store = await freshStore();
    const commands = counting();
    const kept = await refreshSoldCounts(store, readAllTimeSales);
    hook = null;
    is("it read and kept the count", kept?.byProduct, { p1: 1 });
    is(`its billed commands (${commands()}) fit SOLD_REFRESH_COMMANDS`, commands() <= SOLD_REFRESH_COMMANDS, true);
  }

  part("The priced number of attempts a day follows SOLD_FRESH_MS");
  is("SOLD_REFRESH_ATTEMPTS_PER_DAY", SOLD_REFRESH_ATTEMPTS_PER_DAY, Math.ceil(86_400_000 / SOLD_FRESH_MS));

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
