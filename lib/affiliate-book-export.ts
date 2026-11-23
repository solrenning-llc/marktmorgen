/**
 * What the affiliate programme's spreadsheet costs (app/api/store/affiliates/export/route.ts), taken before the book is
 * read (#5010 row 150, route envelope sweep 2f36; coordinators 5d3c and ca62). The file reads the whole book
 * (lib/affiliates.ts readBook: seven records whole, its PayPal refunds, the moves of open bookings, the invoices kept
 * between readings, up to BOOK_STRIPE_PAGES of the creator's Stripe account) and every affiliate again
 * (listAffiliates), and sends a line for each sale, lead, share, payout and invoice. Nothing caps its rows but the
 * store's data room, so it took one essential request whatever the programme's size.
 *
 * While a plan runs it now takes, from the store's studio figure and before anything is read, the units of that work at
 * the programme's size, counted first (lib/affiliates.ts bookSizes) as bookWork counts a reading of the book, at the
 * unit of a whole store export (lib/store-export.ts: EXPORT_COMMANDS_PER_UNIT commands, EXPORT_BYTES_PER_UNIT bytes,
 * and the wait on Stripe's pages as EXPORT_WAIT_UNITS covers a whole export's). Once the plan has ended, the store has
 * ENDED_BOOK_EXPORTS of its own instead (lib/plan-closing-rules.ts), never taken from a figure, priced with its
 * closing (tests/plan-cost-registry.ts, closureCost). tests/affiliate-book-export-cost.test.ts holds the units above
 * the file's cost at every size.
 */
import { type BookSizes, type ReadWork, AFFILIATE_ENTRY_BYTES, BOOK_INVOICES_KEPT_LINES, addWork, bookWork } from "@/lib/api-read-rules";
import { BOOK_STRIPE_PAGES } from "@/lib/affiliates";
import { EXPORT_BYTES_PER_UNIT, EXPORT_COMMANDS_PER_UNIT, EXPORT_STRIPE_PAGES, EXPORT_WAIT_UNITS } from "@/lib/store-export";
import { DATA_ROOM_BYTES } from "@/lib/store-data-rules";

/**
 * The most bytes one line of the spreadsheet takes (lib/affiliates.ts bookCsv): an affiliate's address and code, a
 * reference, a product's title, amounts, a status, a payout's note and a campaign, each quoted. A line never carries
 * more than the record it comes from, so it is held at the largest entry of any of the programme's records.
 */
export const BOOK_CSV_LINE_BYTES = AFFILIATE_ENTRY_BYTES;
/** The spreadsheet's header line, with room. */
export const BOOK_CSV_HEADER_BYTES = 1_024;
/**
 * The most the programme's seven records can weigh: they are kept in the store's data room (lib/data-families.ts,
 * the affiliate family), and a store keeps what it already has when its plan gets smaller, so at the largest room any plan has.
 * Holding each entry at AFFILIATE_ENTRY_BYTES past this would ask more than any studio figure holds, and a large
 * programme could never be downloaded (coordinator ca62, condition 2); the records cannot weigh more than this.
 */
export const BOOK_RECORDS_MAX_BYTES = Math.max(...Object.values(DATA_ROOM_BYTES));

/**
 * What the spreadsheet does at a programme of these sizes, at the most: the book read as bookWork counts it (the
 * invoices kept between readings included, so the reading says it was counted ahead: readBook's keptPaid), every
 * affiliate read again (one HGETALL), and a line sent for every entry and every invoice kept.
 */
export function bookExportWork(sizes: BookSizes): ReadWork {
  const book = bookWork(sizes, BOOK_STRIPE_PAGES);
  if (!sizes.kept) return book;
  const invoices = sizes.stripe && sizes.people > 0 ? BOOK_INVOICES_KEPT_LINES : 0;
  // The seven records at an entry's largest, but never more than the room they are kept in can hold.
  const records = sizes.entries * AFFILIATE_ENTRY_BYTES;
  const over = Math.max(0, records - BOOK_RECORDS_MAX_BYTES);
  return addWork(
    { ...book, bytes: book.bytes - over },
    {
      commands: 1,
      bytes: Math.min(sizes.people * AFFILIATE_ENTRY_BYTES, BOOK_RECORDS_MAX_BYTES),
      // A line is never more than the record it comes from, so the lines of the records weigh no more than they do.
      sent: BOOK_CSV_HEADER_BYTES + Math.min(sizes.entries * BOOK_CSV_LINE_BYTES, BOOK_RECORDS_MAX_BYTES) + invoices * BOOK_CSV_LINE_BYTES,
      roundTrips: 1,
    },
  );
}

/**
 * The studio units a spreadsheet of this work takes: one for the request, its commands and every byte it reads and
 * sends at the unit of a whole store export, and its wait on Stripe's pages at the share of EXPORT_WAIT_UNITS a page of
 * a whole export's is (one list of EXPORT_STRIPE_PAGES / 2 pages, waited on).
 */
export function bookExportWorkUnits(w: ReadWork): number {
  const waitPerPage = EXPORT_WAIT_UNITS / (EXPORT_STRIPE_PAGES / 2);
  return 1 + Math.ceil(w.commands / EXPORT_COMMANDS_PER_UNIT) + Math.ceil((w.bytes + w.sent) / EXPORT_BYTES_PER_UNIT) + Math.ceil(w.stripePages * waitPerPage);
}

/**
 * The studio units held before the spreadsheet reads, at a programme of these sizes: its work at the most, the file
 * at a line for every entry and every invoice kept. Once the file is made, what its real size did not need is given
 * back (bookExportSettled); nothing else is, since what was read is not measured.
 */
export function bookExportUnits(sizes: BookSizes): number {
  return bookExportWorkUnits(bookExportWork(sizes));
}

/** The units the spreadsheet keeps once its file is made: its work at the most, with the file at its real size in bytes. */
export function bookExportSettled(sizes: BookSizes, sentBytes: number): number {
  const w = bookExportWork(sizes);
  return Math.min(bookExportWorkUnits(w), bookExportWorkUnits({ ...w, sent: Math.max(0, Math.ceil(sentBytes)) }));
}
