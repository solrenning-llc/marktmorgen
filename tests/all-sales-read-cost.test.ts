/**
 * What an all-time sales reading costs the store's studio figure (Codex P's LOW on #4970, confirmed by Claude 1 in
 * 7071702187). The reading's two cache writes are fenced on the store's life (lib/live-fence.ts SET_IF_STORE_LIVE),
 * so each is a script Upstash bills as itself and each redis.call it runs: on its worst path, a cache miss,
 * ALL_TIME_READ_COMMANDS (10) billed commands where two plain SETs made 4. The studio's GET /api/store/stats asks for
 * it, and that request is priced as one studio request (UNIT_COST.studio in tests/plan-cost-registry.ts: twenty
 * commands, TAKE_COMMANDS and LOCKED_UNTIL_STAR_COMMANDS); this test holds the whole route inside it.
 *
 * Synthetic data, a Stripe stand-in.
 */
import { NextRequest } from "next/server";
import { ALL_TIME_READ_COMMANDS, readAllTimeSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET as statsRoute } from "@/app/api/store/stats/route";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_all_sales_cost";

const S = Date.parse("2026-11-01T12:00:00Z") / 1000;
const HANDLE = "allsalescost";
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path.endsWith("/checkout/sessions")) {
    return answer({
      data: [{ id: "cs_test_allsalescost1", status: "complete", payment_status: "paid", amount_total: 5000, currency: "usd", created: S, payment_intent: "pi_allsalescost1", customer_details: { email: "a@example.com" }, metadata: { store: HANDLE, product: "p1" } }],
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
 * Counts every command, and a script as itself plus each redis.call it runs, as Upstash bills it. The fence script
 * has a branch for a store from before ids that a store with an id never runs: on that path it runs HGET, GET and
 * SET (FENCE_RUNS); any other script is counted at every redis.call in its text, which is never less than it runs.
 */
const FENCE_RUNS = 3;
function counting(): { commands: () => number } {
  let commands = 0;
  hook = async (batch) => {
    for (const c of batch) {
      if (c[0] !== "EVAL") { commands += 1; continue; }
      const source = String(c[1]);
      commands += 1 + (source.startsWith("-- marktmorgen:store-cache-live:v3\n") && c[9] === "" ? FENCE_RUNS : (source.match(/redis\.call/g)?.length ?? 0));
    }
    return realPipeline(batch);
  };
  return { commands: () => commands };
}

const OWNER = "all-sales-cost@example.com";

async function freshStore(): Promise<Store> {
  redis.clear();
  hook = null;
  await claimHandle(OWNER, HANDLE, "All Sales Cost", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_synthAllSalesCost", true);
  await setSubscription(OWNER, { customerId: "cus_allsalescost", subscriptionId: "sub_allsalescost", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

async function main(): Promise<void> {
  part("The reading alone, on a cache miss: ALL_TIME_READ_COMMANDS billed commands");
  {
    const store = await freshStore();
    const count = counting();
    const read = await readAllTimeSales(store);
    hook = null;
    is("it read the one sale", read?.totals, { sales: 1, cents: 5000 });
    is("its commands, each fenced write counted with what it runs, are ALL_TIME_READ_COMMANDS", count.commands(), ALL_TIME_READ_COMMANDS);
    is("both caches were kept", [Number(redis.run(["EXISTS", `nl:stats:${store.statsId}:allsales`])), Number(redis.run(["EXISTS", `nl:next:${store.statsId}`]))], [1, 1]);
  }

  part("The studio's request for it fits one studio request (UNIT_COST.studio)");
  {
    await freshStore();
    const session = await openSession(OWNER);
    const count = counting();
    const response = await statsRoute(new NextRequest("https://marktmorgen.com/api/store/stats", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
    hook = null;
    is("answered with the reading", [response.status, ((await response.json()) as { ok?: boolean }).ok], [200, true]);
    is(`its commands, scripts counted with what they run (${count.commands()}), fit one studio request`, count.commands() <= 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, true);
  }

  part("A kept reading costs one GET");
  {
    const store = await freshStore();
    await readAllTimeSales(store);
    const count = counting();
    await readAllTimeSales(store);
    hook = null;
    is("read from its ten-minute copy", count.commands(), 1);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
