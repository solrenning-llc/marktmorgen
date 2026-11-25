/**
 * Codex P-20261120-1412 (MEDIUM, erasure, retention and cost; #5010 row 29). draftKit (lib/affiliate-kit.ts) counted
 * an affiliate kit with plain INCRs and gave it back with plain DECRs, on a Store read before. When the store's
 * erasure began, or its account moved, before the take, the three counters (the affiliate's day, carrying the
 * affiliate's id, the program's window and the store's writing jobs) came back as 1 and the model was asked; when the
 * counters went with the erasure while the page was read, the give-back made them again as -1, with no expiry. Both now
 * run in KIT_COUNTS, fenced on the store being live, and a give-back never makes a counter. Synthetic store and model.
 */
import { ERASING_KEY, addProduct, claimHandle, ensureStatsId, ensureStoreId, erasingField, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { KIT_COUNTS, draftKit } from "@/lib/affiliate-kit";
import { KIT_COMMANDS_MOST } from "@/lib/affiliate-kit-rules";
import type { Affiliate } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    modelCalls += 1;
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ x: "Dinners, planned.", instagram: "Busy weeknights?", linkedin: "Planning dinners is work." }) }] }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
}) as typeof fetch;

const OWNER = "kitfence@example.com";
const affiliate: Affiliate = { id: "kkkkkkkkkkkk", email: "fan@example.com", code: "fanlink", status: "approved", appliedAt: 1, decidedAt: 1, note: "", rate: null, paypal: "", share: null, cleared: null, by: null };
/** The kit's counters now kept: the affiliate's day, the program's window and the store's writing jobs. */
const counters = (statsId: string) => redis.keys().filter((key) => key.startsWith(`nl:affkit:${statsId}:`) || key.startsWith(`nl:ai:${statsId}:`));

async function shop() {
  redis.clear();
  modelCalls = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_kit_only_a_stand_in";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-kit-only-a-stand-in-0000";
  await claimHandle(OWNER, "kitfence", "Kit Fence", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestKitFence01", true);
  await setSubscription(OWNER, { customerId: "cus_KitFence01", subscriptionId: "sub_KitFence01", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Weeknight Plan", "Thirty dinners in thirty minutes.", "29", null);
  if (!made.ok) throw new Error("no product");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ enabled: true, percent: 30, days: 30 }));
  return { store: (await storeForEmail(OWNER))!, productId: made.product.id };
}

async function main(): Promise<void> {
  part("A live store's kit is counted and drafted, as before (control)");
  {
    const { store, productId } = await shop();
    const result = await draftKit(store, affiliate, productId, "");
    is("drafted, one model call", [result.ok, modelCalls], [true, 1]);
    const kept = counters(store.statsId!);
    is("its three counters, each at 1 and ending", [kept.length, kept.every((key) => redis.run(["GET", key]) === "1" && Number(redis.run(["TTL", key])) > 0)], [3, true]);
  }

  part("The store's erasure began before the kit is counted");
  {
    const { store, productId } = await shop();
    await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), "1"]]);
    const result = await draftKit(store, affiliate, productId, "");
    is("refused, and the model is never asked", [result.ok, modelCalls], [false, 0]);
    is("no counter (one carries the affiliate's id) is written", counters(store.statsId!), []);
  }

  part("The store's account moved before the kit is counted");
  {
    const { store, productId } = await shop();
    await redis.pipeline([["SET", storeIdCommand(store.sid)[1], "another-ref"]]);
    const result = await draftKit(store, affiliate, productId, "");
    is("refused, no model call", [result.ok, modelCalls], [false, 0]);
    is("and no counter written", counters(store.statsId!), []);
  }

  part("The counters went with the erasure while the page was read: the give-back makes none");
  {
    const { store, productId } = await shop();
    const real = redis.pipeline.bind(redis);
    // The page's read fails (unknown), so draftKit gives the kit back; before that, the erasure takes the counters.
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:product:page:"))) {
        await real([["DEL", ...counters(store.statsId!)]]);
        throw new Error("redis: connection reset");
      }
      return real(commands);
    }) as typeof redis.pipeline;
    const result = await draftKit(store, affiliate, productId, "");
    redis.pipeline = real;
    is("refused as unavailable", result.ok ? "drafted" : result.reason, "unavailable");
    is("no counter made again as -1", counters(store.statsId!), []);
  }

  part("MEDIUM (Claude 1 2as on #5101): KIT_COMMANDS_MOST covers the fence on both the take and the give-back");
  {
    // Counted from KIT_COUNTS itself: each path is the EVAL, the fence's calls (HGET, then one GET either way) and its
    // own calls; the kit's worst is a take, a give-back and the three content reads.
    const [fence, rest] = KIT_COUNTS.split('if ARGV[2] == "take" then');
    const [take, back] = rest.split("return {1, day, window, jobs}");
    const calls = (lua: string) => (lua.match(/redis\.call\(/g) ?? []).length;
    const fenceCalls = calls(fence) - 1; // the record's GET and the id key's GET are the two arms of one branch
    const worst = (1 + fenceCalls + calls(take)) + (1 + fenceCalls + calls(back)) + 3;
    is("the fence is HGET and one GET", fenceCalls, 2);
    is("the kit's worst, counted from the script, is within KIT_COMMANDS_MOST", KIT_COMMANDS_MOST >= worst, true);
    is("and is 19", worst, 19);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
