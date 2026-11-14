/**
 * A waiting second tier is decided once: the creator's approval and the sweep's decision never write over each other,
 * and neither brings back a sale deleted meanwhile (independent review of #3485 at a7f51eb6a3, Claude 1 cloud, LOW,
 * raised before by Claude 3 and Claude 6).
 *
 * Both read the sale (HGET) and then wrote it whole (HSET), so whatever landed in between was lost: the sweep could
 * write tierOff over an approval, an approval could take tierOff away again, and a sale deleted with the store's data in
 * between came back. Each now writes only over exactly the text it read (AFFILIATE_SWAP, a compare-and-set).
 * Synthetic only: the in-memory Redis double, with a write let in between the read and the write.
 */
import * as affiliates from "@/lib/affiliates";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { noteSession } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_decide_once";

const OWNER = "baker@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";

const sessions: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const one = url.pathname.match(/^\/v1\/checkout\/sessions\/([A-Za-z0-9_]+)$/);
  if (one) return sessions[one[1]] ? answer(sessions[one[1]]) : answer({ error: { message: "no such" } }, 404);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 300 * DAY) * 1000, decidedAt: (NOW - 300 * DAY) * 1000, note: "", ...over });

const order = (id: string, email: string | null) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 600,
  amount_total: 5_000,
  amount_subtotal: 5_000,
  currency: "usd",
  total_details: { amount_tax: 0 },
  payment_intent: `pi_${id}`,
  metadata: { store: "oven", product: "prod01", title: "Bread course", via: BEA, via_rate: "30" },
  customer_details: { email },
});

// A write let in once, right after the first read (HGET) of the sale `target` in the sales hash.
const original = redis.pipeline.bind(redis);
let between: { key: string; target: string; run: () => Promise<void> } | null = null;
(redis as unknown as { pipeline: typeof original }).pipeline = async (commands) => {
  const replies = await original(commands);
  const hook = between;
  if (hook && commands.some((c) => c[0] === "HGET" && c[1] === hook.key && c[2] === hook.target)) {
    between = null;
    await hook.run();
  }
  return replies;
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "oven", "Oven School", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestTierOnce1", true);
  await setSubscription(OWNER, { customerId: "cus_oven", subscriptionId: "sub_oven", active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 10 }));
  const store = async () => (await storeForEmail(OWNER))!;
  const statsId = (await store()).statsId!;
  const sales = `nl:aff:${statsId}:sales`;
  await original([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea@example.com", "bea", { by: { id: ANA, percent: 10 } })],
  ]);
  const raw = async (ref: string) => ((await original([["HGET", sales, ref]])) as [string | null])[0];
  const kept = async (ref: string) => {
    const text = await raw(ref);
    return text ? (JSON.parse(text) as { buyerUnknown?: number; tierOff?: number }) : null;
  };
  /** The sale as the other writer leaves it: `change` applied to what is there. */
  const rewrite = (ref: string, change: (sale: Record<string, unknown>) => Record<string, unknown>) => async () => {
    const text = await raw(ref);
    if (text) await original([["HSET", sales, ref, JSON.stringify(change(JSON.parse(text) as Record<string, unknown>))]]);
  };
  const decided = (sale: Record<string, unknown>) => {
    const { buyerUnknown: _w, ...rest } = sale;
    void _w;
    return rest;
  };

  part("The sweep decides tierOff between the approval's read and its write: the approval does not take it away");
  await noteSession(await store(), order("cs_once1", null));
  is("the sale waits", (await kept("cs_once1"))?.buyerUnknown, 1);
  between = { key: sales, target: "cs_once1", run: rewrite("cs_once1", (sale) => ({ ...decided(sale), tierOff: 1 })) };
  const first = await affiliates.approveUnconfirmed(await store(), "tier2:cs_once1");
  is("the approval says it was decided meanwhile", first, "not-waiting");
  is("the sweep's tierOff is kept", (await kept("cs_once1"))?.tierOff, 1);

  part("The creator approves between the sweep's read and its write: the sweep does not write tierOff over it");
  await noteSession(await store(), order("cs_once2", null));
  is("the sale waits", (await kept("cs_once2"))?.buyerUnknown, 1);
  // Its buyer turns out to be the inviting affiliate: the sweep would decide tierOff.
  sessions.cs_once2 = { ...order("cs_once2", "ana@example.com") };
  between = { key: sales, target: "cs_once2", run: rewrite("cs_once2", decided) };
  await affiliates.settleUnconfirmed(await store(), NOW + 10 * DAY);
  const after = await kept("cs_once2");
  is("the creator's approval is kept: no tierOff, no wait", [after?.tierOff, after?.buyerUnknown], [undefined, undefined]);

  part("The sale is deleted between the approval's read and its write: it does not come back");
  await noteSession(await store(), order("cs_once3", null));
  is("the sale waits", (await kept("cs_once3"))?.buyerUnknown, 1);
  between = { key: sales, target: "cs_once3", run: async () => void (await original([["HDEL", sales, "cs_once3"]])) };
  await affiliates.approveUnconfirmed(await store(), "tier2:cs_once3");
  is("no sale is written back", await raw("cs_once3"), null);

  part("Control: with nothing in between, the approval and the sweep still decide");
  await noteSession(await store(), order("cs_once4", null));
  is("approved", await affiliates.approveUnconfirmed(await store(), "tier2:cs_once4"), "approved");
  is("it no longer waits", (await kept("cs_once4"))?.buyerUnknown, undefined);
  await noteSession(await store(), order("cs_once5", null));
  sessions.cs_once5 = { ...order("cs_once5", "ana@example.com") };
  await affiliates.settleUnconfirmed(await store(), NOW + 10 * DAY);
  is("the sweep decides tierOff for the inviter's own purchase", [(await kept("cs_once5"))?.tierOff, (await kept("cs_once5"))?.buyerUnknown], [1, undefined]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
