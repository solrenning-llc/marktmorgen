/**
 * What an all-time sales reading costs the store's studio figure (Codex P's LOW on #4970, confirmed by Claude 1 in
 * 7071702187). The reading's two cache writes are fenced on the store's life (lib/live-fence.ts SET_IF_STORE_LIVE),
 * so each is a script Upstash bills as itself and each redis.call it runs: on its worst path, a cache miss with a
 * PayPal sale (the PayPal read's range and the MGET of its records; Claude 1 on #4970), ALL_TIME_READ_COMMANDS (11)
 * billed commands. The studio's GET /api/store/stats asks for it, and that request is priced as one studio request
 * (UNIT_COST.studio in tests/plan-cost-registry.ts: twenty commands, TAKE_COMMANDS and LOCKED_UNTIL_STAR_COMMANDS);
 * this test holds the whole route inside it in commands only, not in bytes or Stripe pages.
 *
 * Synthetic data, a Stripe stand-in.
 */
import { NextRequest } from "next/server";
import { ALL_TIME_BYTES_PER_UNIT, ALL_TIME_PAGES, ALL_TIME_READ_COMMANDS, ALL_TIME_READ_UNITS, AllTimeNotCounted, readAllTimeSales } from "@/lib/stats";
import { BUYER_LEDGER_UNITS, LEDGER_BYTES_PER_UNIT } from "@/lib/segments";
import { IncludedBytes } from "@/lib/sent-bytes";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { MAX_PAID_BYTES } from "@/lib/paypal-sales";
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET as statsRoute } from "@/app/api/store/stats/route";
import { ALL_TIME_READ, LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS, UNIT_COST } from "./plan-cost-registry";
import { paidKey, salesKey } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_all_sales_cost";

const S = Date.parse("2026-11-01T12:00:00Z") / 1000;
const HANDLE = "allsalescost";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  stripeCalls += 1;
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
  await setStripeAccount(OWNER, "acct_1TestAllSales", true);
  await setSubscription(OWNER, { customerId: "cus_allsalescost", subscriptionId: "sub_allsalescost", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

async function main(): Promise<void> {
  part("The reading alone, on a cache miss with a PayPal sale: ALL_TIME_READ_COMMANDS billed commands");
  {
    const store = await freshStore();
    // One PayPal sale, so the PayPal read takes its MGET too: the worst path (Claude 1 on #4970).
    const order = "PPSYNTHALLSALES001";
    await redis.pipeline([
      ["ZADD", salesKey(store.statsId!), String(S), order],
      ["SET", paidKey(order), JSON.stringify({ store: store.statsId, order, capture: "CAPSYNTH001", email: "b@example.com", product: "p1", cents: 2000, currency: "usd", at: S })],
    ]);
    const count = counting();
    const read = await readAllTimeSales(store);
    hook = null;
    is("it read both sales, the Stripe one and the PayPal one", read?.totals, { sales: 2, cents: 7000 });
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
    is(`its commands, scripts counted with what they run (${count.commands()}), fit one studio request in commands`, count.commands() <= 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, true);
  }

  part("Its studio requests pay for the whole reading, counted like a reading of the buyers (7074257093, 7074905617)");
  {
    is("ALL_TIME_READ fits ALL_TIME_READ_UNITS studio requests", ALL_TIME_READ <= UNIT_COST.studio * ALL_TIME_READ_UNITS, true);
    is("the same Stripe part and the same rate by size as a reading of the buyers", [ALL_TIME_READ_UNITS, ALL_TIME_BYTES_PER_UNIT], [BUYER_LEDGER_UNITS, LEDGER_BYTES_PER_UNIT]);
  }

  part("A studio reading is counted before Stripe or PayPal is read");
  {
    const store = await freshStore();
    // Many PayPal sales kept: counted by their weight, at the most ALL_TIME_PAGES * 100 of them.
    const members: (string | number)[] = [];
    for (let i = 0; i < 2_500; i += 1) members.push(String(S + i), `PPSYNTHCOUNT${i}`);
    await redis.pipeline([["ZADD", salesKey(store.statsId!), ...members]]);
    const asked: number[] = [];
    stripeCalls = 0;
    const refused = await readAllTimeSales(store, async (units) => { asked.push(units); return false; }).then(() => "read", (error: unknown) => (error instanceof AllTimeNotCounted ? "not counted" : String(error)));
    const expected = ALL_TIME_READ_UNITS + new IncludedBytes().take(Math.min(2_500, ALL_TIME_PAGES * 100) * MAX_PAID_BYTES, ALL_TIME_BYTES_PER_UNIT).units;
    is("refused, it reads nothing from Stripe and keeps no copy", [refused, stripeCalls, Number(redis.run(["EXISTS", `nl:stats:${store.statsId}:allsales`]))], ["not counted", 0, 0]);
    is("it asked once, for the Stripe part and the PayPal records by weight", asked, [expected]);
    const granted: number[] = [];
    const read = await readAllTimeSales(store, async (units) => { granted.push(units); return true; });
    is("counted, it reads", [read ? "read" : "none", granted, stripeCalls > 0], ["read", [expected], true]);
  }

  part("A kept copy is counted by its size, and read no further than counted");
  {
    const store = await freshStore();
    await readAllTimeSales(store);
    const key = `nl:stats:${store.statsId}:allsales`;
    const kept = String(redis.run(["GET", key]));
    // A copy of two megabytes and a half, as one from a store with many products could be.
    const big = kept.slice(0, -1) + `,"pad":"${"x".repeat(2_500_000)}"}`;
    redis.run(["SET", key, big]);
    const asked: number[] = [];
    stripeCalls = 0;
    const refused = await readAllTimeSales(store, async (units) => { asked.push(units); return false; }).then(() => "read", (error: unknown) => (error instanceof AllTimeNotCounted ? "not counted" : String(error)));
    is("refused by its size, nothing more is read", [refused, asked, stripeCalls], ["not counted", [new IncludedBytes().take(big.length, ALL_TIME_BYTES_PER_UNIT).units], 0]);
    const unknown = await freshStore();
    hook = async (batch) => (batch[0]?.[0] === "STRLEN" ? ["not a size"] : realPipeline(batch));
    const strange = await readAllTimeSales(unknown, async () => true).then(() => "read", (error: unknown) => (error instanceof AllTimeNotCounted ? "not counted" : String(error)));
    hook = null;
    is("a size in another shape is unknown, never none: nothing is read (rule 24)", [strange, stripeCalls], ["not counted", 0]);
  }

  part("The route refuses with the sentence when the studio requests are not left, and reads nothing");
  {
    const store = await freshStore();
    const session = await openSession(OWNER);
    const cookie = { headers: { cookie: `${SESSION_COOKIE}=${session}` } };
    // Room for the route's own request only (lib/studio-route.ts takes it first): the reading needs ALL_TIME_READ_UNITS.
    const { countStudio } = await import("@/lib/studio-route");
    await countStudio(store, null, 1);
    const studioKey = redis.keys().find((k) => k.startsWith("nl:allow:studio:"))!;
    await redis.pipeline([["SET", studioKey, String(allowanceFor(store, "studio") - 4)]]);
    stripeCalls = 0;
    const response = await statsRoute(new NextRequest("https://marktmorgen.com/api/store/stats", cookie));
    const body = (await response.json()) as { ok?: boolean; error?: string; message?: string };
    is("429 studio_used, with how many it needs and how many are left", [response.status, body.ok, body.error, (body.message ?? "").startsWith(`This needs ${ALL_TIME_READ_UNITS} of your studio requests, and only 3 are left.`)], [429, false, "studio_used", true]);
    is("and Stripe was not read", stripeCalls, 0);
    const page = readFileSync("app/studio/page.tsx", "utf8");
    is("the studio page's background reading counts its studio requests too", page.includes("readAllTimeSales(store, countLedger(store).count)"), true);
    const panel = readFileSync("components/stats-panel.tsx", "utf8");
    is("the panel says the refusal's sentence, never that Stripe did not answer", panel.includes('body.error === "studio_used"'), true);
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
