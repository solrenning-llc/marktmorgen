import type { NextRequest } from "next/server";
import { countStudio, creatorFrom } from "@/lib/studio-route";
import { saleHandles } from "@/lib/store";
import { DEMO_CONNECTED_ACCOUNT } from "@/lib/demo-account";
import { RECEIPT_NUMBER_MAX, assignReceiptNumber, receiptNumberText } from "@/lib/receipt-number";
import { RECEIPT_PDF_MAX_BYTES, RECEIPT_PDF_UNITS, RECEIPT_REFERENCE, type ReceiptRefusal, readReceipt, receiptDrawable, receiptPdf } from "@/lib/receipt-pdf";

// The longest one download may run: the two Stripe reads, side by side, and the drawing (RECEIPT_STRIPE_TIMEOUT_MS; priced
// as a request of the "step" shape, tests/kb22-receipt-pdf.test.ts).
export const maxDuration = 10;

/** What each refusal says, in words the creator can act on. */
const REFUSED: Record<ReceiptRefusal, [number, string]> = {
  unknown: [404, "That sale was not found on this store's Stripe account."],
  not_paid: [409, "That checkout was not paid, so there is no receipt for it."],
  subscription: [409, "That sale is a membership or a payment plan. Stripe makes an invoice for each of its payments: open it in your Stripe dashboard."],
  nothing_charged: [409, "Nothing was charged for that order, so there is no receipt for it."],
  refunded: [409, "This sale was refunded in full, so there is no receipt for it."],
  disputed: [409, "This payment is disputed. Its record stays in your Stripe dashboard until the dispute is closed."],
  too_many_lines: [409, "This sale has more lines than a receipt here can hold. Open it in your Stripe dashboard."],
  unreadable: [502, "Some of Stripe's figures for this sale could not be read, so no receipt was made. Open the sale in your Stripe dashboard, or try again later."],
};

/**
 * One sale's receipt as a tagged PDF (lib/receipt-pdf.ts, 601 [KB22] U1):
 * `?reference=cs_…`, one of the sales listed in the studio. For a role that
 * may see the store's sales (lib/team-roles.ts, "orders"). The sale is read
 * from the store's own Stripe account each time and has to be this store's;
 * the file is made on request and kept nowhere. Only its number is kept: the
 * store's next one the first time, the same one after (lib/receipt-number.ts,
 * U2), given only to a sale that makes a receipt. RECEIPT_PDF_UNITS of the
 * store's studio requests are taken before Stripe is read.
 */
export async function GET(request: NextRequest) {
  const plain = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const creator = await creatorFrom(request, "orders");
  if (creator instanceof Response) return creator;
  const reference = request.nextUrl.searchParams.get("reference") ?? "";
  if (!RECEIPT_REFERENCE.test(reference)) return plain(400, "Which sale? Open its receipt from your list of sales.");
  let { store } = creator;
  const account = store.stripeAccountId;
  // Nothing sold on the demo's account is a real sale (lib/house-store.ts).
  if (!account || account === DEMO_CONNECTED_ACCOUNT) return plain(404, REFUSED.unknown[1]);
  // The rest of the file's requests, before anything is read from Stripe.
  const counted = await countStudio(store, null, RECEIPT_PDF_UNITS - 1);
  if (!counted.ok) return plain(429, counted.message);
  if (counted.store) store = counted.store;
  let read;
  try {
    read = await readReceipt(account, { name: store.name, address: store.mail?.address ?? null, handles: saleHandles(store) }, reference);
  } catch (error) {
    console.error("reading a sale for its receipt failed", error);
    return plain(503, "Stripe did not answer just now. Try again in a moment.");
  }
  if (!read.ok) {
    const [status, words] = REFUSED[read.why];
    return plain(status, words);
  }
  // Asked with the longest number, so a sale whose receipt cannot be drawn is never given one.
  if (!(await receiptDrawable({ ...read.receipt, number: receiptNumberText(RECEIPT_NUMBER_MAX) }))) {
    return plain(422, "This sale has letters the PDF cannot draw. Its record is in your Stripe dashboard.");
  }
  const numbered = await assignReceiptNumber(store, reference);
  if (!numbered.ok) {
    // A full room is said as full; any other answer is not a number, and no receipt goes out with a guessed one.
    if (numbered.reason === "full") return plain(409, numbered.message);
    return plain(503, "This receipt's number could not be read just now, so no receipt was made. Try again in a moment.");
  }
  const receipt = { ...read.receipt, number: numbered.number };
  const bytes = await receiptPdf(receipt);
  // Never sent past the weight it is priced at (tests/kb22-receipt-pdf.test.ts draws the heaviest).
  if (bytes.byteLength > RECEIPT_PDF_MAX_BYTES) {
    console.error("a receipt came out heavier than its ceiling", bytes.byteLength);
    return plain(500, "This receipt could not be made. Its record is in your Stripe dashboard.");
  }
  const name = `receipt-${receipt.number}.pdf`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
