/**
 * A store's earnings by month and by source (426 [BX2]; docs/bx2-earnings-design.md).
 *
 * Twelve calendar months in the store's time zone, newest first. Each source
 * is kept apart with its provenance: Stripe and PayPal as the creator's own
 * accounts recorded them, and amounts the creator typed, which stay "entered
 * by you" and are never shown as verified. In each month every currency has
 * its own line: money in (sales, renewals, entered), money out (refunds,
 * disputed money the bank holds or the buyer won) and the difference, in the
 * month each was recorded. Currencies are never added together and nothing is
 * converted. The difference is before fees and taxes: not profit.
 *
 * Unknown is said, never zero. A source's month is "read" only when every list
 * of that source either ended inside the reading or reached strictly before
 * the month's floor; otherwise it is "unknown" with no amount at all, never a
 * lower number. A record that cannot be understood, or the same record twice,
 * makes its whole source unknown. A month's total is given only when every
 * source of that month was read. A month read in full with nothing in it is a
 * confirmed zero (no lines), apart from unknown.
 *
 * Nothing here ranks, rates or compares the creator by revenue (561 [NE1]):
 * no best month, growth, projection or status.
 *
 * Pure: imports nothing, so the page, the CSV and the tests read one rule.
 */

export const EARNINGS_MONTHS = 12;

/**
 * Hours before UTC midnight that a zone's local midnight can come: no zone is
 * ahead of UTC by more than 14 hours. A month's floor is that early, so a
 * clock change in any zone never lets a month count as reached too soon.
 */
const AHEAD_MS = 14 * 3600_000;

export type EarningsSource = "stripe" | "paypal" | "manual";

/** The provenance said beside each source. */
export const SOURCE_WORDS: Record<EarningsSource, string> = { stripe: "Stripe", paypal: "PayPal", manual: "Entered by you" };

export type MoneyKind = "sale" | "renewal" | "refund" | "dispute";

/** One amount as a provider recorded it: when (ms), in the smallest unit of its currency. */
export type MoneyEvent = { id?: string; at: number; cents: number; currency: string };

/**
 * One list a provider was read for, newest first. `since` (ms) is where the
 * reading began; `complete` says every record from `since` was read;
 * otherwise `reachedBack` is the oldest record's time, below which nothing is
 * known. A list that could not be read at all is `unread`.
 */
export type ListReading =
  | { kind: MoneyKind; events: MoneyEvent[]; since: number; complete: boolean; reachedBack: number | null }
  | { kind: MoneyKind; unread: true };

/** A provider's lists; `notRead` names kinds it has that are never read (PayPal's disputes), said on every month. */
export type ProviderReading = { source: "stripe" | "paypal"; lists: ListReading[]; notRead?: MoneyKind[] };

/** An amount the creator typed: the date (YYYY-MM-DD, the store's own calendar), a positive amount and its currency. */
export type ManualEntry = { id: string; date: string; cents: number; currency: string };

export type EarningsInput = {
  /** When the reading was made (ms): the current month runs to it. */
  at: number;
  timeZone: string;
  providers: ProviderReading[];
  /** null when the entries could not be read. */
  manual: ManualEntry[] | null;
  months?: number;
};

export type MonthLine = {
  currency: string;
  salesCents: number;
  renewalCents: number;
  enteredCents: number;
  refundCents: number;
  disputeCents: number;
  netCents: number;
};

/** Why a source's month is unknown: not read, not reached by a capped reading, a record not understood, or a sum past exact integers. */
export type UnknownWhy = "unread" | "not_reached" | "invalid" | "too_large";

export type SourceMonth =
  | { source: EarningsSource; state: "read"; lines: MonthLine[]; leftOut: MoneyKind[] }
  | { source: EarningsSource; state: "unknown"; why: UnknownWhy };

export type EarningsMonth = {
  month: string;
  current: boolean;
  sources: SourceMonth[];
  /** Every source added within each currency; null when a source of the month is unknown. */
  totals: MonthLine[] | null;
  /** Kinds that are never read, by source: the page says them beside the month. */
  leftOut: { source: EarningsSource; kinds: MoneyKind[] }[];
};

export type Earnings = { timeZone: string; at: number; since: number; months: EarningsMonth[] };

const MONTH = /^(\d{4})-(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY = /^[a-z]{3}$/;

function zoneFormat(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", hourCycle: "h23" });
  } catch {
    return null;
  }
}

/** The calendar month (YYYY-MM) an instant falls in, in a zone. */
function monthIn(format: Intl.DateTimeFormat, at: number): string {
  const parts = format.formatToParts(new Date(at));
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${year}-${month}`;
}

function monthBefore(month: string): string {
  const [, y, m] = MONTH.exec(month) as RegExpExecArray;
  const year = Number(y);
  const index = Number(m) - 1;
  const back = index === 0 ? { year: year - 1, month: 12 } : { year, month: index };
  return `${String(back.year).padStart(4, "0")}-${String(back.month).padStart(2, "0")}`;
}

/** The months shown, newest first, from the reading's time in the zone; empty for an unknown zone or time. */
export function earningsMonths(at: number, timeZone: string, count = EARNINGS_MONTHS): string[] {
  const format = zoneFormat(timeZone);
  if (!format || !Number.isFinite(at) || !Number.isInteger(count) || count < 1) return [];
  const out = [monthIn(format, at)];
  while (out.length < count) out.push(monthBefore(out[out.length - 1]));
  return out;
}

/** UTC midnight of the month's 1st less 14 hours (ms): before the month begins in any zone. */
export function monthFloor(month: string): number {
  const match = MONTH.exec(month);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, 1) - AHEAD_MS;
}

/** Where a reading of the months must begin (ms): the oldest month's floor. NaN for an unknown zone or time. */
export function readingSince(at: number, timeZone: string, count = EARNINGS_MONTHS): number {
  const months = earningsMonths(at, timeZone, count);
  return months.length ? monthFloor(months[months.length - 1]) : Number.NaN;
}

type Sums = Omit<MonthLine, "currency" | "netCents">;
const FIELD: Record<MoneyKind | "entered", keyof Sums> = {
  sale: "salesCents",
  renewal: "renewalCents",
  entered: "enteredCents",
  refund: "refundCents",
  dispute: "disputeCents",
};
const KINDS: ReadonlySet<string> = new Set<MoneyKind>(["sale", "renewal", "refund", "dispute"]);
const isKind = (kind: unknown): kind is MoneyKind => typeof kind === "string" && KINDS.has(kind);
const empty = (): Sums => ({ salesCents: 0, renewalCents: 0, enteredCents: 0, refundCents: 0, disputeCents: 0 });

/** Lines from sums by currency, alphabetical; null when a sum is past exact integers. */
function linesOf(byCurrency: Map<string, Sums>): MonthLine[] | null {
  const lines: MonthLine[] = [];
  for (const [currency, s] of [...byCurrency.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const netCents = s.salesCents + s.renewalCents + s.enteredCents - s.refundCents - s.disputeCents;
    const line = { currency, ...s, netCents };
    if (![line.salesCents, line.renewalCents, line.enteredCents, line.refundCents, line.disputeCents, line.netCents].every(Number.isSafeInteger)) return null;
    lines.push(line);
  }
  return lines;
}

function add(into: Map<string, Map<string, Sums>>, month: string, currency: string, field: keyof Sums, cents: number): void {
  let byCurrency = into.get(month);
  if (!byCurrency) into.set(month, (byCurrency = new Map()));
  let sums = byCurrency.get(currency);
  if (!sums) byCurrency.set(currency, (sums = empty()));
  sums[field] += cents;
}

const validCents = (cents: unknown, positive: boolean): cents is number =>
  typeof cents === "number" && Number.isSafeInteger(cents) && (positive ? cents > 0 : cents >= 0);

const validId = (id: unknown, seen: Set<string>): boolean => {
  if (id === undefined) return true;
  if (typeof id !== "string" || !id || seen.has(id)) return false;
  seen.add(id);
  return true;
};

const realDate = (date: string): boolean => {
  const match = DATE.exec(date);
  if (!match) return false;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date;
};

/** A source's months: read with its sums, or unknown with why, for each month shown. */
type SourceResult = { source: EarningsSource; months: Map<string, SourceMonth> };

function unknownEverywhere(source: EarningsSource, months: string[], why: UnknownWhy): SourceResult {
  return { source, months: new Map(months.map((m) => [m, { source, state: "unknown", why }])) };
}

function finish(source: EarningsSource, months: string[], sums: Map<string, Map<string, Sums>>, known: (month: string) => UnknownWhy | null, leftOut: MoneyKind[]): SourceResult {
  const out = new Map<string, SourceMonth>();
  for (const month of months) {
    const why = known(month);
    if (why) {
      out.set(month, { source, state: "unknown", why });
      continue;
    }
    const lines = linesOf(sums.get(month) ?? new Map());
    out.set(month, lines ? { source, state: "read", lines, leftOut: [...leftOut] } : { source, state: "unknown", why: "too_large" });
  }
  return { source, months: out };
}

function providerMonths(provider: ProviderReading, months: string[], format: Intl.DateTimeFormat): SourceResult {
  const { source } = provider;
  const shown = new Set(months);
  const newest = months[0];
  const oldest = months[months.length - 1];
  const sums = new Map<string, Map<string, Sums>>();
  const seen = new Set<string>();
  const read: { since: number; complete: boolean; reachedBack: number | null }[] = [];
  let unread = false;
  for (const list of provider.lists) {
    if (!list || typeof list !== "object" || !isKind(list.kind)) return unknownEverywhere(source, months, "invalid");
    if ("unread" in list) {
      unread = true;
      continue;
    }
    if (!Array.isArray(list.events) || !Number.isFinite(list.since) || typeof list.complete !== "boolean") return unknownEverywhere(source, months, "invalid");
    if (list.reachedBack !== null && !Number.isFinite(list.reachedBack)) return unknownEverywhere(source, months, "invalid");
    read.push({ since: list.since, complete: list.complete, reachedBack: list.reachedBack });
    for (const event of list.events) {
      if (!event || typeof event !== "object" || !validId(event.id, seen)) return unknownEverywhere(source, months, "invalid");
      if (typeof event.at !== "number" || !Number.isFinite(event.at) || !validCents(event.cents, false)) return unknownEverywhere(source, months, "invalid");
      const currency = typeof event.currency === "string" ? event.currency.toLowerCase() : "";
      if (!CURRENCY.test(currency)) return unknownEverywhere(source, months, "invalid");
      const month = monthIn(format, event.at);
      // A record in a month after the reading's own cannot be right: the whole source is unknown, not trimmed.
      if (month > newest) return unknownEverywhere(source, months, "invalid");
      // Read only because the reading begins at the oldest month's floor: outside the months shown.
      if (month < oldest || !shown.has(month)) continue;
      add(sums, month, currency, FIELD[list.kind], event.cents);
    }
  }
  if (unread) return unknownEverywhere(source, months, "unread");
  const notRead = (provider.notRead ?? []).filter((kind, i, all) => isKind(kind) && all.indexOf(kind) === i);
  const reached = (month: string): UnknownWhy | null => {
    const floor = monthFloor(month);
    for (const list of read) {
      if (list.since > floor) return "not_reached";
      if (!list.complete && !(list.reachedBack !== null && list.reachedBack < floor)) return "not_reached";
    }
    return null;
  };
  return finish(source, months, sums, reached, notRead);
}

function manualMonths(entries: ManualEntry[] | null, months: string[]): SourceResult {
  const source: EarningsSource = "manual";
  if (entries === null || !Array.isArray(entries)) return unknownEverywhere(source, months, "unread");
  const shown = new Set(months);
  const newest = months[0];
  const sums = new Map<string, Map<string, Sums>>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !validId(entry.id, seen)) return unknownEverywhere(source, months, "invalid");
    if (typeof entry.date !== "string" || !realDate(entry.date) || !validCents(entry.cents, true)) return unknownEverywhere(source, months, "invalid");
    const currency = typeof entry.currency === "string" ? entry.currency.toLowerCase() : "";
    if (!CURRENCY.test(currency)) return unknownEverywhere(source, months, "invalid");
    const month = entry.date.slice(0, 7);
    if (month > newest) return unknownEverywhere(source, months, "invalid");
    if (!shown.has(month)) continue;
    add(sums, month, currency, "enteredCents", entry.cents);
  }
  return finish(source, months, sums, () => null, []);
}

/** The twelve months by source and currency; null for an unknown zone or reading time. */
export function earningsByMonth(input: EarningsInput): Earnings | null {
  const format = zoneFormat(input.timeZone);
  const months = earningsMonths(input.at, input.timeZone, input.months ?? EARNINGS_MONTHS);
  if (!format || !months.length) return null;
  const results = [...input.providers.map((p) => providerMonths(p, months, format)), manualMonths(input.manual, months)];
  return {
    timeZone: input.timeZone,
    at: input.at,
    since: monthFloor(months[months.length - 1]),
    months: months.map((month, i) => {
      const sources = results.map((r) => r.months.get(month) as SourceMonth);
      let totals: MonthLine[] | null = null;
      if (sources.every((s) => s.state === "read")) {
        const byCurrency = new Map<string, Sums>();
        for (const s of sources) {
          if (s.state !== "read") continue;
          for (const line of s.lines) {
            const sums = byCurrency.get(line.currency) ?? empty();
            for (const field of Object.values(FIELD)) sums[field] += line[field];
            byCurrency.set(line.currency, sums);
          }
        }
        totals = linesOf(byCurrency);
      }
      const leftOut = sources.flatMap((s) => (s.state === "read" && s.leftOut.length ? [{ source: s.source, kinds: [...s.leftOut] }] : []));
      return { month, current: i === 0, sources, totals, leftOut };
    }),
  };
}
