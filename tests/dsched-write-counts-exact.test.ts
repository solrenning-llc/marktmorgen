/** Codex X8 (X8-20261119-0816-fix-main-discount-schedule-counts, MEDIUM, money). One field/member per write: impossible counts cannot confirm cancellation. Synthetic Redis and provider only. */
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
const DUE_KEY = "nl:dsched:due";
const TELL_KEY = "nl:dsched:tell";

process.env.STRIPE_SECRET_KEY = "sk_test_x8_synthetic";
process.env.STRIPE_CONNECT_API_BASE = "http://127.0.0.1:4998";
const shop = { sid: "a".repeat(32), statsId: "b".repeat(32), stripeAccountId: "acct_X8Synthetic" };
const id = "promo_X8Synthetic";
const key = `nl:dsched:${shop.statsId}`;
const member = `${shop.sid}|${shop.statsId}|${id}`;
const now = 1_800_000_000;
const realPipeline = redis.pipeline.bind(redis);
const originalFetch = globalThis.fetch;
let active = false;
let providerCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) !== `http://127.0.0.1:4998/promotion_codes/${id}` && String(input) !== `http://127.0.0.1:4998/v1/promotion_codes/${id}`) throw Error("Unexpected synthetic request");
  providerCalls += 1;
  active = new URLSearchParams(String(init?.body)).get("active") === "true";
  return new Response(JSON.stringify({ id, active }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function seed() {
  await realPipeline([["DEL", key, DUE_KEY, TELL_KEY, `nl:dsched:lock:${shop.statsId}`]]);
  await realPipeline([["HSET", key, id, JSON.stringify({ c: "X8TEST", s: now, e: now + 3600, t: 0, f: 0 })], ["ZADD", DUE_KEY, now, member]]);
  providerCalls = 0;
  active = false;
}
async function withReply(reply: unknown, work: () => Promise<unknown>) {
  redis.pipeline = async (commands) => {
    if (commands.length === 3 && commands[0][0] === "HDEL" && commands[1][0] === "ZREM" && commands[2][0] === "ZREM") return reply as unknown[];
    return realPipeline(commands);
  };
  try { return await work(); } finally { redis.pipeline = realPipeline; }
}
async function main() {
  try {
    const { activateScheduledCodes, cancelSchedule, dropSchedule } = await import("@/lib/discount-schedule");
    part("RED: each single-member removal refuses a count above one");
    for (const bad of [2, Number.MAX_SAFE_INTEGER]) {
      for (let slot = 0; slot < 3; slot += 1) {
        await seed();
        const replies = [1, 1, 1]; replies[slot] = bad;
        is(`slot ${slot}, count ${bad}: unknown`, await withReply(replies, () => dropSchedule(shop, id)), "unknown");
        is("control: schedule remains present", typeof (await realPipeline([["HGET", key, id]]))[0], "string");
      }
    }
    part("RED: false cancel permits a future reactivation of the discount");
    await seed();
    const canceled = await withReply([2, 1, 1], () => cancelSchedule(shop, id));
    const callsAtCancel = providerCalls;
    const next = await activateScheduledCodes(Date.now() + 10_000, now, {
      findStore: async () => shop,
      markDiscounts: async () => ({ ...shop, hasDiscounts: true }),
    });
    is("cancel remains unknown when its removal cannot be confirmed", canceled, "unknown");
    is("unconfirmed removal does not tell the provider it canceled the schedule", callsAtCancel, 0);
    is("control: retained schedule is activated at its due time", [next.activated, active], [1, true]);

    part("Controls: healthy removal and legitimate zero replies");
    await seed();
    is("healthy drop completes", await dropSchedule(shop, id), "done");
    is("healthy drop removes schedule and due member", await realPipeline([["HGET", key, id], ["ZSCORE", DUE_KEY, member]]), [null, null]);
    is("already absent schedule completes", await dropSchedule(shop, id), "done");
    await seed();
    is("healthy cancel completes", await cancelSchedule(shop, id), "done");
    is("healthy cancel stops the code", [providerCalls, active], [1, false]);
    await seed();
    is("valid zero counts remain accepted", await withReply([0, 0, 0], () => dropSchedule(shop, id)), "done");
    done();
  } finally { redis.pipeline = realPipeline; globalThis.fetch = originalFetch; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
