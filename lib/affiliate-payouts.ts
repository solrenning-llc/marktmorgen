/**
 * Preparing an affiliate payout: the file the creator uploads to their own
 * PayPal or Wise, and the record of having paid.
 *
 * The rule from lib/affiliates.ts does not bend here. Marktmorgen never holds,
 * moves or pays out any of this money. What this file does is turn what the
 * book says is owed into a batch file shaped the way the creator's own
 * provider reads it, so paying twenty affiliates is one upload instead of
 * twenty transfers typed by hand. The money leaves the creator's own account,
 * the creator confirms it in their own provider, and only then is it written
 * down here as paid.
 *
 * That is the whole difference from a platform that pays affiliates "for
 * you": those pay out of money they are already holding, which is why their
 * creators have to wait for a payout in the first place. Here the money never
 * left the creator, so there is nothing to wait for — only a file to hand to
 * the provider they already use.
 *
 * Two files are built, because the two providers do not read the same shape:
 *
 *   - PayPal Payouts, exactly as PayPal's own documentation writes it: no
 *     header row, the columns in their order, one currency per file, a
 *     period for the decimal in USD, CAD and GBP and a comma inside quotes
 *     for the rest, and at most 5000 rows. Uploaded to PayPal as it is.
 *   - a payout worksheet, with a header, for Wise and for a bank transfer.
 *     Wise will only read a file built from the template it gives you, so
 *     this one is for pasting into that template — and it leaves the
 *     recipient's name blank, because Marktmorgen never asks an affiliate for the
 *     name on their bank account and will not invent one.
 *
 * Nothing here decides what is owed: that is lib/affiliates.ts readBook, which
 * works it out against the refunds on the creator's Stripe account. Only
 * affiliates owed more than nothing, in the store's own currency, are in a
 * file — an affiliate whose sales were in a currency the store has since
 * changed away from is left out of the totals there, and so is left out here.
 */
import { MAX_REFERENCE_LENGTH, type Affiliate, type Book, type Row, addPayout, payAddress } from "@/lib/affiliates";
import { csvCell } from "@/lib/csv";
import { plainAmount } from "@/lib/money";
import type { Store } from "@/lib/store";

/** PayPal reads at most this many rows from one file. */
export const MAX_BATCH_ROWS = 5000;

/** The providers a batch file can be built for. */
export type BatchProvider = "paypal" | "worksheet";

export type BatchLine = {
  affiliate: Affiliate;
  /** In the currency's smallest unit; always above zero. */
  cents: number;
};

/**
 * Who can be paid today, most owed first, capped at what one file holds.
 *
 * `payable`, not `owed`: a sale still inside the creator's wait is owed but
 * not yet payable, so that their refund window passes before the money leaves
 * them. A store that set no wait has the two equal, and this is the same list
 * it always was. `payable` can be below zero when refunds landed after a
 * payout; that is money to come back, not a payment, and is left out.
 */
export function owedLines(book: Book): BatchLine[] {
  return book.rows
    .filter((row: Row) => row.payable > 0 && row.affiliate.status === "approved")
    .sort((a, b) => b.payable - a.payable)
    .slice(0, MAX_BATCH_ROWS)
    .map((row) => ({ affiliate: row.affiliate, cents: row.payable }));
}

/** What the whole batch comes to, in the currency's smallest unit. */
export function batchTotal(lines: BatchLine[]): number {
  return lines.reduce((sum, line) => sum + line.cents, 0);
}

/**
 * An amount the way PayPal's uploader reads it: "100.5" for the currencies
 * its documentation writes with a period, and "100,50" in quotes for the
 * rest. Following the documentation rather than guessing is the point — a
 * file it cannot read is worse than no file.
 */
function paypalAmount(cents: number, currency: string): string {
  const plain = plainAmount(cents, currency);
  const period = new Set(["USD", "CAD", "GBP"]);
  if (period.has(currency.toUpperCase())) return plain;
  return `"${plain.replace(".", ",")}"`;
}

/**
 * A cell a spreadsheet reads back as text, never as a formula: the platform's
 * one cell rule (lib/csv.ts csvCell), always quoted. The PayPal amount is built
 * apart (paypalAmount), and the currency and wallet columns are fixed words.
 */
function cell(value: string): string {
  return csvCell(value);
}

/**
 * The note that travels with each payment, so an affiliate opening their
 * PayPal knows what it is for without asking.
 */
export function payoutNote(store: Store): string {
  return `Affiliate commission from ${store.name}`.slice(0, 120);
}

/**
 * The PayPal Payouts file, exactly as PayPal documents it: recipient, amount,
 * currency, an id of the creator's own, the note, and the wallet. No header
 * row, because PayPal's own sample has none.
 */
export function paypalCsv(lines: BatchLine[], currency: string, note: string): string {
  const code = currency.toUpperCase();
  return (
    lines
      .map((line) =>
        [
          cell(payAddress(line.affiliate)),
          paypalAmount(line.cents, currency),
          code,
          cell(line.affiliate.code),
          cell(note),
          "PAYPAL",
        ].join(","),
      )
      .join("\r\n") + "\r\n"
  );
}

/**
 * The worksheet, for Wise's own template and for a bank transfer. The name
 * column is deliberately empty: Wise wants the name on the recipient's bank
 * account, and Marktmorgen never asked the affiliate for it.
 */
export function worksheetCsv(lines: BatchLine[], currency: string, note: string): string {
  const code = currency.toUpperCase();
  const header = [
    "name",
    "email",
    "amount",
    "sourceCurrency",
    "targetCurrency",
    "amountCurrency",
    "paymentReference",
    "affiliate_code",
  ];
  const rows = lines.map((line) => [
    "",
    line.affiliate.email,
    plainAmount(line.cents, currency),
    code,
    code,
    "source",
    note,
    line.affiliate.code,
  ]);
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** The file for one provider, with the name it should be saved under. */
export function batchFile(
  provider: BatchProvider,
  lines: BatchLine[],
  store: Store,
  day: string,
): { body: string; filename: string } {
  const note = payoutNote(store);
  if (provider === "paypal") {
    return {
      body: paypalCsv(lines, store.currency, note),
      filename: `paypal-payouts-${store.handle}-${day}.csv`,
    };
  }
  return {
    body: worksheetCsv(lines, store.currency, note),
    filename: `affiliate-payouts-${store.handle}-${day}.csv`,
  };
}

export type RecordedBatch = {
  /** How many payouts were written down. */
  written: number;
  /** In the currency's smallest unit. */
  cents: number;
  /** Anyone the book no longer says is owed anything, so nothing was written. */
  skipped: string[];
};

/**
 * Writes down a batch the creator has just paid in their own provider.
 *
 * It is deliberately a second step, after the upload, and never automatic:
 * the file being downloaded proves nothing about money having moved, and a
 * book that says "paid" when nobody was paid is worse than one that says
 * nothing. Each line is checked against what the book says is owed at this
 * moment, so a sale refunded between the download and the confirmation is not
 * paid out on.
 */
export async function recordBatch(
  store: Store,
  book: Book,
  input: { date: string; reference: string },
  /** Affiliates with a PayPal payment on its way (lib/paypal-payouts.ts): never written down twice. */
  away: Set<string> = new Set(),
): Promise<RecordedBatch> {
  const lines = owedLines(book).filter((line) => !away.has(line.affiliate.id));
  const reference = input.reference.replace(/\s+/g, " ").trim().slice(0, MAX_REFERENCE_LENGTH);
  let written = 0;
  let cents = 0;
  const skipped: string[] = [];
  for (const line of lines) {
    const payout = await addPayout(store, {
      aff: line.affiliate.id,
      cents: line.cents,
      currency: store.currency,
      date: input.date,
      reference,
    });
    if (payout) {
      written += 1;
      cents += line.cents;
    } else {
      skipped.push(line.affiliate.email);
    }
  }
  return { written, cents, skipped };
}
