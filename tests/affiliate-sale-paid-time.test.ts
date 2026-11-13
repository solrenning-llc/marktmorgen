/**
 * A one-time sale's commission was dated at the checkout's creation (lib/affiliates.ts, noteSession: session.created),
 * and the creator's hold ("payable N days after it is made") counts from that date. A buyer who opened checkout and
 * paid a day later, or whose bank payment settled days later, had the hold shortened by that gap, so a refund inside
 * the real window could come after the commission was paid. Recurring lines already use the invoice's paid time.
 * Now the sale is dated at its payment: the charge's own time when the checkout carries it, otherwise the time it is
 * noted (always at or after the payment, so the hold is never shortened). Found by Claude 3 (nuvem E)'s money audit,
 * 13/11/2026. Synthetic only: the in-memory Redis double, through the real noteSession.
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { noteSession, readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_paid_time";
process.env.RESEND_API_KEY = "re_test_affiliate_paid_time";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const OWNER = "potter@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const OPENED = NOW - 3 * 86_400;
const PAID = NOW - 3_600;

const order = (id: string, intent: unknown) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: OPENED,
  amount_total: 5_000,
  amount_subtotal: 5_000,
  currency: "usd",
  total_details: { amount_tax: 0 },
  payment_intent: intent,
  metadata: { store: "kiln", product: "prod01", title: "Glaze course", via: ANA, via_rate: "30" },
  customer_details: { email: "buyer@example.com" },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kiln", "Kiln Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPaidTime01", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, lifetime: true }));
  const store = (await storeForEmail(OWNER))!;
  await redis.pipeline([
    ["HSET", `nl:aff:${store.statsId}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" })],
  ]);
  const line = async (ref: string) => (await readBook(store)).lines.find((l) => l.ref === ref);

  part("A checkout opened three days before it was paid");
  await noteSession(store, order("cs_paidlater", { id: "pi_paidlater", object: "payment_intent", latest_charge: { id: "ch_paidlater", object: "charge", created: PAID, payment_intent: "pi_paidlater" } }));
  is("the sale is dated at its payment, not at the checkout's opening", (await line("cs_paidlater"))?.at, PAID);

  part("Without the charge's time, it is never dated before it was noted");
  await noteSession(store, order("cs_nocharge", "pi_nocharge"));
  const at = (await line("cs_nocharge"))?.at ?? 0;
  is("dated no earlier than now, never at the opening", at >= NOW, true);
  done();
}

void main();
