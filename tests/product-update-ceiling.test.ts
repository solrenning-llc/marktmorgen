/**
 * Telling a product's buyers it was updated reads every paid sale the store
 * has (lib/product-updates.ts, startUpdate), and a press that finds nobody
 * claims nothing, so it can be pressed again. C4-4 (4 November 2026; owner's
 * rule MR): each reading takes UPDATE_READ_UNITS of the store's studio
 * requests before it starts, and none is read past them.
 *
 * Kept apart from tests/product-updates.test.ts, with its own fixtures.
 */
import { startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { takeAllowance } from "@/lib/store-allowance";
import { UPDATE_READ_UNITS } from "@/lib/read-ceilings";
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

  part("Every reading of the sales is paid for before it starts");
  const left = async () => {
    const taken = await takeAllowance(await load(), "studio", 1);
    return taken.ok ? taken.left : -1;
  };
  const start = await left();
  const readsBefore = stripeReads;
  is("a reading that finds nobody takes its units", [await startUpdate(await load(), nobody, "").then((r) => (r.ok ? "started" : r.reason)), start - (await left())], ["none", UPDATE_READ_UNITS + 1]);
  is("and reads Stripe", stripeReads > readsBefore, true);
  // Spend what is left of the window.
  const rest = await left();
  if (rest > 0) await takeAllowance(await load(), "studio", rest);
  const readsSpent = stripeReads;
  const refused = await startUpdate(await load(), nobody, "");
  is("past the window it is refused, with the window's own words", [refused.ok ? "started" : refused.reason, !refused.ok && refused.reason === "used" && refused.message.length > 10], ["used", true]);
  is("and reads nothing", stripeReads - readsSpent, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
