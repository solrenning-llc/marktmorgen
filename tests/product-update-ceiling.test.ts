/**
 * Telling a product's buyers it was updated reads every paid sale the store
 * has (lib/product-updates.ts, startUpdate), and a press that finds nobody
 * claims nothing, so it can be pressed again. C4-4 (4 November 2026; owner's
 * rule MR and decision C4-18): each reading is one of the store's own readings
 * of the day (lib/store-readings.ts), taken before it starts, none read past
 * them; the studio's requests are never taken for it (only the press, by its
 * route, as before).
 *
 * Kept apart from tests/product-updates.test.ts, with its own fixtures.
 */
import { startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { takeAllowance } from "@/lib/store-allowance";
import { UPDATE_SEARCHES_PER_DAY } from "@/lib/store-readings";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
let stripeReads = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1", data: [] }));
  stripeReads += 1;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";

  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Jenny at Harbor", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(OWNER, "Pantry Checklist", "", "5", null);
  if (!made.ok) throw new Error("no product");
  const load = async () => (await storeForEmail(OWNER))!;
  const nobody = (await readListing(await load(), made.product.id))!;

  part("Every search of the sales is paid for before it starts, from a count of its own, never the studio's readings (inbox C4-33 (4))");
  const left = async () => {
    const taken = await takeAllowance(await load(), "studio", 1);
    return taken.ok ? taken.left : -1;
  };
  const today = new Date().toISOString().slice(0, 10);
  const dayKey = `nl:reading:update:${(await load()).statsId}:${today}`;
  const studioKey = `nl:reading:day:${(await load()).statsId}:${today}`;
  const start = await left();
  const readsBefore = stripeReads;
  is("a search that finds nobody takes one of the day's searches, none of the studio's readings, and no studio request", [await startUpdate(await load(), nobody, "").then((r) => (r.ok ? "started" : r.reason)), Number(redis.run(["GET", dayKey])), redis.run(["GET", studioKey]), start - (await left())], ["none", 1, null, 1]);
  is("and reads Stripe", stripeReads > readsBefore, true);
  // The day's searches used.
  redis.run(["SET", dayKey, String(UPDATE_SEARCHES_PER_DAY), "EX", 86_400]);
  const readsSpent = stripeReads;
  const studioSpent = await left();
  const refused = await startUpdate(await load(), nobody, "");
  is("past the day's searches it is refused, in the store's words, with when they come back", [refused.ok ? "started" : refused.reason, !refused.ok && refused.reason === "used" && refused.message.includes("today") && refused.message.includes("00:00 UTC")], ["used", true]);
  is("the box says that time on the creator's own clock too", readFileSync("components/product-update-box.tsx", "utf8").includes('data.message.replace("00:00 UTC", utcAndLocal(nextUtcMidnight(Date.now()), browserZone()))'), true);
  is("and reads nothing, and takes no studio request", [stripeReads - readsSpent, studioSpent - (await left())], [0, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
