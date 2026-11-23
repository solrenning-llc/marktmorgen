/**
 * Issue #4076 (Codex C2, MEDIUM): POST /api/v1/codes made the code on the creator's Stripe account and then switched
 * the checkout's code box on (setHasDiscounts) in a second, separate write; when that write failed (a store write that
 * did not go through), the route answered 502 "the code could not be made", although Stripe had made it, and a retry
 * of the same request then answered 409 taken.
 *
 * Now a code Stripe confirmed is always answered as made, with the code itself; when the code box could not be
 * switched on, the answer says so (`checkout_box: "not_switched_on"`), never that nothing was made. A synthetic
 * Stripe in memory and the in-memory Redis; nothing leaves this machine.
 */
import { POST } from "@/app/api/v1/codes/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "api-codes-box@example.com";
const ACCOUNT = "acct_ApiCodesBox01";
process.env.STRIPE_SECRET_KEY = "sk_test_api_codes_box_stand_in";

const made: string[] = [];
/** Set once Stripe has made the code: every store write after it fails, as a store write that does not go through. */
let storeDown = false;
let failNextStoreWrites = false;
let n = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || new Headers(init?.headers).get("Stripe-Account") !== ACCOUNT) throw new Error(`unexpected ${url}`);
  const form = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");
  if (init?.method === "POST" && url.pathname === "/v1/coupons") {
    return Response.json({ id: `co_${++n}`, object: "coupon", percent_off: Number(form.get("percent_off")), amount_off: null, currency: null, duration: form.get("duration") ?? "once" });
  }
  if (init?.method === "POST" && url.pathname === "/v1/promotion_codes") {
    const code = form.get("code") ?? "";
    made.push(code);
    if (failNextStoreWrites) storeDown = true;
    return Response.json({
      id: `promo_${++n}`, object: "promotion_code", code, active: true, times_redeemed: 0, max_redemptions: null, expires_at: null,
      restrictions: { minimum_amount: null, minimum_amount_currency: null, first_time_transaction: false },
      promotion: { type: "coupon", coupon: { id: form.get("promotion[coupon]"), object: "coupon", percent_off: 20, amount_off: null, currency: null, duration: "once" } },
    });
  }
  throw new Error(`unexpected ${init?.method} ${url}`);
}) as typeof fetch;

const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  if (storeDown) throw new Error("synthetic: the store could not be reached");
  return pipeline(batch);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "api-codes-box", "API Codes Box", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ApiCodesBox1", subscriptionId: "sub_ApiCodesBox1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const store = (await storeForEmail(OWNER))!;
  const writer = await makeKey(store.sid, "Synthetic writer", Date.now(), true);
  if (!writer.ok) throw new Error("no synthetic key");
  const make = async (body: unknown) => {
    const r = await POST(new Request("https://marktmorgen.com/api/v1/codes", { method: "POST", headers: { Authorization: `Bearer ${writer.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  part("Stripe made the code, and the checkout's code box could not be switched on");
  failNextStoreWrites = true;
  const answer = await make({ code: "LAUNCH20", percent: 20 });
  storeDown = false;
  failNextStoreWrites = false;
  is("Stripe made it (set-up)", made, ["LAUNCH20"]);
  is("answered as made, never 'could not be made'", answer.status, 200);
  is("with the code itself", (answer.body.data as { code?: string } | undefined)?.code, "LAUNCH20");
  is("and says the code box was not switched on", answer.body.checkout_box, "not_switched_on");

  part("Control: when the code box is switched on, the answer says nothing more");
  const ok = await make({ code: "TENOFF", percent: 20 });
  is("made", [ok.status, (ok.body.data as { code?: string } | undefined)?.code], [200, "TENOFF"]);
  is("no checkout_box field", "checkout_box" in ok.body, false);
  is("and the code box is on", (await storeForEmail(OWNER))!.hasDiscounts, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
