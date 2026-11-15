/**
 * #4685: a payment request paid after its checkout was opened the day before is dated when the payment was seen, never
 * when the checkout was opened (Stripe's session `created`). Synthetic store and Redis. Test from the issue (Codex X8).
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { createRequest, markPaid } from "@/lib/payment-request-store";
import { readDraft } from "@/lib/payment-request-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const owner = "owner-m0@example.com";
  await claimHandle(owner, "m0harbor", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1M0paidat", true);
  await setSubscription(owner, { customerId: "cus_M0paidat001", subscriptionId: "sub_M0paidat001", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const OPEN = Date.UTC(2026, 10, 12, 23, 40), NOW = Date.UTC(2026, 10, 13, 0, 5);
  const draft = readDraft({ email: "buyer@example.com", name: "Buyer", lines: [{ text: "Guide", quantity: 1, amount: "12" }], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", OPEN);
  if (!draft.ok) throw new Error("draft refused");
  const created = await createRequest(store, draft.draft, OPEN);
  if (!created.ok) throw new Error("request refused");
  part("checkout opened 11/12 23:40 UTC, paid and read back 11/13 00:05 UTC");
  const paid = await markPaid(store, created.request.id, { id: "cs_test_M0paidat0000001", payment_intent: "pi_M0paidat0001", amount_total: 1200, created: Math.floor(OPEN / 1000) }, NOW);
  is("state paid", paid?.request.state, "paid");
  is("paidAt is not the checkout's creation time", paid?.request.paidAt === OPEN, false);
  is("paidAt date (UTC) is 2026-11-13", new Date(paid!.request.paidAt).toISOString().slice(0, 10), "2026-11-13");
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
