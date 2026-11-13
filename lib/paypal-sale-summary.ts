/**
 * A PayPal sale's short line for the sales file (app/api/store/export?what=sales,
 * lib/stats.ts salesCsv; Claude 4's option D, candidate 1b, 7 November 2026).
 *
 *   nl:ppsell:sum:<order>   the line: only what the file shows of a paid order, kept no longer than its record
 *
 * A paid order's record (lib/paypal-sales.ts, nl:ppsell:paid:) keeps the twenty
 * fields of what the visit carried, so it can weigh MAX_PAID_BYTES (26,920
 * bytes); the file shows the order, the time, the product, the amounts, the
 * buyer's address, the title the sale carried, its option, its extras and its
 * kind. settle writes this line beside the record, in the same writes that put
 * the order in the store's list, and the file reads the lines in one MGET: at
 * most PAYPAL_SUMMARY_BYTES a sale. Every text is bounded as it is written, its
 * control characters dropped and a lone surrogate written as U+FFFD (what the
 * file's bytes already carried), so only a quote or a backslash is escaped.
 *
 * A sale whose line is missing (paid before the line existed, or its write
 * lost) or does not read is read whole, made into the same line and counted
 * (readPayPalSalesForFile `whole`): no row is ever left out or left blank for
 * it. fillSaleSummaries writes the missing lines (scripts/sales-file-fill.mjs).
 *
 * The line holds the buyer's address: a copy of the record's, kept and taken
 * away with it (lib/paypal-sales.ts paypalOrderKeys, lib/data-families.ts,
 * lib/person-data.ts).
 */
import type { Paid } from "@/lib/paypal-sales";
import { ORDER_ID, PAID_KEPT_SECONDS, paidKey, salesKey } from "@/lib/paypal-sales";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { MAX_TITLE_LENGTH } from "@/lib/catalog-rules";
import { MAX_OPTION_LABEL_LENGTH } from "@/lib/product-option";
import { BUMP_KEYS, bumpsFromMeta } from "@/lib/bundle-rules";

export const summaryKey = (order: string) => `nl:ppsell:sum:${order}`;

/** The line is kept this much less than the record, so it never outlives it (both are written in one request). */
export const SUMMARY_EARLIER_SECONDS = 60;

const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY = /^[A-Za-z]{3}$/;
/** A paid time in whole seconds, as the store's list scores it: at most twelve digits. */
const MAX_AT = 999_999_999_999;
const KINDS = new Set(["tip", "call", "plan"]);

/** The most JSON bytes each text of the line takes: the file's own bounds (lib/stats.ts SALES_FILE_COLUMNS). */
export const SUMMARY_TEXT_BYTES = { email: 254, title: 3 * MAX_TITLE_LENGTH, option: 3 * MAX_OPTION_LABEL_LENGTH } as const;

/** The JSON bytes one character takes once its control characters are dropped and a lone surrogate replaced. */
function jsonBytes(char: string): number {
  if (char === '"' || char === "\\") return 2;
  const point = char.codePointAt(0) as number;
  return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
}

/**
 * Text made safe and short for the line: control characters (below U+0020,
 * which JSON writes as six bytes) dropped, a lone surrogate written as U+FFFD,
 * and cut between two characters so it takes at most `max` bytes in JSON, with
 * "…" at the end when cut. Text that fits is returned as it is. Pure.
 */
export function fitText(text: string, max: number): string {
  let clean = "";
  for (const char of text) {
    const point = char.codePointAt(0) as number;
    if (point < 0x20) continue;
    clean += point >= 0xd800 && point <= 0xdfff ? "�" : char;
  }
  let used = 0;
  let fit = 0;
  for (const char of clean) {
    used += jsonBytes(char);
    if (used > max) return `${clean.slice(0, fit)}…`;
    if (used <= max - 3) fit += char.length;
  }
  return clean;
}

type Line = { o: string; a: number; p: string; c: number; u: string; e: string; f?: number; t?: string; n?: string; k?: string; b?: string[] };

/**
 * The line for a paid order's record, as JSON, or null when the record is not
 * this order's in its known shape (its order, a product id, whole amounts, a
 * currency, a paid time, an address): such a record is unknown, never a line.
 * Pure.
 */
export function saleSummary(record: unknown, order: string, statsId: string): string | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const r = record as Record<string, unknown>;
  const whole = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  if (
    r.store !== statsId ||
    r.order !== order ||
    !ORDER_ID.test(order) ||
    typeof r.product !== "string" ||
    !PRODUCT_ID.test(r.product) ||
    !whole(r.cents) ||
    typeof r.currency !== "string" ||
    !CURRENCY.test(r.currency) ||
    !whole(r.at) ||
    (r.at as number) <= 0 ||
    (r.at as number) > MAX_AT ||
    typeof r.email !== "string"
  ) {
    return null;
  }
  const meta = r.meta && typeof r.meta === "object" && !Array.isArray(r.meta) ? (r.meta as Record<string, unknown>) : {};
  const line: Line = { o: order, a: r.at as number, p: r.product, c: r.cents as number, u: r.currency, e: fitText(r.email, SUMMARY_TEXT_BYTES.email) };
  // A discount the file shows is a whole number of cents; anything else it shows as none (lib/stats.ts salesCsv, cents).
  if (Number.isSafeInteger(r.off)) line.f = r.off as number;
  if (typeof meta.title === "string") line.t = fitText(meta.title, SUMMARY_TEXT_BYTES.title);
  if (typeof meta.option === "string") line.n = fitText(meta.option, SUMMARY_TEXT_BYTES.option);
  if (typeof meta.kind === "string" && KINDS.has(meta.kind)) line.k = meta.kind;
  const bumps = bumpsFromMeta(Object.fromEntries(BUMP_KEYS.map((key) => [key, typeof meta[key] === "string" ? (meta[key] as string) : undefined])));
  if (bumps.length) line.b = bumps.map((bump) => bump.id);
  return JSON.stringify(line);
}

/** The sale a line is, for the sales file only: its capture is not kept, so it is "" (the file never shows it). */
export type PaidLine = Omit<Paid, "capture" | "handle" | "via" | "sale">;

/**
 * A line read back: the sale, or null when it is not this order's line in its
 * exact shape (then the record is read whole). Pure.
 */
export function readSaleSummary(raw: string, order: string, statsId: string): PaidLine | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const l = v as Record<string, unknown>;
  const allowed = new Set(["o", "a", "p", "c", "u", "e", "f", "t", "n", "k", "b"]);
  if (Object.keys(l).some((key) => !allowed.has(key))) return null;
  const text = (key: string, max: number) => l[key] === undefined || (typeof l[key] === "string" && fitText(l[key] as string, max) === l[key]);
  if (
    l.o !== order ||
    typeof l.p !== "string" ||
    !PRODUCT_ID.test(l.p) ||
    !Number.isSafeInteger(l.c) ||
    (l.c as number) < 0 ||
    typeof l.u !== "string" ||
    !CURRENCY.test(l.u) ||
    !Number.isSafeInteger(l.a) ||
    (l.a as number) <= 0 ||
    (l.a as number) > MAX_AT ||
    typeof l.e !== "string" ||
    !text("e", SUMMARY_TEXT_BYTES.email) ||
    !text("t", SUMMARY_TEXT_BYTES.title) ||
    !text("n", SUMMARY_TEXT_BYTES.option) ||
    (l.f !== undefined && !Number.isSafeInteger(l.f)) ||
    (l.k !== undefined && (typeof l.k !== "string" || !KINDS.has(l.k))) ||
    (l.b !== undefined && (!Array.isArray(l.b) || !l.b.length || l.b.length > BUMP_KEYS.length || l.b.some((id) => typeof id !== "string" || !PRODUCT_ID.test(id))))
  ) {
    return null;
  }
  const meta: Record<string, string> = {};
  if (l.t !== undefined) meta.title = l.t as string;
  if (l.n !== undefined) meta.option = l.n as string;
  if (l.k !== undefined) meta.kind = l.k as string;
  ((l.b as string[] | undefined) ?? []).forEach((id, i) => {
    meta[BUMP_KEYS[i]] = id;
  });
  return {
    store: statsId,
    order,
    email: l.e as string,
    product: l.p as string,
    cents: l.c as number,
    currency: l.u as string,
    at: l.a as number,
    ...(l.f !== undefined ? { off: l.f as number } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

/**
 * The most bytes a line takes: every field at its longest (an order id of 36,
 * a time of twelve digits, a product id of 64, amounts of a safe integer's
 * digits and sign, every text at its bound in multibyte characters, three
 * extras of 64), keys, quotes and commas included. tests/sales-file-summary.test.ts
 * holds it against lines made from adversarial records.
 */
export const PAYPAL_SUMMARY_BYTES = new TextEncoder().encode(
  JSON.stringify({
    o: "O".repeat(36),
    a: MAX_AT,
    p: "p".repeat(64),
    c: Number.MAX_SAFE_INTEGER,
    u: "usd",
    e: "€".repeat(SUMMARY_TEXT_BYTES.email / 3) + "ab",
    f: Number.MIN_SAFE_INTEGER,
    t: "€".repeat(SUMMARY_TEXT_BYTES.title / 3),
    n: "€".repeat(SUMMARY_TEXT_BYTES.option / 3),
    k: "plan",
    b: BUMP_KEYS.map(() => "b".repeat(64)),
  } satisfies Line),
).length;

/** One MGET read exactly: a string or nil for each key asked, or UnknownReplyError (CX-123 rule 24). */
async function mgetExact(keys: string[], what: string): Promise<(string | null)[]> {
  const [reply] = repliesFor(await redisPipeline([["MGET", ...keys]]), 1) ?? [undefined];
  const raws = repliesFor(reply, keys.length);
  if (!raws || raws.some((raw) => raw !== null && typeof raw !== "string")) throw new UnknownReplyError(what);
  return raws as (string | null)[];
}

/** The orders in a store's list of PayPal sales, read exactly: order ids, or UnknownReplyError. */
function ordersOf(reply: unknown): string[] {
  const [listed] = repliesFor(reply, 1) ?? [undefined];
  const orders = stringList(listed);
  if (!orders || orders.some((order) => !ORDER_ID.test(order))) throw new UnknownReplyError("a store's PayPal sales");
  return orders;
}

/**
 * The store's PayPal sales paid since `since` (seconds), newest first, at most
 * `limit`, for the sales file only: each from its line, or, when its line is
 * missing or does not read, from its record read whole (`whole` counts those).
 * A sale whose line and record are both gone (Redis says nil) is not in it, as
 * before; a list, a reply or a record that does not read throws
 * UnknownReplyError, never a sale left out (CX-123 rule 24). Three commands at
 * most: the range, the lines' MGET and, for the sales read whole, the records'.
 */
export async function readPayPalSalesForFile(statsId: string | null, since: number, limit: number): Promise<{ sales: PaidLine[]; partial: boolean; whole: number }> {
  if (!statsId || !isRedisConfigured()) return { sales: [], partial: false, whole: 0 };
  const orders = ordersOf(await redisPipeline([["ZREVRANGEBYSCORE", salesKey(statsId), "+inf", String(Math.max(0, since)), "LIMIT", "0", String(limit + 1)]]));
  const partial = orders.length > limit;
  const wanted = orders.slice(0, limit);
  if (!wanted.length) return { sales: [], partial, whole: 0 };
  const lines = await mgetExact(wanted.map(summaryKey), "PayPal sales' lines");
  const found: (PaidLine | null)[] = wanted.map((order, i) => (lines[i] === null ? null : readSaleSummary(lines[i] as string, order, statsId)));
  const missing = wanted.flatMap((_, i) => (found[i] ? [] : [i]));
  let whole = 0;
  if (missing.length) {
    const records = await mgetExact(missing.map((i) => paidKey(wanted[i])), "PayPal sales' records");
    missing.forEach((i, m) => {
      const raw = records[m];
      if (raw === null) return;
      const line = lineOfRecord(raw, wanted[i], statsId);
      if (!line) throw new UnknownReplyError("a PayPal sale's record");
      found[i] = readSaleSummary(line, wanted[i], statsId);
      if (!found[i]) throw new UnknownReplyError("a PayPal sale's record");
      whole += 1;
    });
  }
  return { sales: found.filter((sale): sale is PaidLine => sale !== null), partial, whole };
}

/** The line for a record as Redis kept it, or null when it is not JSON or not this order's. */
function lineOfRecord(raw: string, order: string, statsId: string): string | null {
  try {
    return saleSummary(JSON.parse(raw), order, statsId);
  } catch {
    return null;
  }
}

/** What a filling of lines found and did. */
export type SummaryFill = { sales: number; without: number; written: number; unreadable: number; commands: number; bytes: number };

/** The most orders one step of a filling reads. */
export const FILL_BATCH = 500;

/**
 * Writes the line of every sale in a store's list that has none (the one-time
 * filling, scripts/sales-file-fill.mjs), FILL_BATCH orders a step: the range,
 * the lines' MGET, the records' MGET for those without, and one SET NX each,
 * kept to the record's own end less SUMMARY_EARLIER_SECONDS. Only counts when
 * `write` is false. A record that does not read is counted unreadable and left
 * without its line (the file reads it whole, and says when it does not read). A
 * reply that does not read throws UnknownReplyError. Safe to run again.
 */
export async function fillSaleSummaries(statsId: string, write: boolean, nowSeconds = Math.floor(Date.now() / 1000)): Promise<SummaryFill> {
  const out: SummaryFill = { sales: 0, without: 0, written: 0, unreadable: 0, commands: 0, bytes: 0 };
  if (!isRedisConfigured()) return out;
  const weigh = (values: (string | null)[]) => values.reduce((n, v) => n + (v === null ? 4 : new TextEncoder().encode(v).length), 0);
  for (let offset = 0; ; offset += FILL_BATCH) {
    const orders = ordersOf(await redisPipeline([["ZRANGEBYSCORE", salesKey(statsId), "-inf", "+inf", "LIMIT", String(offset), String(FILL_BATCH)]]));
    out.commands += 1;
    out.bytes += orders.reduce((n, o) => n + o.length + 3, 0);
    if (!orders.length) return out;
    out.sales += orders.length;
    const lines = await mgetExact(orders.map(summaryKey), "PayPal sales' lines");
    out.commands += 1;
    out.bytes += weigh(lines);
    const without = orders.filter((order, i) => lines[i] === null || !readSaleSummary(lines[i] as string, order, statsId));
    if (without.length) {
      const records = await mgetExact(without.map(paidKey), "PayPal sales' records");
      out.commands += 1;
      out.bytes += weigh(records);
      const writes: (string | number)[][] = [];
      without.forEach((order, i) => {
        const raw = records[i];
        if (raw === null) return;
        out.without += 1;
        const line = lineOfRecord(raw, order, statsId);
        const sale = line ? readSaleSummary(line, order, statsId) : null;
        if (!sale) {
          out.unreadable += 1;
          return;
        }
        // Ends with the record's own end (written at its paid time, PAID_KEPT_SECONDS), a little before it.
        const seconds = sale.at + PAID_KEPT_SECONDS - SUMMARY_EARLIER_SECONDS - nowSeconds;
        if (seconds > 0) writes.push(["SET", summaryKey(order), line as string, "NX", "EX", seconds]);
      });
      if (write && writes.length) {
        const answers = repliesFor(await redisPipeline(writes), writes.length);
        if (!answers || answers.some((answer) => answer !== "OK" && answer !== null)) throw new UnknownReplyError("writing PayPal sales' lines");
        out.commands += writes.length;
        out.bytes += writes.reduce((n, w) => n + new TextEncoder().encode(String(w[2])).length, 0);
        out.written += answers.filter((answer) => answer === "OK").length;
      }
    }
    if (orders.length < FILL_BATCH) return out;
  }
}
