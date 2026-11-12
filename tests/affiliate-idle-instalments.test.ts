/**
 * The idle-affiliate sweep (lib/affiliates.ts idleSweep) never removes an affiliate who is still owed commission on
 * a payment plan's instalments (Claude 1, C1-20261112-1000-C7-141, item 2d).
 *
 * Instalments are read from the paid invoices on the creator's Stripe account, never written down as sales in
 * Redis, so an affiliate who brought only a payment plan looked idle and owed nothing to the sweep, and was removed;
 * removal takes them out of every later payment batch, so the commission was never paid. A program stops crediting
 * new memberships when the creator turns `recurring` off, but a plan sold before keeps paying its instalments, and
 * every one of them earns (recurringReferrals). Checked with the real sweep over the Redis stub, Stripe and the email
 * provider answered by a synthetic fetch:
 *
 *   - warned already and past the date, but an instalment's commission not yet paid: not removed;
 *   - the invoices unreadable: "still owed" is not known, so nobody is removed;
 *   - once the creator wrote the commission down as paid: removed, as before.
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { idleSweep, readAffiliate } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_idle_instalments_only";
process.env.RESEND_API_KEY = "re_test_affiliate_idle_instalments_only";

const OWNER = "planner@example.com";
const DAY = 86_400;
const T0 = Math.floor(Date.now() / 1000) - 600 * DAY;
const ms = (days: number) => (T0 + days * DAY) * 1000;
const PLANNER = "a1b2c3d4e5f6";

let invoicesDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.pathname === "/v1/invoices") {
    if (invoicesDown) return answer({ error: { message: "down" } }, 500);
    // One instalment of a plan sold through the affiliate's link: $100 paid, 30% of it theirs.
    return answer({
      object: "list",
      has_more: false,
      data: [
        {
          id: "in_PlanInstal0001",
          status: "paid",
          amount_paid: 10_000,
          currency: "usd",
          customer_email: "student@example.com",
          created: T0 + 200 * DAY,
          status_transitions: { paid_at: T0 + 200 * DAY },
          total_taxes: [],
          parent: { subscription_details: { metadata: { store: "planhouse", product: "prod01", via: PLANNER, via_rate: "30", kind: "plan" } } },
          payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_PlanInstal0001" } }] },
        },
      ],
    });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "planhouse", "Plan House", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestIdlePlan01", true);
  // The plan was sold while memberships and plans were credited; the creator has since turned that off.
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, recurring: 0, idle: 90, idleOn: T0 + 300 * DAY }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, PLANNER, JSON.stringify({ id: PLANNER, email: "planner.aff@example.com", code: "plan1", status: "approved", appliedAt: ms(0), decidedAt: ms(0), note: "", warned: T0 + 400 * DAY })],
  ]);
  const status = async () => (await readAffiliate(store, PLANNER))?.status;

  part("Warned, past the date, but owed on an instalment: not removed");
  is("nobody removed", await idleSweep(store, ms(414)), { warned: 0, removed: 0 });
  is("still approved", await status(), "approved");

  part("The invoices unreadable: not known, so nobody is removed");
  invoicesDown = true;
  is("nothing done", await idleSweep(store, ms(420)), { warned: 0, removed: 0 });
  is("still approved", await status(), "approved");
  invoicesDown = false;

  part("Paid in full: the rule applies again");
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:payouts`, "po_plan01", JSON.stringify({ id: "po_plan01", aff: PLANNER, cents: 3_000, currency: "usd", date: "2026-10-01", reference: "cash", at: 1 })],
  ]);
  is("removed", await idleSweep(store, ms(430)), { warned: 0, removed: 1 });
  is("their record stays, removed", await status(), "removed");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
