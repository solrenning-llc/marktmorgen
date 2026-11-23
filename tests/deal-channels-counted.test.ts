/**
 * The deals page's "by where people came from" table counts its reading of the buyers (board #5285, row #2270:
 * Claude 5's MÉDIO 2, outside that PR). DealChannelsLoader read the buyers' ledger without the studio-request count
 * every other caller passes (lib/segments.ts buyerLedger's `count`), so a reading from the creator's Stripe account
 * (BUYER_LEDGER_UNITS) was neither counted nor refused when the store's studio requests were spent. Now it counts
 * first, through countLedger as the people page does: with too few left, Stripe is not read and the table says how
 * many it needs; with enough, the reading is counted.
 *
 * Synthetic only: the Redis stand-in and a Stripe stand-in that counts its calls.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { DealChannelsLoader } from "@/components/deal-channels-table";
import { BUYER_LEDGER_UNITS } from "@/lib/segments";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { redisPipeline } from "@/lib/redis";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "deal-channels-counted@example.com";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") stripeCalls += 1;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const studioKey = () => redis.keys().find((key) => key.startsWith("nl:allow:studio:"));

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_ledger_only_a_stand_in";
  await claimHandle(OWNER, "dealcounted", "Deal Counted", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDealCount01", true);
  await setSubscription(OWNER, { customerId: "cus_dealcount", subscriptionId: "sub_dealcount", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Deal Guide", "", "27", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const { countStudio } = await import("@/lib/studio-route");
  await countStudio(store, null, 1);
  const used = async () => Number((await redisPipeline([["GET", studioKey()!]]))[0]);
  const draw = async () => renderToStaticMarkup(await DealChannelsLoader({ store, deals: [], stages: [] }));

  part("With fewer studio requests left than reading Stripe needs");
  await redisPipeline([["SET", studioKey()!, String(allowanceFor(store, "studio") - 3)]]);
  stripeCalls = 0;
  const refused = await draw();
  is("Stripe is not read", stripeCalls, 0);
  is("and the table says how many this needs and how many are left", refused.includes(`This needs ${BUYER_LEDGER_UNITS} of your studio requests, and only 3 are left.`), true);
  is("nothing more was counted", await used(), allowanceFor(store, "studio") - 3);

  part("With enough left");
  await redisPipeline([["SET", studioKey()!, "1"]]);
  stripeCalls = 0;
  await draw();
  is("control: Stripe is read", stripeCalls > 0, true);
  is("and the reading is counted as studio requests", await used(), 1 + BUYER_LEDGER_UNITS);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
