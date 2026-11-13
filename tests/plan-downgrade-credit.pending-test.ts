/**
 * PENDING THE OWNER'S DECISION (audit of main @84856636, ALTO, latent while sales are closed). Not run by
 * `npm test`: the runner takes only `*.test.ts`. Run it by hand to see the gap; rename it to
 * `plan-downgrade-credit.test.ts` with the fix the owner chooses.
 *
 * MR rule 1: no paying customer, using 100% of every right of the plan in the worst month, may give a loss. A plan
 * switch mid-period (lib/billing.ts switchPlan) sends `proration_behavior: "always_invoice"` for every change, a
 * downgrade included, and the studio promises the creator that "what is left of what you paid for … is kept as
 * credit" (app/studio/page.tsx). So a creator can:
 *
 *   1. pay Scale monthly ($999) on day 1;
 *   2. use every Scale allowance in full on days 1 and 2 (they are all counted in the open window);
 *   3. switch to Store monthly on day 2.
 *
 * Stripe then credits the unused 29/30 of Scale against 29/30 of Store: about $899 back on the customer balance,
 * which pays the next ~13 months of Store. The Scale month kept about $100 of its $999, against its receiving costs,
 * reserves and full usage (docs/margin-alignment-2026-10-18.md: $123.76 + $48.61). The unit loses money before tax.
 *
 * The check below is the rule, not a fix: the Scale month, used in full and then switched down, must keep a positive
 * result before tax (tax only lowers it). The options for the owner, none implemented here:
 *   (a) a downgrade, or yearly → monthly, takes effect at the period's end, with no credit;
 *   (b) the credit is capped at the part of the allowance not yet used;
 *   (c) a downgrade mid-period is refused once usage has passed the share of the period gone by.
 * Synthetic only: Stripe is a stand-in that prorates as Stripe documents it.
 */
import { lookupKey, switchPlan } from "@/lib/billing";
import { PLAN_PRICES, parseTier } from "@/lib/plan";
import { evaluate, planUnits } from "./margin-alignment-table";
import "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_downgrade_credit_only";
delete process.env.STRIPE_CONNECT_API_BASE;

const SUB = "sub_Downgrade00001";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const START = NOW - DAY; // paid on day 1, switched on day 2
const END = START + 30 * DAY;

const priceOf = (key: string) => `price_${key.replace(/[^a-z]/g, "")}`;
let held: Record<string, unknown> = {};
let credit = 0;
const planned = (tier: "creator" | "pro" | "scale") => {
  const key = lookupKey(tier, "month");
  return {
    id: SUB, object: "subscription", status: "active", customer: "cus_Downgrade01", created: START,
    cancel_at: null, cancel_at_period_end: false, pending_update: null, metadata: { tier },
    items: { object: "list", has_more: false, data: [{ id: "si_Downgrade01", quantity: 1, current_period_start: START, current_period_end: END,
      price: { id: priceOf(key), currency: "usd", unit_amount: PLAN_PRICES[tier].month, lookup_key: key, recurring: { interval: "month", interval_count: 1 } } }] },
  };
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(String(init?.body ?? ""));
  const answer = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (path === "/prices" && method === "GET") {
    const key = url.searchParams.get("lookup_keys[]") ?? "";
    const [, tier, cycle] = /^nimbus_(\w+)_(month|year)$/.exec(key) ?? [];
    const plan = parseTier(tier);
    if (!plan) return answer({ data: [] });
    return answer({ data: [{ id: priceOf(key), unit_amount: PLAN_PRICES[plan][cycle as "month" | "year"], currency: "usd", lookup_key: key, recurring: { interval: cycle, interval_count: 1 } }] });
  }
  if (path.startsWith("/products/") && method === "GET") return answer({ active: true });
  if (path === `/subscriptions/${SUB}` && method === "GET") return answer(held);
  if (path === `/subscriptions/${SUB}` && method === "POST") {
    if (!body.get("items[0][price]")) return answer(held);
    // As Stripe prorates (docs.stripe.com/billing/subscriptions/prorations): with proration, the unused time of the old
    // price is credited and the unused time of the new one charged, at once with always_invoice; with none, nothing.
    const behavior = body.get("proration_behavior") ?? "create_prorations";
    const unused = (END - NOW) / (END - START);
    if (behavior !== "none") credit = Math.max(0, Math.round(unused * PLAN_PRICES.scale.month) - Math.round(unused * PLAN_PRICES.creator.month));
    held = planned("creator");
    return answer(held);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  part("Scale monthly used in full on days 1 and 2, then switched down to Store monthly");
  held = planned("scale");
  credit = 0;
  const result = await switchPlan(SUB, { tier: "creator", cycle: "month" }).catch((error: unknown) => ({ kind: `threw ${(error as Error).message}` }));
  const scale = planUnits(false).find((unit) => unit.id === "scale-month-list");
  if (!scale) throw new Error("no Scale monthly unit");
  const full = evaluate(scale);
  const kept = PLAN_PRICES.scale.month - credit;
  // Receiving costs and reserves are paid on the $999 charged; the full usage of Scale was spent before the switch.
  const pretax = kept - full.totalCents - scale.usageCents;
  console.log(JSON.stringify({ switched: result.kind, creditCents: credit, keptCents: kept, receivingAndReservesCents: full.totalCents, fullUsageCents: scale.usageCents, pretaxCents: pretax }));
  is("the Scale month, used in full and switched down, keeps a positive result before tax (MR rule 1)", pretax > 0, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
