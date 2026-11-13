/**
 * A sale's receipt PDF (lib/receipt-pdf.ts, receiptFrom) prints the lines
 * Stripe lists for the checkout. A page that repeats one line's id in place of
 * another does not show what was bought, even when its amounts add up to the
 * subtotal: the receipt is unreadable, never one product printed twice and the
 * other left out (issue #4445, Codex X8). Distinct lines of equal value read.
 */
import { receiptFrom } from "@/lib/receipt-pdf";
import { done, is } from "./check";

const REF = "cs_test_a1B2c3D4e5F6g7H8i9J0";
const HANDLE = "harborreceipts";
function paidSession(): Record<string, unknown> {
  return {
    id: REF, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", currency: "usd",
    amount_subtotal: 5400, amount_total: 5260, total_details: { amount_discount: 500, amount_shipping: 0, amount_tax: 360 },
    customer_details: { email: "dana@example.com" }, metadata: { store: HANDLE, product: "p1" },
    payment_intent: {
      id: "pi_1TestReceipt0001", object: "payment_intent", status: "succeeded", amount: 5260, currency: "usd",
      latest_charge: { id: "ch_1TestReceipt0001", object: "charge", payment_intent: "pi_1TestReceipt0001", paid: true, status: "succeeded", amount: 5260, amount_refunded: 0, refunded: false, disputed: false, currency: "usd", created: 1_790_000_000 },
    },
  };
}
const linesPage = (rows: Record<string, unknown>[]) => ({ object: "list", has_more: false, data: rows });
const seller = { name: "Harbor Kitchen", address: "12 Pier Road, Portland, ME 04101, USA", handles: new Set([HANDLE]) };
const row = (id: string, description: string) => ({ id, object: "item", description, quantity: 1, amount_subtotal: 2700, amount_total: 2700, currency: "usd" });

async function main(): Promise<void> {
  const first = row("li_EqualSynthetic01", "First paid product");
  const second = row("li_EqualSynthetic02", "Second paid product");
  const distinct = receiptFrom(seller, REF, paidSession(), linesPage([first, second]));
  is("control: two distinct lines of equal value read", distinct.ok ? distinct.receipt.lines.map((l) => l.description) : null, ["First paid product", "Second paid product"]);
  is("a repeated line id is unreadable", receiptFrom(seller, REF, paidSession(), linesPage([first, first])), { ok: false, why: "unreadable" });
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
