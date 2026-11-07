/**
 * One sale's receipt as a PDF a screen reader can read (601 [KB22], unit U1;
 * PDF/UA, AX274): for the creator to keep, print or send to their buyer.
 *
 * The receipt is the creator's own. Every sale is a direct charge on their
 * Stripe account, so this reads that account (the checkout, its payment and
 * charge expanded, and its lines) each time and keeps nothing: the seller's
 * name and postal address as the store keeps them, the buyer's address as
 * they paid with it, each line, the subtotal, discount, shipping and tax as
 * Stripe reports them, the total, and any part refunded.
 *
 * A figure missing, of another type, or that does not add up with the rest
 * makes no file at all (CX-123 rule 24: unknown is never a zero), and
 * neither does a sale refunded in full, a disputed payment, an unpaid
 * checkout or another store's sale. Memberships and payment plans are
 * subscriptions, whose payments Stripe invoices itself; they are refused
 * with a sentence that says so. Numbering is a later unit (U2): the receipt
 * carries Stripe's reference for the sale.
 *
 * The letters are the certificate's (Noto Sans, lib/certificate-pdf.ts),
 * tagged through lib/tagged-pdf.ts over as many pages as it takes.
 */
import { PDFDocument, type PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PageTagger, type TagRole } from "@/lib/tagged-pdf";
import { canDraw, loadFonts } from "@/lib/certificate-pdf";
import { wrap } from "@/lib/form-response-pdf";
import { formatMoney } from "@/lib/money";
import { STRIPE_LIST_VERSION, hasOwnField, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { StripeError, onAccount } from "@/lib/stripe-account";

/**
 * What one file costs, in the store's studio requests, all taken before
 * Stripe is read (app/api/store/receipt-pdf/route.ts): one by the studio's
 * own check, the rest just before. tests/kb22-receipt-pdf.test.ts holds them
 * above a request of the "step" shape (ten seconds held at 2 GB, two seconds
 * of CPU, forty commands, 200 KB through the database) and the heaviest file
 * sent, so a download never costs more than the window already prices
 * (line "studio", tests/plan-cost-registry.ts).
 */
export const RECEIPT_PDF_UNITS = 4;
/** The most one file weighs: the most lines, the longest words, with room (tests/kb22-receipt-pdf.test.ts draws it). */
export const RECEIPT_PDF_MAX_BYTES = 64_000;
/** How long each of the two Stripe reads, made side by side, is waited on. */
export const RECEIPT_STRIPE_TIMEOUT_MS = 8_000;
/**
 * The most lines a receipt holds: a cart takes at most MAX_CART products
 * (lib/cart-rules.ts) and a few extras, so this is far past any sale made
 * here. A sale with more is refused, never cut short. Its lines are read as
 * one page of RECEIPT_LINES_PAGE, so the end of the list is known.
 */
export const RECEIPT_MAX_LINES = 30;
/** The page the lines are read in: Stripe's largest. */
export const RECEIPT_LINES_PAGE = 100;
/** The longest line name drawn: the longest name a checkout here gives Stripe (lib/calls.ts slices to it). */
export const RECEIPT_MAX_DESCRIPTION = 250;
/** The language the receipt's own words are written in. */
export const RECEIPT_LANG = "en-US";

export const RECEIPT_REFERENCE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

export type ReceiptLine = { description: string; quantity: number; amount: number };

export type Receipt = {
  reference: string;
  sellerName: string;
  /** The postal address the store keeps for its emails; null when it keeps none. */
  sellerAddress: string | null;
  buyerEmail: string;
  currency: string;
  /** When the charge was made, in Stripe's seconds. */
  paidAt: number;
  lines: ReceiptLine[];
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  /** Whether the tax is inside the prices (Stripe's figures add up without it) rather than added on top. */
  taxIncluded: boolean;
  total: number;
  refunded: number;
};

export type ReceiptRefusal = "unknown" | "not_paid" | "subscription" | "nothing_charged" | "refunded" | "disputed" | "too_many_lines" | "unreadable";

export type ReceiptRead = { ok: true; receipt: Receipt } | { ok: false; why: ReceiptRefusal };

export type Seller = { name: string; address: string | null; handles: Set<string> };

/** An amount Stripe gives: a whole number of the currency's smallest unit, never negative. */
const amount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** The last second a Date can hold (8.64e15 ms): a later charge date cannot be written, so it is not a date. */
const LAST_SECOND = 8_640_000_000_000;
const CURRENCY = /^[a-z]{3}$/;
const CHARGE_ID = /^(ch|py)_[A-Za-z0-9]{6,255}$/;
const LINE_ID = /^li_[A-Za-z0-9]{6,255}$/;

const refuse = (why: ReceiptRefusal): ReceiptRead => ({ ok: false, why });

/** A field of a plain object, or undefined. */
function field(object: unknown, name: string): unknown {
  return plainObject(object) ? ownField(object, name) : undefined;
}

/**
 * The receipt from what Stripe answered: the checkout (read with
 * `expand[]=payment_intent.latest_charge`) and one page of its lines. Pure:
 * every check is here, so the route only reads and draws.
 */
export function receiptFrom(seller: Seller, reference: string, session: unknown, linesPage: unknown): ReceiptRead {
  if (!plainObject(session) || ownField(session, "id") !== reference) return refuse("unknown");
  // A sale is this store's only when it names one of the store's handles, as the studio's list reads them.
  const store = field(ownField(session, "metadata"), "store");
  if (typeof store !== "string" || !seller.handles.has(store)) return refuse("unknown");
  const mode = ownField(session, "mode");
  if (mode === "subscription" || mode === "setup") return refuse("subscription");
  if (mode !== "payment") return refuse("unreadable");
  const status = ownField(session, "status");
  const paymentStatus = ownField(session, "payment_status");
  if (status === "complete" && paymentStatus === "no_payment_required") return refuse("nothing_charged");
  if (status !== "complete" || paymentStatus !== "paid") return refuse("not_paid");

  const currency = ownField(session, "currency");
  const total = ownField(session, "amount_total");
  const subtotal = ownField(session, "amount_subtotal");
  const details = ownField(session, "total_details");
  if (typeof currency !== "string" || !CURRENCY.test(currency) || !amount(total) || !amount(subtotal) || !plainObject(details)) return refuse("unreadable");
  if (total === 0) return refuse("nothing_charged");
  const discount = ownField(details, "amount_discount");
  const shipping = ownField(details, "amount_shipping");
  const tax = ownField(details, "amount_tax");
  if (!amount(discount) || !amount(shipping) || !amount(tax)) return refuse("unreadable");
  // Stripe's figures must add up one way or the other: tax on top, or tax inside the prices.
  const before = subtotal - discount + shipping;
  let taxIncluded: boolean;
  if (before + tax === total) taxIncluded = false;
  // Tax inside the prices is a part of the total, so it is always smaller than it (total is above zero here).
  else if (tax > 0 && tax < total && before === total) taxIncluded = true;
  else return refuse("unreadable");

  const email = field(ownField(session, "customer_details"), "email");
  if (typeof email !== "string" || !email.includes("@") || email.length > 320) return refuse("unreadable");

  // The payment and its charge, expanded: what was actually taken, and what has been given back.
  const intent = ownField(session, "payment_intent");
  const charge = field(intent, "latest_charge");
  if (!plainObject(intent) || ownField(intent, "status") !== "succeeded" || !plainObject(charge)) return refuse("unreadable");
  const chargeId = ownField(charge, "id");
  const charged = ownField(charge, "amount");
  const refunded = ownField(charge, "amount_refunded");
  const created = ownField(charge, "created");
  const fullyRefunded = ownField(charge, "refunded");
  const disputed = ownField(charge, "disputed");
  if (
    typeof chargeId !== "string" || !CHARGE_ID.test(chargeId) ||
    ownField(charge, "paid") !== true || ownField(charge, "status") !== "succeeded" ||
    ownField(charge, "currency") !== currency || charged !== total ||
    !amount(refunded) || refunded > charged ||
    typeof fullyRefunded !== "boolean" || typeof disputed !== "boolean" ||
    !amount(created) || created > LAST_SECOND
  ) return refuse("unreadable");
  if (fullyRefunded || refunded === charged) return refuse("refunded");
  if (disputed) return refuse("disputed");

  // Its lines: one page read to its end, every row readable, adding up to the subtotal.
  let page;
  try {
    page = readStripePage(linesPage, (row) => {
      const description = ownField(row, "description");
      const quantity = ownField(row, "quantity");
      return (
        typeof description === "string" && description.trim() !== "" && description.length <= RECEIPT_MAX_DESCRIPTION &&
        typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity >= 1 &&
        amount(ownField(row, "amount_subtotal")) &&
        hasOwnField(row, "currency") && ownField(row, "currency") === currency
      );
    }, LINE_ID);
  } catch {
    return refuse("unreadable");
  }
  if (page.hasMore || page.rows.length + page.unreadable > RECEIPT_MAX_LINES) return refuse("too_many_lines");
  if (page.unreadable > 0 || page.rows.length === 0) return refuse("unreadable");
  const lines = page.rows.map((row) => ({
    description: (ownField(row, "description") as string).trim(),
    quantity: ownField(row, "quantity") as number,
    amount: ownField(row, "amount_subtotal") as number,
  }));
  if (lines.reduce((sum, line) => sum + line.amount, 0) !== subtotal) return refuse("unreadable");

  return {
    ok: true,
    receipt: {
      reference,
      sellerName: seller.name,
      sellerAddress: seller.address && seller.address.trim() ? seller.address.trim() : null,
      buyerEmail: email,
      currency,
      paidAt: created,
      lines,
      subtotal,
      discount,
      shipping,
      tax,
      taxIncluded,
      total,
      refunded,
    },
  };
}

/**
 * Reads the sale on the creator's account: the checkout with its payment and
 * charge, and its lines, side by side. A checkout the account does not have
 * is "unknown"; any other failure throws, for the route to say Stripe did
 * not answer.
 */
export async function readReceipt(account: string, seller: Seller, reference: string): Promise<ReceiptRead> {
  if (!RECEIPT_REFERENCE.test(reference)) return refuse("unknown");
  const id = encodeURIComponent(reference);
  try {
    const [session, lines] = await Promise.all([
      onAccount("GET", account, `/checkout/sessions/${id}?expand[]=payment_intent.latest_charge`, undefined, STRIPE_LIST_VERSION, undefined, RECEIPT_STRIPE_TIMEOUT_MS),
      onAccount("GET", account, `/checkout/sessions/${id}/line_items?limit=${RECEIPT_LINES_PAGE}`, undefined, STRIPE_LIST_VERSION, undefined, RECEIPT_STRIPE_TIMEOUT_MS),
    ]);
    return receiptFrom(seller, reference, session, lines);
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return refuse("unknown");
    throw error;
  }
}

const day = (at: number) => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(at * 1000));
const hour = (at: number) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(at * 1000));

/** The file's title: whose receipt and the day it was paid. */
export function receiptTitle(receipt: Receipt): string {
  return `Receipt from ${receipt.sellerName} — ${day(receipt.paidAt)}`;
}

/** The texts the file draws, in reading order: what `canDraw` is asked about before anything is made. */
export function receiptTexts(receipt: Receipt): { role: TagRole; text: string }[] {
  const money = (value: number) => formatMoney(value, receipt.currency, "en-US");
  const out: { role: TagRole; text: string }[] = [{ role: "H1", text: `Receipt from ${receipt.sellerName}` }];
  if (receipt.sellerAddress) out.push({ role: "P", text: receipt.sellerAddress });
  out.push(
    { role: "H2", text: "Sale" },
    { role: "P", text: `Paid on ${day(receipt.paidAt)}, ${hour(receipt.paidAt)}` },
    { role: "P", text: `Paid by ${receipt.buyerEmail}` },
    { role: "P", text: `Stripe reference ${receipt.reference}` },
    { role: "H2", text: "Items" },
  );
  for (const line of receipt.lines) out.push({ role: "P", text: `${line.description}, quantity ${line.quantity}: ${money(line.amount)}` });
  out.push({ role: "H2", text: "Totals" }, { role: "P", text: `Subtotal: ${money(receipt.subtotal)}` });
  if (receipt.discount > 0) out.push({ role: "P", text: `Discount: -${money(receipt.discount)}` });
  if (receipt.shipping > 0) out.push({ role: "P", text: `Shipping: ${money(receipt.shipping)}` });
  out.push({ role: "P", text: receipt.taxIncluded ? `Tax included in the prices above: ${money(receipt.tax)}` : `Tax: ${money(receipt.tax)}` });
  out.push({ role: "P", text: `Total paid: ${money(receipt.total)}` });
  if (receipt.refunded > 0) {
    out.push({ role: "P", text: `Refunded: ${money(receipt.refunded)}` }, { role: "P", text: `Paid after refunds: ${money(receipt.total - receipt.refunded)}` });
  }
  out.push(
    { role: "H2", text: "About this receipt" },
    {
      role: "P",
      text: `${receipt.sellerName} charged this payment on their own Stripe account. Marktmorgen made this file from Stripe's record of the sale and did not take or hold the payment.`,
    },
  );
  return out;
}

/** Whether every letter can be drawn; when not, no file is made. */
export async function receiptDrawable(receipt: Receipt): Promise<boolean> {
  return canDraw(...receiptTexts(receipt).map((t) => t.text));
}

const W = 612;
const H = 792;
const MARGIN = 72;
const WIDTH = W - 2 * MARGIN;

/** The receipt as a tagged PDF, US Letter, portrait, as many pages as it takes. */
export async function receiptPdf(receipt: Receipt): Promise<Uint8Array> {
  const loaded = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const sans = await pdf.embedFont(loaded.sans, { subset: true });
  const semi = await pdf.embedFont(loaded.semi, { subset: true });
  const ink = rgb(0x17 / 255, 0x14 / 255, 0x1f / 255);
  let page: PDFPage = pdf.addPage([W, H]);
  const tag = new PageTagger(pdf, page);
  const paper = (p: PDFPage) => tag.artifact(() => p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) }));
  paper(page);
  let y = H - MARGIN;
  const style = { H1: { font: semi, size: 20, gap: 10 }, H2: { font: semi, size: 13, gap: 4 }, P: { font: sans, size: 11, gap: 4 } } as const;
  const lead = (role: TagRole) => style[role].size * 1.5;
  const turn = () => {
    page = pdf.addPage([W, H]);
    tag.nextPage(page);
    paper(page);
    y = H - MARGIN;
  };
  const texts = receiptTexts(receipt);
  texts.forEach(({ role, text }, at) => {
    const { font, size, gap } = style[role];
    // A heading never stays alone at the foot of a page: it moves on with the first line under it.
    const next = texts[at + 1];
    if (role !== "P" && next && y - lead(role) - lead(next.role) < MARGIN) turn();
    if (role === "H2") y -= 8;
    const lines = wrap(font, text, size, WIDTH);
    let from = 0;
    while (from < lines.length) {
      if (y - lead(role) < MARGIN) turn();
      // As many of its lines as this page holds, as one element: a line of the receipt is read whole.
      const room = Math.max(1, Math.floor((y - MARGIN) / lead(role)));
      const chunk = lines.slice(from, from + room);
      const current = page;
      const top = y;
      tag.text(role, () => chunk.forEach((line, i) => current.drawText(line, { x: MARGIN, y: top - lead(role) * (i + 1), size, font, color: ink })));
      y -= lead(role) * chunk.length;
      from += chunk.length;
    }
    y -= gap;
  });
  tag.finish({ title: receiptTitle(receipt), author: receipt.sellerName, producer: "Marktmorgen", lang: RECEIPT_LANG, at: new Date(receipt.paidAt * 1000) });
  return pdf.save();
}
