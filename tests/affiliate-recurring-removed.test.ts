/**
 * A removed affiliate's link no longer earns, on a membership's renewals and a
 * plan's instalments too.
 *
 * Removing an affiliate tells the creator "Their link no longer earns" and the
 * affiliate "your link no longer earns. What you earned before is below."
 * (lib/buyer-words/affiliates.ts). recurringReferrals read every paid invoice
 * carrying the affiliate and credited it whatever the affiliate's status, so a
 * removed affiliate kept earning on every renewal after the removal (owed,
 * bonuses, the program's numbers), payable as soon as they were restored. The
 * second tier already holds a removed recruiter to the payments made before
 * the removal (tierLines); a recurring line is held to the same.
 */
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { readBook } from "@/lib/affiliates";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_recurring_removed_stand_in";

const OWNER = "owner@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const SARA = "0123456789ab";
let invoices: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/invoices") return answer({ object: "list", data: invoices, has_more: false });
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const invoice = (id: string, paidAt: number, meta: Record<string, string>) => ({
  id,
  status: "paid",
  amount_paid: 2000,
  currency: "usd",
  customer_email: "member@example.com",
  created: paidAt,
  status_transitions: { paid_at: paidAt },
  total_taxes: [],
  parent: { subscription_details: { metadata: { store: "harbor", ...meta } } },
  payments: { data: [{ payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] },
});

const person = (status: string, decidedAt: number) =>
  JSON.stringify({ id: SARA, email: "sara@example.com", code: "sara", status, appliedAt: (NOW - 400 * DAY) * 1000, decidedAt, note: "" });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0002", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, recurring: 12 });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;

  const sold = NOW - 60 * DAY;
  const removedAt = (NOW - 10 * DAY) * 1000;
  const terms = { product: club.product.id, via: SARA, via_rate: "30", via_months: "12", via_at: String(sold) };
  const plan = { product: club.product.id, via: SARA, via_rate: "30", kind: "plan" };
  invoices = [
    invoice("in_Before000001", sold + 60, terms),
    invoice("in_Before000002", NOW - 30 * DAY, terms),
    invoice("in_After0000001", NOW - DAY, terms),
    invoice("in_PlanBefore01", NOW - 20 * DAY, plan),
    invoice("in_PlanAfter001", NOW - 2 * DAY, plan),
  ];
  const earned = async () => {
    const book = await readBook(store);
    return book.lines.filter((l) => l.aff === SARA && l.how === "recurring" && l.commission > 0).map((l) => l.ref).sort();
  };

  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, SARA, person("approved", 1)], ["HSET", `nl:aff:${statsId}:codes`, "sara", SARA]]);
  is("approved: every payment earns", await earned(), ["in_After0000001", "in_Before000001", "in_Before000002", "in_PlanAfter001", "in_PlanBefore01"]);

  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, SARA, person("removed", removedAt)]]);
  is("removed: only the payments made before the removal earn", await earned(), ["in_Before000001", "in_Before000002", "in_PlanBefore01"]);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
