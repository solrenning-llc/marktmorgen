/**
 * #5101, Claude 4 3Kc's LEVE (7077590451), fixed under the owner's zero-findings order (relayed by Claude 5 ib47 and
 * Claude 6 UoHAG, mail c944): kitCounts built the store's live fence by hand (the live key, the erasing field, the
 * statsId and the ref) instead of taking it from storeLiveFence (lib/store-live-cache.ts). The two gave the same today,
 * but a change to the shared fence (a store-cache-live:v4) would have left this copy on the old rule.
 *
 * Checked here:
 *   - lib/affiliate-kit.ts takes the fence from storeLiveFence and builds none of its parts itself;
 *   - the KIT_COUNTS run draftKit makes carries exactly storeLiveFence's live key, erasing key, field, statsId and ref.
 * Synthetic store; in-memory Redis; the model stood in; no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { storeLiveFence } from "@/lib/store-live-cache";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { KIT_COUNTS, draftKit } from "@/lib/affiliate-kit";
import type { Affiliate } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.anthropic.com") {
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ x: "Dinners, planned.", instagram: "Busy weeknights?", linkedin: "Planning dinners is work." }) }] }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
}) as typeof fetch;

/** Every KIT_COUNTS run seen, as sent. */
const runs: (string | number)[][] = [];
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  for (const command of batch) if (command[0] === "EVAL" && command[1] === KIT_COUNTS) runs.push(command);
  return real(batch);
}) as typeof redis.pipeline;

const OWNER = "kitsource@example.com";
const affiliate: Affiliate = { id: "kkkkkkkkkkkk", email: "fan@example.com", code: "fanlink", status: "approved", appliedAt: 1, decidedAt: 1, note: "", rate: null, paypal: "", share: null, cleared: null, by: null };

async function main(): Promise<void> {
  part("lib/affiliate-kit.ts takes the store's fence from storeLiveFence");
  const source = readFileSync(join(process.cwd(), "lib/affiliate-kit.ts"), "utf8");
  is("it calls storeLiveFence", source.includes("storeLiveFence(store)"), true);
  is("and builds no part of the fence itself (no ownerKey, storeIdCommand or erasingField of its own)", ["ownerKey(", "storeIdCommand(", "erasingField("].filter((name) => source.includes(name)), []);

  part("The KIT_COUNTS run carries exactly the shared fence");
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_kit_source_only_a_stand_in";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-kit-source-only-a-stand-in-0000";
  await claimHandle(OWNER, "kitsource", "Kit Source", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestKitSource1", true);
  await setSubscription(OWNER, { customerId: "cus_KitSource01", subscriptionId: "sub_KitSource01", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Weeknight Plan", "Thirty dinners in thirty minutes.", "29", null);
  if (!made.ok) throw new Error("no product");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ enabled: true, percent: 30, days: 30 }));
  const store = (await storeForEmail(OWNER))!;
  const result = await draftKit(store, affiliate, made.product.id, "");
  is("drafted (control)", result.ok, true);
  const take = runs[0];
  const fence = await storeLiveFence(store);
  // EVAL, script, 5, live, erasing, 3 counters, field, op, day seconds, window seconds, statsId, ref.
  is("the live key and the erasing key are the fence's", [take?.[3], take?.[4]], [fence.live, fence.erasing]);
  is("the erasing field, the statsId and the ref are the fence's", [take?.[8], take?.[12], take?.[13]], [fence.field, fence.statsId, fence.ref]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
