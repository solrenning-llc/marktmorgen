/**
 * A sale's receipt PDF (lib/receipt-pdf.ts, receiptFrom) takes its date, the
 * amount refunded and whether it was refunded or disputed from the payment's
 * charge, expanded. That charge is used only when it names the payment it is
 * read for: a charge of another payment, even of the same amount, is
 * unreadable, never this sale's refund or its "refunded" (issue #4437, Codex
 * X8). A charge that names no payment cannot be tied to it either.
 */
import { receiptFrom } from "@/lib/receipt-pdf";
import { done, is } from "./check";

const REF = "cs_test_a1B2c3D4e5F6g7H8i9J0";
const HANDLE = "harborreceipts";
const INTENT = "pi_1TestReceipt0001";

function paidSession(charge: Record<string, unknown>): Record<string, unknown> {
  return {
    id: REF, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", currency: "usd",
    amount_subtotal: 5400, amount_total: 5260, total_details: { amount_discount: 500, amount_shipping: 0, amount_tax: 360 },
    customer_details: { email: "dana@example.com" }, metadata: { store: HANDLE, product: "p1" },
    payment_intent: {
      id: INTENT, object: "payment_intent", status: "succeeded", amount: 5260, currency: "usd",
      latest_charge: { id: "ch_1TestReceipt0001", object: "charge", paid: true, status: "succeeded", amount: 5260, amount_refunded: 0, refunded: false, disputed: false, currency: "usd", created: 1_790_000_000, ...charge },
    },
  };
}
const linesPage = () => ({
  object: "list", has_more: false,
  data: [
    { id: "li_1TestLine0001", object: "item", description: "Sourdough Course", quantity: 1, amount_subtotal: 4900, amount_total: 4767, currency: "usd" },
    { id: "li_1TestLine0002", object: "item", description: "Starter jar label pack", quantity: 2, amount_subtotal: 500, amount_total: 493, currency: "usd" },
  ],
});
const seller = { name: "Harbor Kitchen", address: "12 Pier Road, Portland, ME 04101, USA", handles: new Set([HANDLE]) };

async function main(): Promise<void> {
  const own = receiptFrom(seller, REF, paidSession({ payment_intent: INTENT, amount_refunded: 1200 }), linesPage());
  is("control: the payment's own charge reads, with its refund", own.ok ? own.receipt.refunded : null, 1200);
  is("a charge of another payment is unreadable", receiptFrom(seller, REF, paidSession({ payment_intent: "pi_OtherSynthetic01", amount_refunded: 1200 }), linesPage()), { ok: false, why: "unreadable" });
  is("another payment's charge refunded in full is unreadable, not 'refunded'", receiptFrom(seller, REF, paidSession({ payment_intent: "pi_OtherSynthetic01", amount_refunded: 5260, refunded: true }), linesPage()), { ok: false, why: "unreadable" });
  is("a charge naming no payment cannot be tied to it", receiptFrom(seller, REF, paidSession({}), linesPage()), { ok: false, why: "unreadable" });
  is("a charge naming its payment as an object is read by its id", receiptFrom(seller, REF, paidSession({ payment_intent: { id: INTENT } }), linesPage()).ok, true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
