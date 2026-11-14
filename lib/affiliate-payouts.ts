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
import { createHash, randomBytes } from "node:crypto";
import { AFFILIATE_ID_PATTERN, MAX_REFERENCE_LENGTH, type Affiliate, type Book, type Row, addPayout, payAddress } from "@/lib/affiliates";
import { csvCell } from "@/lib/csv";
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
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
 *
 * No route calls it since 12 November 2026 (C1-20261112-1000-C7-141, item 2c):
 * what is owed at the confirmation is not what a downloaded file paid, so
 * "Mark as paid" writes down the kept file instead (keepPayFile, and
 * confirmPayFile in lib/paypal-payouts.ts). Kept for its exact-reply checks
 * (tests/affiliate-payout-write-exact.test.ts); do not wire it back to a route.
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

/**
 * A payout file the creator downloaded, kept so that "Mark as paid" writes down exactly what that file paid
 * (Claude 1, C1-20261112-1000-C7-141, item 2c), never what the book says is owed at the moment of the confirmation:
 * new sales between the download and the confirmation were not in the file, nobody was sent them, and writing them
 * down as paid would mean they are never paid. The difference stays owed and goes in the next file.
 *
 * One hash a store (payFilesKey), a field a file under a random id, its lines as the file has them
 * (affiliate id and amount, no address), the currency and when it was handed out. The same lines downloaded again,
 * the PayPal file and the worksheet, are one file kept once. At most MAX_PAY_FILES are kept, the oldest let go
 * first, and the whole hash runs out PAY_FILE_SECONDS after the last download: a file older than that must be
 * downloaded again, and is never guessed at.
 */
export const PAY_FILE_SECONDS = 30 * 86_400;
/** The most downloaded files a store keeps waiting to be confirmed. */
export const MAX_PAY_FILES = 3;

export const payFilesKey = (statsId: string) => `nl:affpay:${statsId}`;

/** One kept file: when it was handed out (ms), its currency and its lines (affiliate id, amount in the smallest unit). */
export type KeptPayFile = { at: number; currency: string; lines: { a: string; c: number }[] };

/** A kept file as the studio lists it: never its addresses, only how many it pays and how much. */
export type HeldPayFile = { id: string; at: number; currency: string; people: number; cents: number };

const PAY_FILE_ID = /^[0-9a-f]{24}$/;

/** A kept file read exactly; null when it does not read as one (then it is never confirmed). */
export function parsePayFile(raw: unknown): KeptPayFile | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { at, currency, lines } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(at) || (at as number) <= 0 || typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) return null;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_BATCH_ROWS) return null;
  const seen = new Set<string>();
  const read: { a: string; c: number }[] = [];
  for (const line of lines) {
    const { a, c } = (line ?? {}) as Record<string, unknown>;
    if (typeof a !== "string" || !AFFILIATE_ID_PATTERN.test(a) || seen.has(a) || !Number.isSafeInteger(c) || (c as number) <= 0) return null;
    seen.add(a);
    read.push({ a, c: c as number });
  }
  return { at: at as number, currency, lines: read };
}

/** The same lines, the same currency: the same file. */
const sameLines = (one: KeptPayFile, other: KeptPayFile) =>
  one.currency === other.currency && one.lines.length === other.lines.length && one.lines.every((line, i) => line.a === other.lines[i].a && line.c === other.lines[i].c);

/** Every kept file of a store, read exactly; UnknownReplyError when the reply is not a hash's field and value pairs. */
async function readPayFiles(statsId: string): Promise<[string, string][]> {
  const reply = repliesFor(await redisPipeline([["HGETALL", payFilesKey(statsId)]]), 1);
  const flat = reply ? stringList(reply[0]) : null;
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError("the payout files kept");
  const pairs: [string, string][] = [];
  for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
  return pairs;
}

/**
 * Keeps the lines of a file about to be handed out and answers its id. Throws when Redis does not confirm it holds
 * them: a file that could never be confirmed is not handed out (the creator would pay it and the book would go on
 * owing it). Three commands, four when an old file is let go: HGETALL, HSET, EXPIRE (and HDEL).
 */
export async function keepPayFile(store: Store, lines: BatchLine[], nowMs = Date.now()): Promise<string> {
  if (!store.statsId) throw new Error("a payout file needs the store's statsId");
  const key = payFilesKey(store.statsId);
  const file: KeptPayFile = { at: nowMs, currency: store.currency, lines: lines.map((line) => ({ a: line.affiliate.id, c: line.cents })) };
  const kept = (await readPayFiles(store.statsId))
    .map(([id, raw]) => ({ id, file: parsePayFile(raw) }))
    .sort((x, y) => (y.file?.at ?? 0) - (x.file?.at ?? 0));
  const again = kept.find((one) => one.file && PAY_FILE_ID.test(one.id) && sameLines(one.file, file));
  const id = again?.id ?? randomBytes(12).toString("hex");
  // The newest MAX_PAY_FILES - 1 others stay; older ones, and anything that does not read as a file, are let go.
  const others = kept.filter((one) => one.id !== id);
  const drop = [...others.slice(MAX_PAY_FILES - 1), ...others.slice(0, MAX_PAY_FILES - 1).filter((one) => !one.file)].map((one) => one.id);
  const commands: (string | number)[][] = [
    ["HSET", key, id, JSON.stringify(file)],
    ["EXPIRE", key, PAY_FILE_SECONDS],
    ...(drop.length ? [["HDEL", key, ...drop]] : []),
  ];
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  if (!replies || (replies[0] !== 0 && replies[0] !== 1) || replies[1] !== 1) throw new UnknownReplyError("a payout file kept");
  return id;
}

/** The files a store downloaded and has not confirmed, newest first; null when they cannot be read. */
export async function heldPayFiles(store: Store): Promise<HeldPayFile[] | null> {
  if (!store.statsId) return [];
  try {
    return (await readPayFiles(store.statsId))
      .flatMap(([id, raw]) => {
        const file = PAY_FILE_ID.test(id) ? parsePayFile(raw) : null;
        return file ? [{ id, at: file.at, currency: file.currency, people: file.lines.length, cents: file.lines.reduce((sum, line) => sum + line.c, 0) }] : [];
      })
      .sort((x, y) => y.at - x.at);
  } catch (error) {
    console.error("reading the payout files kept failed", error);
    return null;
  }
}

/** One kept file read exactly by its id: null when it is not there, has run out or does not read as a file. */
export async function readPayFile(statsId: string, id: string): Promise<KeptPayFile | null> {
  if (!PAY_FILE_ID.test(id)) return null;
  const reply = repliesFor(await redisPipeline([["HGET", payFilesKey(statsId), id]]), 1);
  if (!reply) throw new UnknownReplyError("a payout file kept");
  if (reply[0] === null) return null;
  return parsePayFile(reply[0]);
}

/**
 * Lets every kept file of a store go once one is written down: each file is a snapshot of the whole balance payable
 * when it was downloaded, so once a payout is written every other file overlaps it and would pay the same commission
 * twice (review of #3906, Claude 1, MEDIUM 2). The confirmed file goes with them, so it is never written down twice.
 */
export async function dropPayFiles(statsId: string): Promise<void> {
  const reply = repliesFor(await redisPipeline([["DEL", payFilesKey(statsId)]]), 1);
  if (!reply || (reply[0] !== 0 && reply[0] !== 1)) throw new UnknownReplyError("the payout files let go");
}

/**
 * The id of the payout that writes down one line of one file: the same file and affiliate give the same id, 12 hex
 * characters like any payout's, so a confirmation sent twice, or retried after a reply that was not known, writes
 * it once (lib/affiliates.ts addPayoutOnce), and the creator can still remove it (removePayout).
 */
export function payoutIdForFileLine(file: string, affiliate: string): string {
  return createHash("sha256").update(`payout-file-line|${file}|${affiliate}`).digest("hex").slice(0, 12);
}
