/**
 * Issue #4733 (MEDIUM, money; Codex X8, transcribed by Claude 2), RED before the fix: the checkout sweep let go of its
 * saved place in a store's checkouts on any failure of its first page (lib/checkout-sweep.ts walkDay), a 500, a 429 or
 * a timeout included, so the next run started from the newest checkouts again and, in a store with several pages, an
 * older paid order could leave the confirmation window unread. Now the place is let go only when Stripe answers 400 or
 * 404 naming the very session the walk started after as missing; any other failure keeps it. Control: that exact
 * answer still lets it go, so a run is never stuck on a session Stripe no longer lists. Synthetic only.
 */
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

let failWith: { status: number; body: unknown } | null = null;
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") {
      if (failWith && url.searchParams.get("starting_after")) return new Response(JSON.stringify(failWith.body), { status: failWith.status });
      return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
    }
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_conditions_only_a_stand_in";
  const OWNER = "m4-walk@example.com";
  await claimHandle(OWNER, "mfourwalk", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMfourWalk", true);
  await setSubscription(OWNER, { customerId: "cus_MfourWalk1", subscriptionId: "sub_MfourWalk1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const course = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!course.ok) throw new Error("no product");
  await setProductLink(OWNER, course.product.id, "https://example.com/course");
  const store = (await storeForEmail(OWNER))!;

  part("A temporary Stripe failure keeps the sweep's place in a store's checkouts");
  const place = `${Math.floor(Date.now() / 1000) - 300}|cs_test_mfourplace0000001`;
  for (const [label, failure] of [
    ["500", { status: 500, body: { error: { type: "api_error", message: "synthetic outage" } } }],
    ["429", { status: 429, body: { error: { type: "rate_limit_error", message: "synthetic limit" } } }],
    ["another session missing", { status: 404, body: { error: { type: "invalid_request_error", message: "No such checkout.session: 'cs_test_someotherone0001'" } } }],
    ["a timeout-like failure (503)", { status: 503, body: { error: { type: "api_error", message: "synthetic timeout" } } }],
  ] as const) {
    const key = `nl:sweep:walk:complete:${store.stripeAccountId}:${store.sid || store.handle}`;
    await redis.pipeline([["SET", key, place]]);
    failWith = failure;
    const log = console.error;
    console.error = () => {};
    try { await sweepCheckouts(Date.now() + 20_000); } finally { console.error = log; }
    is(`${label}: the saved place is kept`, await redis.pipeline([["GET", key]]), [place]);
  }

  part("Control: Stripe naming the very session as missing lets the place go");
  for (const status of [400, 404]) {
    const key = `nl:sweep:walk:complete:${store.stripeAccountId}:${store.sid || store.handle}`;
    await redis.pipeline([["SET", key, place]]);
    failWith = { status, body: { error: { type: "invalid_request_error", message: "No such checkout.session: 'cs_test_mfourplace0000001'" } } };
    const log = console.error;
    console.error = () => {};
    try { await sweepCheckouts(Date.now() + 20_000); } finally { console.error = log; }
    is(`${status} naming it: the place is let go, so the next run starts from the newest`, await redis.pipeline([["GET", key]]), [null]);
  }
  failWith = null;
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
