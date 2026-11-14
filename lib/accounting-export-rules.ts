/**
 * A store's sales as a file an accounting app imports (queue item 37 [F6],
 * 6 November 2026): Xero's sales-invoice import or QuickBooks Online's
 * invoice import. Pure, so the studio's form and the server agree on the
 * periods, and the file is checked without any service.
 *
 * The shape, and why:
 *
 *   - One invoice for each UTC day and currency, one line for each product
 *     sold that day, under one fixed contact (ACCOUNTING_CONTACT). Both apps
 *     cap what one import takes (APP_IMPORT_CAPS), so an invoice for every
 *     sale would stop a busy month from importing at all; and no buyer's
 *     name or address leaves for the accounting app. The store's own sales
 *     file (Your numbers) keeps every sale, buyer by buyer.
 *   - Only whole UTC days that are over, so the same invoice number never
 *     comes out twice with two different totals; invoice numbers are the
 *     day and the currency (MM-20261003-USD), at most 21 characters, the
 *     longest QuickBooks takes, so importing a day again shows up as a
 *     number already used instead of a second copy.
 *   - Each line's amount is what was paid after any discount and without
 *     the tax the buyer paid, and that tax is in its own column (import as
 *     "tax exclusive"). Amounts are written from whole cents, never through
 *     a floating-point division, and never negative: refunds and Stripe's
 *     fees are not sales, and are in Stripe's own reports.
 *   - A file past an app's limit is refused with its count, never cut short:
 *     a file with sales missing would put wrong totals in the books.
 *   - Every cell goes through lib/csv.ts csvCell: quoted, a quote written
 *     twice, and a cell starting with =, +, -, @, a tab or a carriage
 *     return gets a ' in front so a spreadsheet never runs it as a formula.
 *     The route adds the UTF-8 byte-order mark, as the studio's other files.
 *
 * The formats, as read on 6 November 2026 (this session's network did not
 * reach central.xero.com or quickbooks.intuit.com, so the pages were read
 * through their search-engine extracts; confirm against the template each
 * app downloads before calling the files verified):
 *
 *   - Xero, "Import customer invoices",
 *     https://central.xero.com/0/article/Import-customer-invoices : the
 *     template is downloaded from Sales > Invoices > Import; ContactName and
 *     InvoiceNumber are the only columns required for drafts, columns with
 *     a * are needed to approve; rows sharing an invoice number are one
 *     invoice; imported invoices are drafts; headings are not to be renamed
 *     or reordered. The 500-row limit is from third-party guides of the
 *     same date, kept as the lower bound until Xero's page is read in full.
 *   - QuickBooks Online, "Import multiple invoices at once",
 *     https://quickbooks.intuit.com/learn-support/en-us/help-article/import-export-data-files/import-multiple-invoices/L7E9Xrd8l_US_en_US :
 *     Settings > Import data > Invoices; each line needs invoice number,
 *     customer, invoice date, due date, item amount and item tax code; up to
 *     1,000 rows a file and 100 invoices at a time; negative charges are not
 *     supported; columns are matched to QuickBooks' fields when importing,
 *     and tax is chosen there as exclusive or inclusive.
 */
import { csvCell } from "@/lib/csv";
import { decimalsOf } from "@/lib/money";

export type AccountingApp = "xero" | "quickbooks";

/** The one contact every invoice is made out to: the store's online sales, never a buyer. */
export const ACCOUNTING_CONTACT = "Online customers";
/** What the invoice's reference (Xero) or memo (QuickBooks) says it is. */
export const ACCOUNTING_REFERENCE = "Marktmorgen sales";
/** The product or service QuickBooks books each line to (it makes one by this name when there is none). */
export const QUICKBOOKS_ITEM = "Sales";

/** Lines and invoices one import of each app takes (see the sources above). */
export const APP_IMPORT_CAPS: Record<AccountingApp, { rows: number; invoices: number }> = {
  xero: { rows: 500, invoices: 500 },
  quickbooks: { rows: 1000, invoices: 100 },
};

/** Xero's sales-invoice template, every column in its order; * marks those needed to approve. */
export const XERO_HEADER = [
  "*ContactName", "EmailAddress", "POAddressLine1", "POAddressLine2", "POAddressLine3", "POAddressLine4", "POCity", "PORegion", "POPostalCode", "POCountry",
  "*InvoiceNumber", "Reference", "*InvoiceDate", "*DueDate", "Total", "InventoryItemCode", "*Description", "*Quantity", "*UnitAmount", "Discount",
  "*AccountCode", "*TaxType", "TaxAmount", "TrackingName1", "TrackingOption1", "TrackingName2", "TrackingOption2", "Currency", "BrandingTheme",
] as const;

/** The columns of the QuickBooks file, named as QuickBooks' own invoice fields; they are matched when importing. */
export const QUICKBOOKS_HEADER = [
  "InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "ItemTaxCode", "ItemTaxAmount", "Currency",
] as const;

/** How many months back a file can be made: PayPal sales are kept 400 days (lib/paypal-sales.ts). */
export const ACCOUNTING_MONTHS = 12;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY = 86_400;

/** A period a file covers: from (inclusive) to (exclusive), in seconds, on whole UTC days. */
export type AccountingPeriod = { from: number; to: number; slug: string; label: string };

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The period for a month ("2026-10") and a half ("" the whole month, "1"
 * the 1st to the 15th, "2" the 16th to its last day), among the last
 * ACCOUNTING_MONTHS, ending where the last whole UTC day before `now` ends.
 * Null when it is not one of those, or has no whole day yet.
 */
export function accountingPeriod(month: string, half: string, now: number): AccountingPeriod | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match || !["", "1", "2"].includes(half)) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  if (index < 0 || index > 11) return null;
  const today = new Date(now);
  const months = (today.getUTCFullYear() - year) * 12 + (today.getUTCMonth() - index);
  if (months < 0 || months >= ACCOUNTING_MONTHS) return null;
  const last = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  const firstDay = half === "2" ? 16 : 1;
  const endDay = half === "1" ? 15 : last;
  const from = Date.UTC(year, index, firstDay) / 1000;
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 1000;
  const to = Math.min(Date.UTC(year, index, endDay + 1) / 1000, startOfToday);
  if (to <= from) return null;
  const toDay = new Date((to - DAY) * 1000).getUTCDate();
  const whole = firstDay === 1 && toDay === last;
  const name = MONTH_NAMES[index];
  const soFar = toDay !== endDay;
  return {
    from,
    to,
    slug: whole ? `${year}-${pad(index + 1)}` : `${year}-${pad(index + 1)}-${pad(firstDay)}-to-${pad(toDay)}`,
    label: whole ? `${name} ${year}` : `${name} ${firstDay}–${toDay}, ${year}${soFar ? " (so far)" : ""}`,
  };
}

/** The months the studio's form offers, newest first. */
export function accountingMonths(now: number): { value: string; label: string }[] {
  const today = new Date(now);
  const out: { value: string; label: string }[] = [];
  for (let back = 0; back < ACCOUNTING_MONTHS; back += 1) {
    const at = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
    out.push({ value: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}`, label: `${MONTH_NAMES[at.getUTCMonth()]} ${at.getUTCFullYear()}` });
  }
  return out;
}

/**
 * An amount in a currency's smallest unit, written exactly in its major unit
 * (4900 cents "49.00", 4900 yen "4900", 12345 fils "12.345"); null for
 * anything but a whole number from zero up.
 */
export function exactAmount(amount: number, currency: string): string | null {
  if (!Number.isSafeInteger(amount) || amount < 0) return null;
  const decimals = decimalsOf(currency);
  if (decimals === 0) return String(amount);
  const digits = String(amount).padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/** One paid sale, as the file needs it: when (seconds), the product, the amount without tax and the tax, in the smallest unit. */
export type AccountingSale = { at: number; product: string; title: string; currency: string; net: number; tax: number };

/** One line of an invoice: a product's sales of one UTC day in one currency. */
export type AccountingLine = { invoice: string; date: string; currency: string; description: string; net: number; tax: number; count: number };

/** A product's name as one line of text: control characters made spaces. */
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

/** The sales as lines: one for each UTC day, currency and product, by date, then currency, then name. */
export function accountingLines(sales: AccountingSale[]): AccountingLine[] {
  const groups = new Map<string, { date: string; currency: string; title: string; net: number; tax: number; count: number }>();
  for (const sale of sales) {
    const date = new Date(sale.at * 1000).toISOString().slice(0, 10);
    const key = `${date}\u0000${sale.currency}\u0000${sale.product}`;
    const group = groups.get(key) ?? { date, currency: sale.currency, title: oneLine(sale.title) || "Sale", net: 0, tax: 0, count: 0 };
    group.net += sale.net;
    group.tax += sale.tax;
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({
      invoice: `MM-${g.date.replace(/-/g, "")}-${g.currency.toUpperCase()}`,
      date: g.date,
      currency: g.currency,
      description: `${g.title} (${g.count} ${g.count === 1 ? "sale" : "sales"})`,
      net: g.net,
      tax: g.tax,
      count: g.count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency) || a.description.localeCompare(b.description));
}

/** An account code as Xero takes one: letters and digits, up to ten; "" for none; null for anything else. */
export function cleanAccountCode(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return "";
  return /^[A-Za-z0-9][A-Za-z0-9 ._]{0,9}$/.test(text) ? text : null;
}

/** A tax rate's name as the accounting app shows it: plain words, up to fifty; "" for none; null for anything else. */
export function cleanTaxName(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return "";
  return /^[A-Za-z0-9][A-Za-z0-9 %().,&/-]{0,49}$/.test(text) ? text : null;
}

/** MM/DD/YYYY, the date both imports read for a US company. */
const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

export type AccountingFile = { ok: true; csv: string; rows: number; invoices: number } | { ok: false; reason: "too_big" | "amount"; rows: number; invoices: number };

/**
 * The file for one app: its header and a row for each line, CRLF between
 * rows. Refused, never shortened, past the app's limits; refused when an
 * amount cannot be written exactly.
 */
export function accountingFile(app: AccountingApp, lines: AccountingLine[], options: { account: string; tax: string }): AccountingFile {
  const rows = lines.length;
  const invoices = new Set(lines.map((line) => line.invoice)).size;
  const limit = APP_IMPORT_CAPS[app];
  if (rows > limit.rows || invoices > limit.invoices) return { ok: false, reason: "too_big", rows, invoices };
  const out = [(app === "xero" ? XERO_HEADER : QUICKBOOKS_HEADER).map(csvCell).join(",")];
  for (const line of lines) {
    const net = exactAmount(line.net, line.currency);
    const tax = exactAmount(line.tax, line.currency);
    if (net === null || tax === null) return { ok: false, reason: "amount", rows, invoices };
    const date = usDate(line.date);
    const currency = line.currency.toUpperCase();
    const cells =
      app === "xero"
        ? [ACCOUNTING_CONTACT, "", "", "", "", "", "", "", "", "", line.invoice, ACCOUNTING_REFERENCE, date, date, "", "", line.description, "1", net, "", options.account, options.tax, tax, "", "", "", "", currency, ""]
        : [line.invoice, ACCOUNTING_CONTACT, date, date, ACCOUNTING_REFERENCE, QUICKBOOKS_ITEM, line.description, "1", net, net, options.tax, tax, currency];
    out.push(cells.map(csvCell).join(","));
  }
  return { ok: true, csv: `${out.join("\r\n")}\r\n`, rows, invoices };
}
