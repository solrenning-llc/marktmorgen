/**
 * The numbers as the API (/api/v1/stats) and the MCP tools read them, with a
 * copy kept an hour (decision of 4 November 2026: read cold, the numbers take
 * every page of the creator's Stripe account at its most, about forty of a
 * store's API requests, so a Store plan's month went in a dozen readings).
 *
 *   nl:stats:<statsId>:apinum:<variant>   [variant, statsId, Stripe account, currency, sales, at, body digest] \n <the numbers as JSON>
 *
 * A reading first looks up how big the copy is (STRLEN). Kept: what reading
 * it and sending the answer may take is set aside (lib/api-guard.ts,
 * holdMoreApi), it is read, and settled at what it read and what the answer
 * sends, before it is sent: a warm reading pays only for the copy. Not kept:
 * the numbers are taken at their most (lib/api-read-rules.ts, numbersWork)
 * with what keeping them costs (NUMBERS_KEEP_WORK), all before anything is
 * read, then read and kept. Every answer says `asOf`, when its numbers were
 * read, in ISO 8601.
 *
 * Whose numbers: the key is the store's own `statsId`, from the store the API
 * key belongs to, never anything in the request, and only the server writes
 * it. The copy carries, in the clear on its first line, the variant, what it
 * was read under (that id, the Stripe account, currency and whether the store
 * reads sales) and when; a reading compares them exactly with the store's own
 * and its clock, so a copy for another store, variant, Stripe account or
 * currency, or older than an hour, is not used, and the numbers are read
 * again. A copy larger than NUMBERS_KEPT_BYTES is not kept.
 *
 * Two variants: "plain" (the numbers without the products' listings, what
 * /api/v1/stats and get_numbers answer) and "full" (with the listings of the
 * products they name, for the MCP tools about a stretch of days). A "full"
 * reading whose listings were not covered by the requests left is answered
 * without them and not kept.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { type StatsData, readsSales } from "@/lib/stats";
import { readNumbers } from "@/lib/stats-report";
import { type Charge, type Hold, numbersUnits } from "@/lib/api-read";
import { NUMBERS_KEEP_WORK, NUMBERS_KEPT_BYTES, NUMBERS_KEPT_SECONDS, NUMBERS_SENT_BYTES, apiReadUnits, keptNumbersWork, settledUnits } from "@/lib/api-read-rules";
import { readFullNumbersPaid } from "@/lib/mcp-tools";

export type NumbersVariant = "plain" | "full";

export type ApiNumbers = {
  data: StatsData;
  /** When these numbers were read, ISO 8601: now, or when the kept copy was made. */
  asOf: string;
  /** Whether the products' listings were read ("full" only; "plain" never reads them). */
  listed: boolean;
  /** Settles what was set aside at what the answer sends, before it is sent: null when settled, else the refusal to send instead. */
  settle: (sentBytes: number) => Promise<Response | null>;
};

/** The first line of a kept copy, before the numbers, at its largest: the variant, what they were read under and when. */
const HEAD_BYTES = 512;

export const keptNumbersKey = (statsId: string, variant: NumbersVariant) => `nl:stats:${statsId}:apinum:${variant}`;

/**
 * The first line of a kept copy: the variant, what the numbers were read
 * under, nothing secret (the store's numbers id, its Stripe account, currency
 * and whether it reads sales), and when, as JSON on one line.
 */
function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function headOf(store: Store, variant: NumbersVariant, at: number, digest: string): string {
  return JSON.stringify([variant, String(store.statsId ?? ""), String(store.stripeAccountId ?? ""), String(store.currency), readsSales(store), at, digest]);
}

type UnknownRecord = Record<string, unknown>;

const RANGE_KEYS = ["d7", "d30", "d90", "all"] as const;
const WINDOW_KEYS = ["d7", "d30", "d90"] as const;

function objectOf(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function fields(value: unknown, text: readonly string[] = [], integer: readonly string[] = [], boolean: readonly string[] = []): value is UnknownRecord {
  if (!objectOf(value)) return false;
  return text.every((key) => typeof value[key] === "string") &&
    integer.every((key) => safeInteger(value[key])) &&
    boolean.every((key) => typeof value[key] === "boolean");
}

function rows(value: unknown, valid: (row: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(valid);
}

function windows(value: unknown, keys: readonly string[], valid: (window: unknown) => boolean): boolean {
  return objectOf(value) && keys.every((key) => Object.hasOwn(value, key) && valid(value[key]));
}

function recordValues(value: unknown, valid: (entry: unknown) => boolean): boolean {
  return objectOf(value) && Object.values(value).every(valid);
}

function allNumbersAreSafe(value: unknown): boolean {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(allNumbersAreSafe);
  if (objectOf(value)) return Object.values(value).every(allNumbersAreSafe);
  return value === null || typeof value === "string" || typeof value === "boolean";
}

const money = (value: unknown) => fields(value, [], ["sales", "cents"]);
const ranked = (value: unknown) => rows(value, (row) => fields(row, ["name"], ["visits"]));
const totals = (value: unknown) => fields(value, [], ["visitors", "views", "checkouts", "sales", "cents"]);
const productRow = (value: unknown) => fields(value, [], ["views", "checkouts", "sales", "cents"]);

function attributionTable(value: unknown): boolean {
  if (!fields(value) || !rows(value.rows, (row) => {
    if (!fields(row, ["key", "name"]) || !money(row.last) || !money(row.first)) return false;
    return fields(row.said, [], ["buyers", "cents"]);
  })) return false;
  return money(value.unknown) && (value.unknownFirst === undefined || money(value.unknownFirst)) &&
    rows(value.unknownSaid, (row) => fields(row, ["answer", "name"], ["buyers", "cents"])) && money(value.total);
}

function buyerChannels(value: unknown): boolean {
  if (!fields(value, [], [], ["historyPartial"])) return false;
  const validWindow = (window: unknown) => fields(window, [], ["unidentifiedOrders"]) && rows(window.rows, (row) =>
    fields(row, ["source"], ["buyers", "repeatBuyers", "orders", "cents", "eligible30", "repeated30"]));
  if (!WINDOW_KEYS.every((key) => validWindow(value[key]))) return false;
  if (value.weekly === undefined) return true;
  if (!fields(value.weekly, ["asOf"], ["unidentifiedOrders"])) return false;
  return rows(value.weekly.rows, (row) => {
    if (!fields(row, ["week"], ["buyers"]) || !objectOf(row.observations)) return false;
    return ["7", "30", "60", "90"].every((age) => fields((row.observations as UnknownRecord)[age], [], ["eligible", "repeated"]));
  });
}

function keptWindow(value: unknown): boolean {
  if (!fields(value) || !rows(value.lines, (line) => {
    if (!fields(line, ["currency"], ["sales", "salesCents", "renewals", "renewalCents", "refunds", "refundCents", "disputes", "disputeCents"])) return false;
    return (line.keptCents === null || safeInteger(line.keptCents)) && rows(line.missing, (part) => typeof part === "string");
  })) return false;
  return value.byChannel === null || rows(value.byChannel, (row) => fields(row, ["source"], ["keptCents"]));
}

/** A kept body is usable only when every field that can leave the studio has its StatsData runtime shape. */
function statsData(value: unknown): value is StatsData {
  if (!fields(value, ["currency", "since"], ["elsewhere"], ["partial"]) || !allNumbersAreSafe(value)) return false;
  if (!rows(value.days, (day) => fields(day, ["date"], ["visitors", "views", "checkouts", "sales"]))) return false;
  if (!windows(value.totals, RANGE_KEYS, totals) || !windows(value.sources, RANGE_KEYS, ranked) ||
      !windows(value.mediums, RANGE_KEYS, ranked) || !windows(value.campaigns, RANGE_KEYS, ranked)) return false;
  if (!rows(value.products, (product) => fields(product, ["id", "title"]) && RANGE_KEYS.every((key) => productRow(product[key])))) return false;
  if (!rows(value.links, (link) => fields(link, ["id", "title"]) && RANGE_KEYS.every((key) => safeInteger(link[key])))) return false;
  if (!(["ok", "none", "error"] as unknown[]).includes(value.sales)) return false;
  if (!rows(value.revenueBySource, (row) => fields(row, ["source"], ["cents", "sales", "renewalCents", "renewals"]))) return false;
  if (!rows(value.firstBySource, (row) => fields(row, ["source"], ["cents", "sales"]))) return false;
  if (!windows(value.channels, WINDOW_KEYS, (window) => rows(window, (row) =>
    fields(row, ["source"], ["visits", "checkouts", "free", "sales", "cents"])))) return false;
  if (!windows(value.posts, WINDOW_KEYS, (window) => rows(window, (row) => {
    if (!fields(row, ["campaign", "source"], ["visits", "sales", "cents"])) return false;
    return row.sources === undefined || rows(row.sources, (source) => typeof source === "string");
  }))) return false;
  if (!windows(value.countries, RANGE_KEYS, ranked) || !windows(value.devices, RANGE_KEYS, ranked)) return false;
  const renewals = value.renewals;
  if (renewals !== null && (!fields(renewals, [], [], ["partial"]) || !WINDOW_KEYS.every((key) => fields(renewals[key], [], ["payments", "cents"])))) return false;
  if (!windows(value.reach, WINDOW_KEYS, (window) => fields(window, [], ["visitors"]) && rows(window.rows, (row) => {
    if (!fields(row, ["item", "kind", "title"], ["position", "reached", "clicks"])) return false;
    return ["product", "link", "part"].includes(row.kind as string);
  }))) return false;
  if (!windows(value.previous, WINDOW_KEYS, (window) => fields(window, [], ["visitors", "views", "checkouts"]) &&
      (window.sales === null || safeInteger(window.sales)) && (window.cents === null || safeInteger(window.cents)))) return false;
  if (value.previousTrafficAvailable !== undefined && !windows(value.previousTrafficAvailable, WINDOW_KEYS, (available) => typeof available === "boolean")) return false;
  if (!windows(value.heard, WINDOW_KEYS, (window) => rows(window, (row) => fields(row, ["answer"], ["buyers", "cents"]) &&
      (row.unknownBuyers === undefined || safeInteger(row.unknownBuyers)) && (row.unknownCents === undefined || safeInteger(row.unknownCents))))) return false;
  if (value.attribution !== undefined && !windows(value.attribution, WINDOW_KEYS, attributionTable)) return false;
  if (value.attributionDays !== undefined && !safeInteger(value.attributionDays)) return false;
  if (!windows(value.searchMisses, WINDOW_KEYS, ranked)) return false;
  if (!windows(value.ads, WINDOW_KEYS, (window) => rows(window, (row) => fields(row, ["content", "source", "campaign"], ["sales", "cents"])))) return false;
  if (!windows(value.salesCountries, WINDOW_KEYS, (window) => rows(window, (row) => fields(row, ["country"], ["sales", "cents"])))) return false;
  if (value.refunds !== null && !windows(value.refunds, WINDOW_KEYS, (window) => rows(window, (row) => fields(row, ["source"], ["refunds", "cents"])))) return false;
  if (!recordValues(value.refundsByProduct, (row) => fields(row, [], ["refunds", "cents"]))) return false;
  const takenBackElsewhere = value.takenBackElsewhere;
  if (takenBackElsewhere !== undefined && takenBackElsewhere !== null &&
      (!fields(takenBackElsewhere) || !["refunds", "disputes"].every((key) => takenBackElsewhere[key] === null || safeInteger(takenBackElsewhere[key])))) return false;
  if (value.disputes !== undefined && value.disputes !== null && !windows(value.disputes, WINDOW_KEYS, (window) => rows(window, (row) => fields(row, ["source"], ["disputes", "cents"])))) return false;
  if (value.disputesComplete !== undefined && typeof value.disputesComplete !== "boolean") return false;
  if (value.kept !== undefined && value.kept !== null && !windows(value.kept, WINDOW_KEYS, keptWindow)) return false;
  if (value.paypalDisputesUnread !== undefined && typeof value.paypalDisputesUnread !== "boolean") return false;
  if (value.channelDays !== undefined && !recordValues(value.channelDays, (days) => recordValues(days, safeInteger))) return false;
  if (value.refundDays !== undefined && value.refundDays !== null && !recordValues(value.refundDays, safeInteger)) return false;
  if (value.buyers !== undefined && value.buyers !== null && !windows(value.buyers, WINDOW_KEYS, (window) => fields(window, [], ["buyers", "orders", "cents", "returning", "repeat"]))) return false;
  if (value.buyerChannels !== undefined && value.buyerChannels !== null && !buyerChannels(value.buyerChannels)) return false;
  if (value.cashflowComplete !== undefined && typeof value.cashflowComplete !== "boolean") return false;
  if (value.paymentsComplete !== undefined && typeof value.paymentsComplete !== "boolean") return false;
  if (value.discounts !== undefined && value.discounts !== null && (!fields(value.discounts, [], [], ["refundsRead"]) ||
      (value.discounts.rows !== null && !rows(value.discounts.rows, (row) => fields(row, ["kind"], ["sales", "cents", "off", "refunded", "buyers", "again"]))))) return false;
  if (value.hours !== undefined && value.hours !== null && (!fields(value.hours) || !rows(value.hours.sales, safeInteger) || !rows(value.hours.cents, safeInteger))) return false;
  if (value.topBuyers !== undefined && !rows(value.topBuyers, (row) => fields(row, ["email", "reference"], ["cents", "orders", "last"]))) return false;
  return true;
}

/** The kept copy, when its first line is exactly this store's and this variant's, and less than an hour old; else null. */
export function openKeptNumbers(store: Store, variant: NumbersVariant, raw: unknown, now = Date.now()): { data: StatsData; at: number } | null {
  if (typeof raw !== "string" || !store.statsId) return null;
  const end = raw.indexOf("\n");
  if (end < 0 || end > HEAD_BYTES) return null;
  let head: unknown;
  try {
    head = JSON.parse(raw.slice(0, end));
  } catch {
    return null;
  }
  if (!Array.isArray(head) || head.length !== 7) return null;
  const at = head[5];
  const digest = head[6];
  if (typeof at !== "number" || !Number.isSafeInteger(at) || !(at <= now && now - at < NUMBERS_KEPT_SECONDS * 1000)) return null;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return null;
  const json = raw.slice(end + 1);
  if (digestOf(json) !== digest || raw.slice(0, end) !== headOf(store, variant, at, digest)) return null;
  try {
    const data: unknown = JSON.parse(json);
    if (!statsData(data)) return null;
    return { data, at };
  } catch {
    return null;
  }
}

/** The copy as it is kept: its first line, then the numbers; null when the store has no numbers id or they are too big to keep. */
export function keptNumbersCopy(store: Store, variant: NumbersVariant, data: StatsData, at: number): string | null {
  const json = JSON.stringify(data);
  if (!store.statsId || Buffer.byteLength(json) > NUMBERS_KEPT_BYTES) return null;
  return `${headOf(store, variant, at, digestOf(json))}\n${json}`;
}

/**
 * The store's numbers for the API or an MCP tool, paid for first (above):
 * null when they cannot be read, the refusal as it is, or the numbers with
 * when they were read and how to settle what the answer sends.
 */
export async function apiNumbers(store: Store, variant: NumbersVariant, charge: Charge, hold: Hold, now = Date.now()): Promise<ApiNumbers | Response | null> {
  const keeps = Boolean(store.statsId && isRedisConfigured());
  const key = store.statsId ? keptNumbersKey(store.statsId, variant) : "";
  let taken = 0;
  if (keeps) {
    const lengthReply: unknown = await redisPipeline([["STRLEN", key]]);
    if (!Array.isArray(lengthReply) || lengthReply.length !== 1) return null;
    const length = lengthReply[0];
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return null;
    const bytes = length;
    if (bytes > 0 && bytes <= NUMBERS_KEPT_BYTES + HEAD_BYTES + 1) {
      const most = apiReadUnits(keptNumbersWork(bytes, NUMBERS_SENT_BYTES));
      const settle = await hold(most);
      if (settle instanceof Response) return settle;
      const readReply: unknown = await redisPipeline([["GET", key]]);
      if (!Array.isArray(readReply) || readReply.length !== 1 || (readReply[0] !== null && typeof readReply[0] !== "string")) {
        const refused = await settle(settledUnits(keptNumbersWork(bytes, 0), most));
        return refused ?? null;
      }
      const raw = readReply[0];
      // What the read really answered, if the copy was written again in between.
      const read = Math.max(bytes, typeof raw === "string" ? Buffer.byteLength(raw) : 0);
      const kept = openKeptNumbers(store, variant, raw, now);
      if (kept) {
        return {
          data: kept.data,
          asOf: new Date(kept.at).toISOString(),
          listed: true,
          settle: (sent) => settle(settledUnits(keptNumbersWork(read, sent), most)),
        };
      }
      // Gone, old or not this store's since it was measured: what was set aside to send is given back, and the numbers are read as below.
      taken = settledUnits(keptNumbersWork(read, 0), most);
      const refused = await settle(taken);
      if (refused) return refused;
    }
  }
  const units = await numbersUnits(store, keeps ? NUMBERS_KEEP_WORK : {});
  const refused = await charge(units, taken);
  if (refused) return refused;
  const cold = variant === "full" ? await readFullNumbersPaid(store, charge, now, taken + units) : await readNumbers(store, now).then((data) => (data ? { data, listed: true } : null));
  if (!cold) return null;
  if (keeps && cold.listed) {
    const value = keptNumbersCopy(store, variant, cold.data, now);
    // Best effort: a copy not kept is read again next time, and paid for again.
    if (value) await redisPipeline([["SET", key, value, "EX", NUMBERS_KEPT_SECONDS]]).catch((error) => console.error("keeping the numbers failed", error));
  }
  return { data: cold.data, asOf: new Date(now).toISOString(), listed: cold.listed, settle: async () => null };
}
