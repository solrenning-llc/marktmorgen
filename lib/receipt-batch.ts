/**
 * A store's receipts for some days of one month, in one ZIP (601 [KB22],
 * unit U3): for the creator's books or their accountant.
 *
 * Counted, then made. The store's complete checkouts in the days asked are
 * listed from its own Stripe account, at most RECEIPT_LIST_PAGES pages, with
 * each payment and charge expanded; its one-time paid sales are counted, and
 * past RECEIPT_BATCH_MAX the download is refused with the count before any
 * sale is read further or numbered. Then each sale's lines are read, a few
 * side by side, and its receipt is the one-sale receipt (lib/receipt-pdf.ts,
 * U1) with the store's number (lib/receipt-number.ts, U2): numbers already
 * given are kept, new ones follow the order the sales were paid in. The ZIP
 * lists the receipts in number order, under RECEIPT_BATCH_MAX_BYTES.
 *
 * Nothing is presented as complete when it is not. A list Stripe did not
 * answer, a row of it that cannot be read, or more checkouts than the pages
 * read make no file at all. A sale counted and not made (refunded in full,
 * disputed, a figure unknown, Stripe not answering for it, no time left to
 * read it) is named in not-included.txt with its reason. A number that
 * cannot be read, or the run reaching its hard stop, makes no file.
 *
 * Its cost is a bounded shape, RECEIPT_BATCH_SHAPE, paid by
 * RECEIPT_BATCH_UNITS of the store's studio requests taken before Stripe is
 * read (app/api/store/receipt-batch/route.ts; tests/kb22-receipt-batch.test.ts
 * and the registry's RECEIPT_BATCH_COST).
 */
import type { ReadShape } from "@/lib/read-ceilings";
import { type Store, saleHandles } from "@/lib/store";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { STRIPE_LIST_VERSION, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import {
  RECEIPT_LINES_PAGE,
  RECEIPT_PDF_MAX_BYTES,
  RECEIPT_REFERENCE,
  RECEIPT_STRIPE_TIMEOUT_MS,
  type Receipt,
  type ReceiptRead,
  type Seller,
  receiptDrawable,
  receiptFrom,
  receiptPdf,
} from "@/lib/receipt-pdf";
import { RECEIPT_NUMBER_BYTES, RECEIPT_NUMBER_COMMANDS, RECEIPT_NUMBER_MAX, assignReceiptNumber, receiptNumberText } from "@/lib/receipt-number";
import {
  LEFT_OUT_MAX_BYTES,
  LEFT_OUT_FILE,
  RECEIPT_BATCH_MAX,
  RECEIPT_BATCH_READS_AT_ONCE,
  RECEIPT_BATCH_SECONDS,
  RECEIPT_ENTRY_NAME_MAX,
  RECEIPT_LIST_LOOKBACK_SECONDS,
  RECEIPT_LIST_PAGES,
  RECEIPT_LIST_PAGE_SIZE,
  type ReceiptRange,
  type SkipReason,
  ZIP_END_BYTES,
  ZIP_ENTRY_BYTES,
  notIncludedText,
  zipStored,
} from "@/lib/receipt-batch-rules";

/** The ZIP at its largest: every receipt at its heaviest, and not-included.txt at its longest. */
export const RECEIPT_BATCH_MAX_BYTES =
  RECEIPT_BATCH_MAX * (RECEIPT_PDF_MAX_BYTES + ZIP_ENTRY_BYTES(RECEIPT_ENTRY_NAME_MAX)) +
  LEFT_OUT_MAX_BYTES + ZIP_ENTRY_BYTES(LEFT_OUT_FILE.length) + ZIP_END_BYTES;

/**
 * A download at its worst, as lib/read-ceilings.ts shapes a read: the whole
 * run held at 2 GB and all of it on the CPU; the studio's own forty commands
 * and every receipt numbered (RECEIPT_NUMBER_COMMANDS, the room read and
 * written twice over, as tests/kb22-receipt-number.test.ts prices one); the
 * fullest ZIP sent; and every page of the list and every sale's lines priced
 * as a page waited on, one after another, though they are read side by side.
 */
export const RECEIPT_BATCH_SHAPE: ReadShape = {
  seconds: RECEIPT_BATCH_SECONDS,
  cpu: RECEIPT_BATCH_SECONDS,
  commands: 40 + RECEIPT_BATCH_MAX * RECEIPT_NUMBER_COMMANDS,
  dbBytes: 200_000 + RECEIPT_BATCH_MAX * 2 * RECEIPT_NUMBER_BYTES,
  outBytes: RECEIPT_BATCH_MAX_BYTES,
  stripePages: RECEIPT_LIST_PAGES + RECEIPT_BATCH_MAX,
};
/** The studio requests one download takes, all before Stripe is read: at least the shape's cost (tests/kb22-receipt-batch.test.ts). */
export const RECEIPT_BATCH_UNITS = 70;

/** The clock a download runs on: reads start only before `readsUntil` (less a read's wait); numbering and drawing stop at `stopAt`. */
export type BatchClock = { now: () => number; readsUntil: number; stopAt: number; afterRound?: () => void };

export type ReceiptBatch =
  | { ok: true; zip: Uint8Array; name: string; included: number; skipped: { reference: string; why: SkipReason }[] }
  | { ok: false; status: number; message: string };

type Candidate = { reference: string; row: Record<string, unknown> };
type Listed = { ok: true; candidates: Candidate[] } | { ok: false; why: "over"; count: number } | { ok: false; why: "too_many" | "unreadable" | "stripe" };

function field(object: unknown, name: string): unknown {
  return plainObject(object) ? ownField(object, name) : undefined;
}

/**
 * Whether a listed checkout is one of the store's one-time paid sales in
 * the days asked; "unreadable" when the row cannot say. A sale whose charge
 * time cannot be read is counted, so its receipt is refused by name and
 * never left out unseen.
 */
function saleIn(row: Record<string, unknown>, handles: Set<string>, range: { from: number; to: number }): boolean | "unreadable" {
  const metadata = ownField(row, "metadata");
  const mode = ownField(row, "mode");
  const paid = ownField(row, "payment_status");
  if (!plainObject(metadata) || typeof mode !== "string" || typeof paid !== "string") return "unreadable";
  const store = ownField(metadata, "store");
  if (typeof store !== "string" || !handles.has(store)) return false;
  if (mode !== "payment" || paid !== "paid" || ownField(row, "amount_total") === 0) return false;
  const at = field(field(ownField(row, "payment_intent"), "latest_charge"), "created");
  if (typeof at === "number" && Number.isSafeInteger(at)) return at >= range.from && at < range.to;
  return true;
}

/** The store's one-time paid sales in the days asked, counted from at most RECEIPT_LIST_PAGES pages. */
async function listSales(account: string, handles: Set<string>, range: { from: number; to: number }, clock: BatchClock): Promise<Listed> {
  const candidates: Candidate[] = [];
  const base =
    `/checkout/sessions?limit=${RECEIPT_LIST_PAGE_SIZE}&status=complete&created[gte]=${range.from - RECEIPT_LIST_LOOKBACK_SECONDS}` +
    `&created[lt]=${range.to}&expand[]=data.payment_intent.latest_charge`;
  let after = "";
  for (let page = 0; page < RECEIPT_LIST_PAGES; page += 1) {
    if (clock.readsUntil - clock.now() < RECEIPT_STRIPE_TIMEOUT_MS) return { ok: false, why: "stripe" };
    let raw: unknown;
    try {
      raw = await onAccount("GET", account, `${base}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`, undefined, STRIPE_LIST_VERSION, undefined, RECEIPT_STRIPE_TIMEOUT_MS);
    } catch (error) {
      console.error("listing a store's sales for receipts failed", error);
      return { ok: false, why: "stripe" };
    }
    let read;
    try {
      read = readStripePage(raw, () => true, RECEIPT_REFERENCE);
    } catch {
      return { ok: false, why: "unreadable" };
    }
    if (read.unreadable > 0) return { ok: false, why: "unreadable" };
    for (const row of read.rows) {
      const inside = saleIn(row, handles, range);
      if (inside === "unreadable") return { ok: false, why: "unreadable" };
      if (inside) candidates.push({ reference: row.id, row });
    }
    if (!read.hasMore) return candidates.length > RECEIPT_BATCH_MAX ? { ok: false, why: "over", count: candidates.length } : { ok: true, candidates };
    if (!read.lastId) return { ok: false, why: "unreadable" };
    after = read.lastId;
  }
  return { ok: false, why: "too_many" };
}

/** One sale's receipt, from its listed checkout and its lines read now. */
async function readOne(account: string, seller: Seller, sale: Candidate): Promise<ReceiptRead | "stripe"> {
  try {
    const lines = await onAccount(
      "GET", account, `/checkout/sessions/${encodeURIComponent(sale.reference)}/line_items?limit=${RECEIPT_LINES_PAGE}`,
      undefined, STRIPE_LIST_VERSION, undefined, RECEIPT_STRIPE_TIMEOUT_MS,
    );
    return receiptFrom(seller, sale.reference, sale.row, lines);
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return { ok: false, why: "unknown" };
    console.error("reading a sale's lines for its receipt failed", error);
    return "stripe";
  }
}

const numberOf = (text: string) => Number(text.slice(2));

/** The download: refused with words, or the ZIP and what it left out. Studio requests are the caller's to take first. */
export async function receiptBatch(store: Store, account: string, range: Extract<ReceiptRange, { ok: true }>, clock: BatchClock): Promise<ReceiptBatch> {
  const seller: Seller = { name: store.name, address: store.mail?.address ?? null, handles: saleHandles(store) };
  const listed = await listSales(account, seller.handles, range, clock);
  if (!listed.ok) {
    switch (listed.why) {
      case "over":
        return { ok: false, status: 409, message: `There are ${listed.count} paid sales from ${range.label}. One download holds up to ${RECEIPT_BATCH_MAX} receipts: choose a shorter range, such as the 1st to the 15th, then the rest.` };
      case "too_many":
        return { ok: false, status: 409, message: `There are more checkouts from ${range.label} than one download can count. Choose a shorter range, such as the 1st to the 15th, then the rest.` };
      case "unreadable":
        return { ok: false, status: 502, message: `Some of Stripe's checkouts from ${range.label} could not be read, so no file was made. Try again later, or open them in your Stripe dashboard.` };
      case "stripe":
        return { ok: false, status: 503, message: "Stripe did not answer just now, so no file was made. Try again in a moment." };
    }
  }
  if (listed.candidates.length === 0) return { ok: false, status: 404, message: `There are no one-time paid sales on this store from ${range.label}.` };

  const skipped: { reference: string; why: SkipReason }[] = [];
  const read: Receipt[] = [];
  const sales = listed.candidates;
  for (let i = 0; i < sales.length; i += RECEIPT_BATCH_READS_AT_ONCE) {
    if (clock.readsUntil - clock.now() < RECEIPT_STRIPE_TIMEOUT_MS) {
      for (const sale of sales.slice(i)) skipped.push({ reference: sale.reference, why: "slow" });
      break;
    }
    const round = sales.slice(i, i + RECEIPT_BATCH_READS_AT_ONCE);
    const results = await Promise.all(round.map((sale) => readOne(account, seller, sale)));
    results.forEach((result, k) => {
      if (result === "stripe") skipped.push({ reference: round[k].reference, why: "stripe" });
      else if (!result.ok) skipped.push({ reference: round[k].reference, why: result.why });
      else read.push(result.receipt);
    });
    clock.afterRound?.();
  }

  // Asked with the longest number, so a sale whose receipt cannot be drawn is never given one.
  const drawable: Receipt[] = [];
  for (const receipt of read) {
    if (await receiptDrawable({ ...receipt, number: receiptNumberText(RECEIPT_NUMBER_MAX) })) drawable.push(receipt);
    else skipped.push({ reference: receipt.reference, why: "undrawable" });
  }
  // New numbers follow the order the sales were paid in; a sale numbered before keeps its own.
  drawable.sort((a, b) => a.paidAt - b.paidAt || (a.reference < b.reference ? -1 : 1));
  const tooLong: ReceiptBatch = { ok: false, status: 503, message: "This download took too long, so no file was made. Choose fewer days, or try again." };
  const files: { number: string; bytes: Uint8Array }[] = [];
  for (const receipt of drawable) {
    if (clock.now() >= clock.stopAt) return tooLong;
    const numbered = await assignReceiptNumber(store, receipt.reference);
    if (!numbered.ok) {
      if (numbered.reason === "full") {
        skipped.push({ reference: receipt.reference, why: "full" });
        continue;
      }
      return { ok: false, status: 503, message: "Receipt numbers could not be read just now, so no file was made. Try again in a moment." };
    }
    if (clock.now() >= clock.stopAt) return tooLong;
    const bytes = await receiptPdf({ ...receipt, number: numbered.number });
    if (bytes.byteLength > RECEIPT_PDF_MAX_BYTES) {
      console.error("a receipt came out heavier than its ceiling", bytes.byteLength);
      skipped.push({ reference: receipt.reference, why: "heavy" });
      continue;
    }
    files.push({ number: numbered.number, bytes });
  }
  files.sort((a, b) => numberOf(a.number) - numberOf(b.number));
  const entries = files.map((f) => ({ name: `receipt-${f.number}.pdf`, bytes: f.bytes }));
  if (skipped.length > 0) entries.push({ name: LEFT_OUT_FILE, bytes: new TextEncoder().encode(notIncludedText(range.label, skipped, files.length)) });
  const zip = zipStored(entries, new Date());
  if (zip.byteLength > RECEIPT_BATCH_MAX_BYTES) {
    console.error("a receipts download came out heavier than its ceiling", zip.byteLength);
    return { ok: false, status: 500, message: "This download could not be made. Choose fewer days, or download receipts one by one." };
  }
  return { ok: true, zip, name: `receipts-${range.slug}.zip`, included: files.length, skipped };
}
