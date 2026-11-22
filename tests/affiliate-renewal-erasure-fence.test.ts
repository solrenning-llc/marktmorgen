/** A renewal approval cannot recreate an affiliate sale after the closing walk has begun erasing its store. */
import * as affiliates from "@/lib/affiliates";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { approveUnconfirmed } from "@/lib/affiliates";
import {
  ERASING_KEY,
  claimHandle,
  ensureStatsId,
  ensureStoreId,
  erasingField,
  setAffiliateSetting,
  setStripeAccount,
  setSubscription,
  storeForEmail,
  storeRef,
} from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only";
process.env.RESEND_API_KEY = "re_test_synthetic_only";

const OWNER = "renewal-erasure@example.com";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";
const FROM = affiliates.TIER_BUYER_FROM;
const invoice = {
  id: "in_DeleteRace01",
  object: "invoice",
  status: "paid",
  amount_paid: 4_000,
  currency: "usd",
  created: Math.max(NOW - 3_600, FROM + 60),
  status_transitions: { paid_at: Math.max(NOW - 3_600, FROM + 60) },
  total_taxes: [],
  customer_email: null,
  parent: { subscription_details: { metadata: { store: "synthetic", product: "prod01", via: BEA, via_rate: "30", via_months: "12", via_at: String(NOW - 40 * DAY) } } },
  payments: { object: "list", has_more: false, data: [{ status: "paid", payment: { payment_intent: "pi_DeleteRace01" } }] },
};

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const body = url.pathname === `/v1/invoices/${invoice.id}` ? invoice : { object: "list", data: [], has_more: false };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 300 * DAY) * 1000, decidedAt: (NOW - 300 * DAY) * 1000, note: "", ...over });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "synthetic", "Synthetic", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_SynthDelete1", true);
  await setSubscription(OWNER, { customerId: "cus_synthetic", subscriptionId: "sub_synthetic", active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 10 }));
  const stale = (await storeForEmail(OWNER))!;
  const statsId = stale.statsId!;
  const people = `nl:aff:${statsId}:people`;
  const sales = `nl:aff:${statsId}:sales`;
  const erasing = await erasingField(storeRef(stale));
  await redis.pipeline([
    ["HSET", people, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", people, BEA, person(BEA, "bea@example.com", "bea", { by: { id: ANA, percent: 10 } })],
  ]);

  const original = redis.pipeline.bind(redis);
  let interleaved = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const finalWrite = commands.some((command) => command[0] === "EVAL" && command.map(String).includes(sales) && command.map(String).includes("HSETNX"));
    if (!interleaved && finalWrite) {
      interleaved = true;
      await original([["HSET", ERASING_KEY, erasing, String(Date.now())], ["DEL", people], ["DEL", sales]]);
    }
    return original(commands);
  }) as typeof redis.pipeline;

  part("erasure begins after the invoice and affiliates are read, before the renewal is written");
  const result = await approveUnconfirmed(stale, `tier2:${invoice.id}`);
  redis.pipeline = original;
  const [raw] = await original([["HGET", sales, invoice.id]]);
  is("the race ran", interleaved, true);
  is("the approval reports the erased store gone", result, "gone");
  is("the deleted sales hash stays gone", raw, null);
  done();
}

void main();
