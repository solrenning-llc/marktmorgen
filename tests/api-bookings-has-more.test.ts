/**
 * Issue #4049 (Codex C2): GET /api/v1/bookings reads at most MAX_PAGES pages of the creator's completed Stripe
 * checkouts (lib/calls.ts, readCallSessions), which says `partial` when the last page read still had more behind it.
 * The API read through paidCalls, which drops that, and answered 200 with the bookings it reached as the whole list:
 * an integration synchronising bookings could miss paid ones without any sign. Now the answer says `has_more`, as
 * GET /api/v1/codes does for its newest page: true when Stripe holds older checkouts this read did not reach.
 *
 * Synthetic store, key and Stripe answers only.
 */
import { GET as bookingsRead } from "@/app/api/v1/bookings/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_api_bookings_has_more_only";

// Every page of completed checkouts holds one row that is no booking (no call in its metadata), and says whether
// Stripe has more behind it.
let alwaysMore = true;
let pages = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname.endsWith("/checkout/sessions")) {
    pages += 1;
    const row = { id: `cs_test_HasMore${pages}`, object: "checkout.session", status: "complete", payment_status: "paid", metadata: {} };
    return new Response(JSON.stringify({ object: "list", data: [row], has_more: alwaysMore }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "api-bookings-more@example.com";
  await claimHandle(owner, "bookingsmore", "Bookings More", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_BookingsMore01", subscriptionId: "sub_BookingsMore01", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, "acct_1BookingsMore01", true);
  const made = await makeKey((await storeForEmail(owner))!.sid, "Synthetic reader");
  if (!made.ok) throw new Error("no synthetic key");
  const get = (path: string) => bookingsRead(new Request(`https://marktmorgen.com${path}`, { headers: { Authorization: `Bearer ${made.key}` } }));

  part("Stripe still has more after the last page read: the answer says so");
  const cut = await get("/api/v1/bookings");
  const cutBody = (await cut.json()) as { data?: unknown[]; has_more?: unknown };
  is("200, with the bookings it reached", [cut.status, Array.isArray(cutBody.data)], [200, true]);
  is("has_more is true, never a complete-looking list", cutBody.has_more, true);
  is("it stopped at its page bound", pages > 1, true);

  part("Kept with ?fields=, which shapes the rows, not the answer");
  pages = 0;
  const shaped = (await (await get("/api/v1/bookings?fields=id")).json()) as { has_more?: unknown };
  is("has_more still true", shaped.has_more, true);

  part("Control: Stripe's list ends inside the bound: has_more is false");
  alwaysMore = false;
  pages = 0;
  const whole = (await (await get("/api/v1/bookings")).json()) as { data?: unknown[]; has_more?: unknown };
  is("has_more is false, one page read", [whole.has_more, pages], [false, 1]);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
