/**
 * Hunt B (checkout discounts): a scheduled code (511 [CK3]) switched off
 * through the API (DELETE /api/v1/codes) must stay off. The studio's "stop"
 * drops the schedule first (app/api/store/discount/route.ts, dropSchedule),
 * "so the job never switches it back on"; the API's DELETE does not, so the
 * five-minute job switches the code the creator stopped back on at its start.
 * Synthetic Stripe in memory, the in-memory Redis stand-in, a synthetic clock.
 */
import { DELETE } from "@/app/api/v1/codes/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { activateScheduledCodes, scheduleCode } from "@/lib/discount-schedule";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "hunt-b-sched@example.com";
const ACCOUNT = "acct_HuntBSched01";
process.env.STRIPE_SECRET_KEY = "sk_test_hunt_b_sched_stand_in";

type Promo = Record<string, unknown>;
const promos = new Map<string, Promo>();
const switchedOn: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error(`unexpected ${url}`);
  const form = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");
  if (init?.method === "GET" && url.pathname === "/v1/promotion_codes") {
    return Response.json({ object: "list", has_more: false, data: [...promos.values()].map((p) => ({ ...p, promotion: { type: "coupon", coupon: { id: "co_1", percent_off: 100, duration: "once" } } })) });
  }
  if (init?.method === "POST" && url.pathname === "/v1/coupons") return Response.json({ id: "co_1", object: "coupon", percent_off: 100, duration: "once" });
  if (init?.method === "POST" && url.pathname === "/v1/promotion_codes") {
    const row: Promo = { id: "promo_HuntBSched1", object: "promotion_code", code: form.get("code"), active: form.get("active") !== "false", times_redeemed: 0, max_redemptions: null, expires_at: Number(form.get("expires_at")) || null, restrictions: {}, promotion: { type: "coupon", coupon: "co_1" } };
    promos.set(String(row.id), row);
    return Response.json(row);
  }
  const one = url.pathname.match(/^\/v1\/promotion_codes\/(promo_\w+)$/);
  if (init?.method === "POST" && one) {
    const row = promos.get(one[1]);
    if (!row) return Response.json({ error: { message: "No such promotion code" } }, { status: 404 });
    row.active = form.get("active") === "true";
    if (row.active) switchedOn.push(one[1]);
    return Response.json(row);
  }
  throw new Error(`unexpected ${init?.method} ${url}`);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "hunt-b-sched", "Hunt B Sched", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_HuntBSched1", subscriptionId: "sub_HuntBSched1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const store = (await storeForEmail(OWNER))!;
  const writer = await makeKey(store.sid, "Synthetic writer", Date.now(), true);
  if (!writer.ok) throw new Error("no synthetic key");

  part("A 100% code scheduled ahead, then switched off through the API before its start");
  const now = Math.floor(Date.now() / 1000);
  const start = now + 3600;
  const end = start + 86_400;
  const made = await scheduleCode(store, { code: "FREEWEEK", off: { kind: "percent", percent: 100 }, maxRedemptions: null, minimum: null }, { start, end }, now);
  is("scheduled, switched off on Stripe", made.ok && made.code.active, false);

  const r = await DELETE(new Request("https://marktmorgen.com/api/v1/codes?id=promo_HuntBSched1", { method: "DELETE", headers: { Authorization: `Bearer ${writer.key}` } }));
  is("the API says it is switched off", r.status, 200);

  part("At its start, the five-minute job must not switch back on a code the creator stopped");
  const deps = { findStore: async () => store, markDiscounts: async () => ({ hasDiscounts: true }) };
  await activateScheduledCodes(Date.now() + 10_000, start, deps);
  is("Stripe was never asked to switch the stopped code on", switchedOn, []);
  is("the code stays off on Stripe", promos.get("promo_HuntBSched1")?.active, false);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
