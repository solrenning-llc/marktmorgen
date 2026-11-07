/** Independent synthetic evidence for #2952; no payment or provider operation. */
import { receiptFrom, receiptPdf, receiptTexts } from "@/lib/receipt-pdf";
import { done, is } from "./check";

const reference = "cs_test_PReceiptEvidence0001";
const seller = { name: "Synthetic Store", address: null, handles: new Set(["proofstore"]) };
function fixture() {
  return {
    id: reference, metadata: { store: "proofstore" }, mode: "payment", status: "complete", payment_status: "paid",
    currency: "usd", amount_subtotal: 100, amount_total: 100,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    customer_details: { email: "buyer@example.test" },
    payment_intent: { status: "succeeded", latest_charge: {
      id: "ch_SyntheticReceipt0001", amount: 100, amount_refunded: 0, refunded: false,
      disputed: false, paid: true, status: "succeeded", currency: "usd", created: 1_790_000_000,
    } },
  };
}
const page = () => ({ data: [{ id: "li_SyntheticReceipt0001", description: "Synthetic course", quantity: 1, amount_subtotal: 100, currency: "usd" }], has_more: false });
const read = (session: unknown) => receiptFrom(seller, reference, session, page());

async function main() {
  is("healthy untaxed receipt", read(fixture()).ok, true);
  const included = fixture(); included.total_details.amount_tax = 20;
  const valid = read(included);
  is("healthy included tax", valid.ok && valid.receipt.taxIncluded, true);

  const impossibleTax = fixture(); impossibleTax.total_details.amount_tax = 101;
  const over = read(impossibleTax);
  is("included tax cannot exceed the whole payment", over.ok, false);
  console.log("OBSERVATION included-tax", over.ok ? receiptTexts(over.receipt).filter(t => /Tax|Total paid/.test(t.text)) : over);
  if (over.ok) console.log("OBSERVATION included-tax PDF bytes", (await receiptPdf(over.receipt)).byteLength);

  const impossibleDiscount = fixture();
  impossibleDiscount.total_details.amount_discount = 200;
  impossibleDiscount.total_details.amount_shipping = 200;
  const discount = read(impossibleDiscount);
  is("shipping must not hide a discount larger than the item subtotal", discount.ok, false);
  console.log("OBSERVATION discount", discount.ok ? receiptTexts(discount.receipt).filter(t => /Subtotal|Discount|Shipping|Total paid/.test(t.text)) : discount);
  if (discount.ok) console.log("OBSERVATION discount PDF bytes", (await receiptPdf(discount.receipt)).byteLength);

  const farDate = fixture(); farDate.payment_intent.latest_charge.created = Number.MAX_SAFE_INTEGER;
  const date = read(farDate);
  let threw = false;
  try { if (date.ok) receiptTexts(date.receipt); } catch (error) { threw = error instanceof RangeError; }
  is("an admitted timestamp must be renderable", threw, false);

  for (const value of [undefined, null, "100", -1, NaN, Infinity, 1.5]) {
    const session = fixture();
    Object.defineProperty(session, "amount_total", { value, enumerable: true });
    is(`unknown amount ${String(value)} refuses`, read(session).ok, false);
  }
  for (const field of ["amount_refunded", "created", "disputed", "paid", "currency"] as const) {
    const session = fixture();
    Reflect.deleteProperty(session.payment_intent.latest_charge, field);
    is(`missing charge ${field} refuses`, read(session).ok, false);
  }
  const foreign = fixture(); foreign.metadata.store = "otherstore";
  is("another store cannot obtain a receipt", read(foreign).ok, false);
  const refunded = fixture(); refunded.payment_intent.latest_charge.amount_refunded = 100;
  is("fully refunded charge refuses", read(refunded).ok, false);
  const disputed = fixture(); disputed.payment_intent.latest_charge.disputed = true;
  is("disputed charge refuses", read(disputed).ok, false);
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
