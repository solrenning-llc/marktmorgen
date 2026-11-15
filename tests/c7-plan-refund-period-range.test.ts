/**
 * Issue #4776 (Codex T, reproduced by Claude 2): a yearly refund whose period start is finite but outside what a Date can
 * hold counted zero months used and offered the whole year back. Synthetic, no provider called.
 */
import { planRefund } from "@/lib/plan-refund-rules";
import { done, is, part } from "./check";
async function main() {
  part("A yearly refund with an out-of-range period start is unknown");
  const nowSeconds = 1_700_000_000;
  const result = planRefund({
    cycle: "year", firstPayment: false, periodStartSeconds: 1e100, monthlyCents: 1000, nowSeconds,
    charge: { currency: "usd", succeeded: true, amountCents: 12000, invoiceTotalCents: 12000, billingReason: "subscription_create", refundedCents: 0, taxCents: 0, feeCents: 300, feeCurrency: "usd", paidAtSeconds: nowSeconds - 60 * 86400, disputeStatus: null, disputedCents: null },
  });
  is("out-of-range period start is unreadable", result, { kind: "unknown", reason: "unreadable" });
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
