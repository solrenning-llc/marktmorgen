/**
 * The rules of a receipts download (601 [KB22], unit U3), with nothing that
 * reads or draws: which days may be asked for, how many receipts one file
 * holds, the ZIP itself and the sentence for each sale left out. Kept apart
 * from lib/receipt-batch.ts so the studio page can say the cap without
 * loading the PDF code.
 */
import type { ReceiptRefusal } from "@/lib/receipt-pdf";

/**
 * The most receipts one download holds. Counted from the list before any
 * sale is read, so a month with more is refused with its count and the
 * creator asks for fewer days. Each receipt is one read of Stripe and one
 * PDF drawn inside one function run (RECEIPT_BATCH_SECONDS).
 */
export const RECEIPT_BATCH_MAX = 50;
/** Pages of the store's checkouts read to count them, a hundred each: past them the days asked hold too many to count. */
export const RECEIPT_LIST_PAGES = 5;
export const RECEIPT_LIST_PAGE_SIZE = 100;
/** How many sales' lines are read side by side. */
export const RECEIPT_BATCH_READS_AT_ONCE = 5;
/** The longest one download may run (the route's maxDuration, which has to be written there as a number). */
export const RECEIPT_BATCH_SECONDS = 60;
/** Reads start only while this much time is left, to number, draw, zip and send what was read. */
export const RECEIPT_BATCH_RESERVE_SECONDS = 15;
/** Numbering and drawing stop, and nothing is sent, when only this much time is left. */
export const RECEIPT_BATCH_STOP_SECONDS = 3;
/**
 * The list is read from a day before the first day asked: a checkout stays
 * open at most a day (Stripe's expires_at), so one opened the evening before
 * and paid after midnight is still found. Which days a sale belongs to is
 * the day its charge was made.
 */
export const RECEIPT_LIST_LOOKBACK_SECONDS = 86_400;
/** The file that names each sale with no receipt in the download. */
export const LEFT_OUT_FILE = "not-included.txt";
/** The longest name a receipt has in the ZIP: "receipt-" and the longest number (lib/receipt-number.ts, RECEIPT_NUMBER_MAX). */
export const RECEIPT_ENTRY_NAME_MAX = "receipt-R-999999999999.pdf".length;
/** What the ZIP adds to each file: its local header and its central entry, each with the name. */
export const ZIP_ENTRY_BYTES = (name: number) => 30 + 46 + 2 * name;
/** The ZIP's closing record. */
export const ZIP_END_BYTES = 22;
/** The longest a reason's line may be in not-included.txt: the longest reference (cs_live_ and 200), and the longest sentence below, with room. */
const LEFT_OUT_LINE_MAX = 208 + 2 + 200 + 1;
/** The text's own lines around the list, at the most. */
const LEFT_OUT_FRAME_MAX = 800;
/** not-included.txt at its largest: every sale counted left out. */
export const LEFT_OUT_MAX_BYTES = LEFT_OUT_FRAME_MAX + RECEIPT_BATCH_MAX * LEFT_OUT_LINE_MAX;

/** Why a sale counted in the days asked has no receipt in the download. */
export type SkipReason = ReceiptRefusal | "undrawable" | "slow" | "stripe" | "full" | "heavy";

export const SKIP_WORDS: Record<SkipReason, string> = {
  unknown: "not found on this store's Stripe account.",
  not_paid: "the checkout was not paid, so there is no receipt for it.",
  subscription: "a membership or a payment plan. Stripe makes an invoice for each of its payments.",
  nothing_charged: "nothing was charged, so there is no receipt for it.",
  refunded: "refunded in full, so there is no receipt for it.",
  disputed: "the payment is disputed. Its record stays in your Stripe dashboard until the dispute is closed.",
  too_many_lines: "more lines than a receipt here can hold. Open it in your Stripe dashboard.",
  unreadable: "some of Stripe's figures for this sale could not be read. Open it in your Stripe dashboard.",
  undrawable: "it has letters the PDF cannot draw. Its record is in your Stripe dashboard.",
  slow: "Stripe did not answer in time for this sale. Download its receipt on its own, or download fewer days.",
  stripe: "Stripe did not answer for this sale. Download its receipt on its own, or try again later.",
  full: "this store's room for receipt numbers is full, so it was not given a number.",
  heavy: "its file came out larger than a receipt may be. Its record is in your Stripe dashboard.",
};

export type ReceiptRange =
  | { ok: true; from: number; to: number; label: string; slug: string }
  | { ok: false; message: string };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;
const DAY_SECONDS = 86_400;

/** A day written YYYY-MM-DD, as its first second (UTC), or null when it is not a day of the calendar. */
function dayStart(text: string | null): number | null {
  const m = text ? DAY.exec(text) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const at = Date.UTC(y, mo - 1, d);
  const back = new Date(at);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return at / 1000;
}

const longDay = (seconds: number) => new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(seconds * 1000));
const isoDay = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

const ASK_AGAIN = "Choose the first and the last day, both in the same month, such as October 1 to October 31.";

/**
 * The days asked: `month=YYYY-MM`, or `from=YYYY-MM-DD&to=YYYY-MM-DD` inside
 * one month, the last day whole. In UTC, as the receipts print their dates.
 * `to` is the first second after the last day.
 */
export function receiptRange(params: URLSearchParams): ReceiptRange {
  let from: number | null;
  let last: number | null;
  const month = params.get("month");
  if (month !== null && !params.has("from") && !params.has("to")) {
    const m = MONTH.exec(month);
    from = m ? dayStart(`${m[1]}-${m[2]}-01`) : null;
    if (from === null) return { ok: false, message: ASK_AGAIN };
    const next = new Date(from * 1000);
    last = Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1) / 1000 - DAY_SECONDS;
  } else {
    from = dayStart(params.get("from"));
    last = dayStart(params.get("to"));
  }
  if (from === null || last === null) return { ok: false, message: ASK_AGAIN };
  const a = new Date(from * 1000);
  const b = new Date(last * 1000);
  if (a.getUTCFullYear() !== b.getUTCFullYear() || a.getUTCMonth() !== b.getUTCMonth()) {
    return { ok: false, message: `One download covers days inside one month. ${ASK_AGAIN}` };
  }
  if (last < from) return { ok: false, message: `The last day comes before the first. ${ASK_AGAIN}` };
  return { ok: true, from, to: last + DAY_SECONDS, label: `${longDay(from)} to ${longDay(last)}`, slug: `${isoDay(from)}-to-${isoDay(last)}` };
}

/** What not-included.txt says: every sale counted in the days and left out, by its Stripe reference, with its reason. */
export function notIncludedText(label: string, skipped: { reference: string; why: SkipReason }[], included: number): string {
  const lines = [
    "Receipts not in this download",
    "",
    `Sales paid from ${label} (UTC).`,
    `${included} ${included === 1 ? "receipt is" : "receipts are"} in this download. ${skipped.length === 1 ? "This sale has" : `These ${skipped.length} sales have`} no receipt in it, each with its Stripe reference and the reason:`,
    "",
    ...skipped.map((s) => `${s.reference}: ${SKIP_WORDS[s.why]}`),
    "",
    "Memberships and payment plans are not listed: Stripe makes an invoice for each of their payments, in your Stripe dashboard.",
    "",
  ];
  return lines.join("\n");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (the ZIP's own check, ISO 3309). */
export function crc32Of(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Files in a ZIP, stored as they are (PDFs are compressed inside already),
 * in the order given, with no dependency: a local header and the bytes for
 * each, then the central directory and its end record. Names are ASCII.
 * The caller keeps the count under 65,535 and the size under 4 GB (a
 * download is far below both).
 */
export function zipStored(files: { name: string; bytes: Uint8Array }[], at: Date): Uint8Array {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  const dosTime = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const encoder = new TextEncoder();
  const named = files.map((f) => ({ name: encoder.encode(f.name), bytes: f.bytes, crc: crc32Of(f.bytes) }));
  const total = named.reduce((sum, f) => sum + ZIP_ENTRY_BYTES(f.name.length) + f.bytes.length, 0) + ZIP_END_BYTES;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at8 = 0;
  const offsets: number[] = [];
  for (const f of named) {
    offsets.push(at8);
    view.setUint32(at8, 0x04034b50, true);
    view.setUint16(at8 + 4, 20, true);
    view.setUint16(at8 + 6, 0, true);
    view.setUint16(at8 + 8, 0, true);
    view.setUint16(at8 + 10, dosTime, true);
    view.setUint16(at8 + 12, dosDate, true);
    view.setUint32(at8 + 14, f.crc, true);
    view.setUint32(at8 + 18, f.bytes.length, true);
    view.setUint32(at8 + 22, f.bytes.length, true);
    view.setUint16(at8 + 26, f.name.length, true);
    view.setUint16(at8 + 28, 0, true);
    out.set(f.name, at8 + 30);
    out.set(f.bytes, at8 + 30 + f.name.length);
    at8 += 30 + f.name.length + f.bytes.length;
  }
  const central = at8;
  named.forEach((f, i) => {
    view.setUint32(at8, 0x02014b50, true);
    view.setUint16(at8 + 4, 20, true);
    view.setUint16(at8 + 6, 20, true);
    view.setUint16(at8 + 8, 0, true);
    view.setUint16(at8 + 10, 0, true);
    view.setUint16(at8 + 12, dosTime, true);
    view.setUint16(at8 + 14, dosDate, true);
    view.setUint32(at8 + 16, f.crc, true);
    view.setUint32(at8 + 20, f.bytes.length, true);
    view.setUint32(at8 + 24, f.bytes.length, true);
    view.setUint16(at8 + 28, f.name.length, true);
    // Extra field, comment, disk, internal and external attributes: none.
    view.setUint32(at8 + 42, offsets[i], true);
    out.set(f.name, at8 + 46);
    at8 += 46 + f.name.length;
  });
  view.setUint32(at8, 0x06054b50, true);
  view.setUint16(at8 + 8, named.length, true);
  view.setUint16(at8 + 10, named.length, true);
  view.setUint32(at8 + 12, at8 - central, true);
  view.setUint32(at8 + 16, central, true);
  return out;
}

/** The days the studio's form starts with: the whole of last month (UTC), the month a creator's books usually close. */
export function lastMonthDays(nowMs: number): { from: string; to: string } {
  const now = new Date(nowMs);
  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const last = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - DAY_SECONDS * 1000;
  return { from: new Date(first).toISOString().slice(0, 10), to: new Date(last).toISOString().slice(0, 10) };
}
