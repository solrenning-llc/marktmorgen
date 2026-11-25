/**
 * Issue #4294 (Codex C2, MEDIUM): DELETE /api/v1/codes switched the code off on the creator's Stripe account
 * (stopCode, confirmed by Stripe naming that id with active false) and then read the codes again and wrote the
 * checkout's code box (setHasDiscounts); a throw in either of those last two steps fell to the catch and answered
 * 502 "unavailable", although buyers could no longer use the code.
 *
 * Now a code Stripe confirmed switched off is always answered as switched off: a list that cannot be read back is the
 * existing `listed: false` answer, and a code-box write that fails is said beside the codes as
 * `checkout_box: "not_updated"`, never 502. A synthetic Stripe in memory and the in-memory Redis.
 */
import { DELETE } from "@/app/api/v1/codes/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setHasDiscounts, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "api-codes-stop-box@example.com";
const ACCOUNT = "acct_ApiCodesStopBox1";
process.env.STRIPE_SECRET_KEY = "sk_test_api_codes_stop_box_stand_in";

type Promo = Record<string, unknown>;
const promos = new Map<string, Promo>();
const stopped: string[] = [];
/** After Stripe switched the code off: every store write fails, or the list read back throws. */
let after: "fine" | "store-down" | "list-throws" = "fine";
let storeDown = false;
let listThrows = false;

const promo = (id: string, code: string): Promo => ({
  id, object: "promotion_code", code, active: true, times_redeemed: 0, max_redemptions: null, expires_at: null,
  restrictions: { minimum_amount: null, minimum_amount_currency: null, first_time_transaction: false },
  promotion: { type: "coupon", coupon: { id: `co_${id}`, object: "coupon", percent_off: 20, amount_off: null, currency: null, duration: "once" } },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || new Headers(init?.headers).get("Stripe-Account") !== ACCOUNT) throw new Error(`unexpected ${url}`);
  if ((init?.method ?? "GET") === "GET" && url.pathname === "/v1/promotion_codes") {
    if (listThrows) return new Response("{", { status: 200 });
    return Response.json({ object: "list", has_more: false, data: [...promos.values()] });
  }
  const one = url.pathname.match(/^\/v1\/promotion_codes\/(promo_\w+)$/);
  if ((init?.method ?? "GET") === "GET" && one) {
    const row = promos.get(one[1]);
    return row ? Response.json(row) : Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such promotion code" } }, { status: 404 });
  }
  if (init?.method === "POST" && one) {
    const row = promos.get(one[1]);
    if (!row) return Response.json({ error: { message: "No such promotion code" } }, { status: 404 });
    row.active = false;
    stopped.push(one[1]);
    if (after === "store-down") storeDown = true;
    if (after === "list-throws") listThrows = true;
    return Response.json(row);
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
  await claimHandle(OWNER, "api-codes-stop-box", "API Codes Stop Box", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ApiCodesStopBox1", subscriptionId: "sub_ApiCodesStopBox1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setHasDiscounts(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const writer = await makeKey(store.sid, "Synthetic writer", Date.now(), true);
  if (!writer.ok) throw new Error("no synthetic key");
  const stop = async (id: string) => {
    const r = await DELETE(new Request(`https://marktmorgen.com/api/v1/codes?id=${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${writer.key}` } }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  part("Stripe switched the code off, and the checkout's code box could not be written");
  promos.set("promo_A1", promo("promo_A1", "LAUNCH20"));
  after = "store-down";
  const boxDown = await stop("promo_A1");
  storeDown = false;
  after = "fine";
  is("Stripe switched it off (set-up)", stopped, ["promo_A1"]);
  is("answered as switched off, never 502", boxDown.status, 200);
  is("with the codes as Stripe says now", (boxDown.body.data as { id: string; active: boolean }[] | undefined)?.find((c) => c.id === "promo_A1")?.active, false);
  is("and says the code box was not updated", boxDown.body.checkout_box, "not_updated");

  part("Stripe switched the code off, and the codes could not be read back");
  promos.set("promo_B2", promo("promo_B2", "TENOFF"));
  after = "list-throws";
  const listDown = await stop("promo_B2");
  listThrows = false;
  after = "fine";
  is("answered as switched off, never 502", [listDown.status, listDown.body.stopped, listDown.body.listed], [200, "promo_B2", false]);

  part("Control: a normal switch-off says nothing more");
  promos.set("promo_C3", promo("promo_C3", "FALL10"));
  const fine = await stop("promo_C3");
  is("200 with the codes and no checkout_box", [fine.status, "checkout_box" in fine.body], [200, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
