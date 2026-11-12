/**
 * A paid product is not removed while a membership or a payment plan sold for it still runs on the creator's Stripe
 * account (app/api/store/product/route.ts, action "remove"). Stripe goes on charging those whatever the store says:
 * before this, the removal answered ok, deleted the product's files and course, and the member kept paying every
 * month for something no longer there. Not known (Stripe did not answer) is "some", never "none", as for a currency
 * change. A product with nothing running for it is removed as before. Synthetic: Stripe is a stand-in.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_product_remove_running_only";
let running: Record<string, unknown>[] = [];
let stripeDown = false;
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions") {
    asked.push(url.searchParams.get("status") ?? "");
    if (stripeDown) return new Response("{}", { status: 500 });
    const status = url.searchParams.get("status");
    return Response.json({ object: "list", data: running.filter((row) => row.status === status), has_more: false });
  }
  throw new Error(`No external provider in this test: ${url.hostname}${url.pathname}`);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "remove-running@example.com";
  await claimHandle(owner, "removerunning", "Remove Running", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_RemoveRunning01", true);
  await setSubscription(owner, { customerId: "cus_RemoveRunning01", subscriptionId: "sub_RemoveRunningPlan1", active: true, tier: "pro", period: paidPeriod() });
  const club = await addProduct(owner, "Monthly Club", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  const other = await addProduct(owner, "Another Club", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok || !other.ok) throw new Error("product fixtures failed");
  const session = await openSession(owner);
  const remove = async (id: string) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/product", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ action: "remove", id }),
    }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; running?: number } };
  };
  const present = async (id: string) => (await readListing((await storeForEmail(owner))!, id)) !== null;
  const member = (product: string, status: string) => ({ id: `sub_Member${product.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}${status.slice(0, 3)}`, object: "subscription", status, metadata: { store: "removerunning", product } });

  part("A member still charged for it keeps the product");
  running = [member(club.product.id, "active")];
  const refused = await remove(club.product.id);
  is("the removal is refused, saying members are still charged", [refused.status, refused.body.error, refused.body.running], [409, "memberships", 1]);
  is("and the product is still there", await present(club.product.id), true);
  running = [member(club.product.id, "past_due")];
  is("a member whose payment is late still counts", (await remove(club.product.id)).body.error, "memberships");

  part("Stripe not answering is not \"nobody\"");
  stripeDown = true;
  const unknown = await remove(club.product.id);
  is("the removal is refused as not known, and nothing is removed", [unknown.status, unknown.body.error, await present(club.product.id)], [502, "stripe", true]);
  stripeDown = false;

  part("Nothing running for it: removed as before");
  running = [member(club.product.id, "active")];
  const otherGone = await remove(other.product.id);
  is("another product's member does not hold this one", [otherGone.status, otherGone.body.ok, await present(other.product.id)], [200, true, false]);
  running = [];
  const gone = await remove(club.product.id);
  is("with no member left, the product is removed", [gone.status, gone.body.ok, await present(club.product.id)], [200, true, false]);
  is("Stripe was asked by every status that charges", ["active", "trialing", "past_due"].every((status) => asked.includes(status)), true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
