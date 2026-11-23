/**
 * #5010 row 154 (LEVE, coordinator a228): a store whose plan ends can no longer sell (canSell needs a paid plan), so
 * the affiliate directory leaves it out (lib/affiliate-directory.ts, directoryRow). But the directory's rows are kept
 * for ten minutes (nl:dir:page), and a plan that ended did not drop them, so for up to 600 seconds the directory still
 * listed a program whose store could not take a card (a buyer who clicked saw the store's "cannot take payments"
 * note, and nothing was charged). The end of a listed store's plan now drops the kept rows, as a consent withdrawn
 * does (lib/directory-index.ts, rememberListing): the next visit builds the list from the stores as they are.
 * A plan that keeps running, or a store that is not listed, drops nothing.
 * Synthetic stores; in-memory Redis; Stripe answers an empty list.
 */
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { readDirectory } from "@/lib/affiliate-directory";
import { DIRECTORY_CACHE } from "@/lib/directory-index";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_directory_plan_end_stand_in";

const OWNER = "plan-end@example.test";
const terms = { enabled: true, percent: 30, days: 30, rule: "last", payday: 15, hold: 30, buyers: true, directory: true, lifetime: true, rates: {} };
const plan = { customerId: "cus_planend01", subscriptionId: "sub_planend01" };

async function listedStore(directory = true): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "planendshop", "Plan End Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPlanEnd01", true);
  await setSubscription(OWNER, { ...plan, active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Field Guide", "", "20", null);
  if (!made.ok) throw new Error("no product");
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...terms, directory }));
}
const kept = () => redis.run(["GET", DIRECTORY_CACHE]);

async function main(): Promise<void> {
  part("Control: a listed store with a paid plan is in the directory, and the rows are kept");
  {
    await listedStore();
    is("the program is listed", (await readDirectory()).length, 1);
    is("the rows are kept for the next visit", typeof kept(), "string");
  }

  part("The plan ends: the kept rows go at once, and the next visit no longer lists the store");
  {
    await listedStore();
    await readDirectory();
    await setSubscription(OWNER, { ...plan, active: false });
    is("the kept rows are dropped when the plan ends", kept(), null);
    is("the next visit lists no program", (await readDirectory()).length, 0);
  }

  part("A plan that keeps running drops nothing");
  {
    await listedStore();
    await readDirectory();
    await setSubscription(OWNER, { ...plan, active: true, period: paidPeriod() });
    is("the kept rows stay", typeof kept(), "string");
  }

  part("A store that is not in the directory drops nothing when its plan ends");
  {
    await listedStore(false);
    redis.run(["SET", DIRECTORY_CACHE, "[]", "EX", 600]);
    await setSubscription(OWNER, { ...plan, active: false });
    is("another store's kept rows stay", kept(), "[]");
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
