/**
 * A store's earnings by month and by source (426 [BX2]; docs/bx2-earnings-design.md).
 *
 * Twelve calendar months in the store's time zone, newest first. Each source
 * is kept apart with its provenance: Stripe and PayPal as the creator's own
 * accounts recorded them, and amounts the creator typed, which stay "entered
 * by you" and are never shown as verified. In each month every currency has
 * its own line: money in (sales, renewals, entered), money out (refunds,
 * disputed money the bank holds or the buyer won) and the difference, in the
 * month each was recorded, and money given back (a dispute won, a refund that
 * failed) as money in, in the month it came back, so a month shown is never
 * rewritten by what happens later. Currencies are never added together and
 * nothing is converted. The difference is before fees and taxes: not profit.
 *
 * Unknown is said, never zero. A source's month is "read" only when every list
 * of that source either ended inside the reading or reached strictly before
 * the month's floor; otherwise it is "unknown" with no amount at all, never a
 * lower number. A record that cannot be understood, the same record twice,
 * or a record after the reading's own time (an entry after its day), makes
 * its whole source unknown; so does a provider given twice, a provider's
 * record without an id of its own provider (a PayPal sale given as Stripe is
 * never counted twice), and a kind of money the provider has that was neither
 * read, said unread nor said left out (EXPECTED_KINDS: a missing refund list
 * is never a confirmed zero). Only kinds a provider's reading truly cannot
 * hold may be said left out (MAY_LEAVE_OUT: disputes and money given back);
 * a sale, renewal or refund said left out makes the source unknown, and so
 * does a list of money given back beside disputes said left out (the money
 * back would be added without the debit it gives back). A record
 * whose id holds another provider's prefix ("stripe:paypal:…") is not its
 * source's own, and the same id in two sources makes each month it lands in
 * unknown for those sources. Kinds read only in part are said (PARTLY_READ:
 * PayPal's partial refunds are never recorded), and `netWords` says what a
 * difference is after, never "after disputes" without them. Every net is worked out
 * exactly, never rounded. A month's total is given only when every source of
 * that month was read. A month read in full with nothing in it is a confirmed
 * zero (no lines), apart from unknown. A time zone in which a month could
 * begin before its floor gives nothing.
 *
 * Nothing here ranks, rates or compares the creator by revenue (561 [NE1]):
 * no best month, growth, projection or status.
 *
 * Pure: imports nothing, so the page, the CSV and the tests read one rule.
 */

export const EARNINGS_MONTHS = 12;

/**
 * Hours before UTC midnight that a zone's local midnight can come: no IANA zone
 * is ahead of UTC by more than 14 hours. A month's floor is that early, so a
 * clock change in any zone never lets a month count as reached too soon. Intl
 * also takes offset zones up to +23:59, so earningsMonths checks the floor of
 * every month shown in the zone itself and gives nothing where a month would
 * begin before it (Claude 2 on #2941).
 */
const AHEAD_MS = 14 * 3600_000;

/** The widest time a Date holds (ms either side of 1970): past it, Intl throws, so such a time is never formatted. */
const DATE_LIMIT_MS = 8.64e15;
const inDateRange = (at: number): boolean => Number.isFinite(at) && Math.abs(at) <= DATE_LIMIT_MS;

export type EarningsSource = "stripe" | "paypal" | "manual";

/** The provenance said beside each source. */
export const SOURCE_WORDS: Record<EarningsSource, string> = { stripe: "Stripe", paypal: "PayPal", manual: "Entered by you" };

/**
 * Money in: a sale, a renewal (any paid invoice of a membership after the one
 * its checkout counted), money given back (`reinstated`: a dispute won, a
 * refund that failed). Money out: a refund, a dispute (when the bank took the
 * money, whatever happens to it later).
 */
export type MoneyKind = "sale" | "renewal" | "refund" | "dispute" | "reinstated";

/**
 * One amount as a provider recorded it: when (ms), in the smallest unit of its
 * currency. `id` is the provider's own, prefixed by it ("stripe:…",
 * "paypal:…"): a provider's record without one cannot be checked for being
 * counted twice, so it makes its source unknown. It stays optional in the type
 * only so a missing id reaches the rule and is refused there.
 */
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

/**
 * A provider's lists; `notRead` names kinds it has that are never read
 * (PayPal's disputes), said on every month, only from MAY_LEAVE_OUT. Every kind of EXPECTED_KINDS for
 * the provider is either in a list (read or unread) or in `notRead`, never
 * both; several lists of one kind are added (Stripe's checkouts and extras are
 * two of "sale"), and the ids keep a record from being added twice.
 */
export type ProviderReading = { source: "stripe" | "paypal"; lists: ListReading[]; notRead?: MoneyKind[] };

/**
 * The kinds of money each provider has (Claude 2 on #2941): a reading that
 * leaves one out without saying so is unknown, never a confirmed zero.
 * PayPal has no renewals (its sales are one payment each) and its money given
 * back is never apart from its disputes, which are not read.
 */
export const EXPECTED_KINDS: Readonly<Record<"stripe" | "paypal", readonly MoneyKind[]>> = {
  stripe: ["sale", "renewal", "refund", "dispute", "reinstated"],
  paypal: ["sale", "refund", "dispute"],
};

/**
 * The kinds a provider's reading may say are never read and still give the
 * month a total, said beside it (pre-review of #2941 at 925ae7d9ec): Stripe's
 * disputes and money given back, PayPal's disputes. Money in (sales, renewals)
 * and refunds may never be left out: a reading that says so is unknown, never
 * a total "after refunds" without them, and never a confirmed zero. Disputes
 * said left out take money given back with them: a reading that lists it
 * beside them is unknown (Claude 2 on #2941 at b9fa7aa7).
 */
export const MAY_LEAVE_OUT: Readonly<Record<"stripe" | "paypal", readonly MoneyKind[]>> = {
  stripe: ["dispute", "reinstated"],
  paypal: ["dispute"],
};

/**
 * Kinds a provider's lists hold only in part, said on every month the
 * provider is read: PayPal's refunds are those refunded in full, the only
 * ones lib/paypal-sales.ts records with an amount (a capture
 * PARTIALLY_REFUNDED is written down without one: what PayPal gave back is
 * not read), so a partial PayPal refund is never taken off.
 */
export const PARTLY_READ: Readonly<Record<"stripe" | "paypal", readonly MoneyKind[]>> = {
  stripe: [],
  paypal: ["refund"],
};

/** An amount the creator typed: the date (YYYY-MM-DD, the store's own calendar), a positive amount and its currency. */
export type ManualEntry = { id: string; date: string; cents: number; currency: string };

export type EarningsInput = {
  /**
   * When the reading was made (ms): the current month runs to it, so it is
   * taken once every list was read. A record after it, or an entry dated after
   * its day in the zone, makes its source unknown.
   */
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
  reinstatedCents: number;
  netCents: number;
};

/** Why a source's month is unknown: not read, not reached by a capped reading, a record not understood, or a sum past exact integers. */
export type UnknownWhy = "unread" | "not_reached" | "invalid" | "too_large";

export type SourceMonth =
  | { source: EarningsSource; state: "read"; lines: MonthLine[]; leftOut: MoneyKind[]; partly: MoneyKind[] }
  | { source: EarningsSource; state: "unknown"; why: UnknownWhy };

export type EarningsMonth = {
  month: string;
  current: boolean;
  sources: SourceMonth[];
  /** Every source added within each currency; null when a source of the month is unknown or a sum is past exact integers. */
  totals: MonthLine[] | null;
  /** Kinds that are never read, by source: the page says them beside the month. */
  leftOut: { source: EarningsSource; kinds: MoneyKind[] }[];
  /** Kinds read only in part, by source (PayPal: full refunds only): said beside the month too. */
  partly: { source: EarningsSource; kinds: MoneyKind[] }[];
};

export type Earnings = { timeZone: string; at: number; since: number; months: EarningsMonth[] };

// Years 1000 to 9999 only: Date.UTC reads a year below 100 as 19xx, and string order holds only for four digits.
const MONTH = /^([1-9]\d{3})-(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY = /^[a-z]{3}$/;

function zoneFormat(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23" });
  } catch {
    return null;
  }
}

/** The calendar day (YYYY-MM-DD) an instant falls on, in a zone; only for a time inside Date's range. */
function dayIn(format: Intl.DateTimeFormat, at: number): string {
  const parts = format.formatToParts(new Date(at));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The calendar month (YYYY-MM) an instant falls in, in a zone; only for a time inside Date's range. */
function monthIn(format: Intl.DateTimeFormat, at: number): string {
  return dayIn(format, at).slice(0, -3);
}

function monthBefore(month: string): string {
  const [, y, m] = MONTH.exec(month) as RegExpExecArray;
  const year = Number(y);
  const index = Number(m) - 1;
  const back = index === 0 ? { year: year - 1, month: 12 } : { year, month: index };
  return `${String(back.year).padStart(4, "0")}-${String(back.month).padStart(2, "0")}`;
}

/**
 * The months shown, newest first, from the reading's time in the zone; empty
 * for an unknown zone or time, and for a zone in which a month shown would
 * begin before its floor (an offset zone more than 14 hours ahead of UTC).
 */
export function earningsMonths(at: number, timeZone: string, count = EARNINGS_MONTHS): string[] {
  const format = zoneFormat(timeZone);
  if (!format || !inDateRange(at) || !Number.isInteger(count) || count < 1) return [];
  const first = monthIn(format, at);
  // A year of other than four digits (far past or future) is not a month this rule compares: nothing, never a throw.
  if (!MONTH.exec(first)) return [];
  const out = [first];
  while (out.length < count) {
    const back = monthBefore(out[out.length - 1]);
    if (!MONTH.exec(back)) return [];
    out.push(back);
  }
  // The instant before each month's floor must still be in an earlier month in this zone; otherwise the month begins
  // before its floor, a reading from readingSince misses its first hours and it would be called read (Claude 2 on #2941).
  for (const month of out) {
    const before = monthFloor(month) - 1;
    if (!inDateRange(before) || !(monthIn(format, before) < month)) return [];
  }
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
  reinstated: "reinstatedCents",
};
const KINDS: ReadonlySet<string> = new Set<MoneyKind>(["sale", "renewal", "refund", "dispute", "reinstated"]);
const isKind = (kind: unknown): kind is MoneyKind => typeof kind === "string" && KINDS.has(kind);
const empty = (): Sums => ({ salesCents: 0, renewalCents: 0, enteredCents: 0, refundCents: 0, disputeCents: 0, reinstatedCents: 0 });

/**
 * Lines from sums by currency, alphabetical; null when a sum is past exact
 * integers. Each sum only grows, so once past exact integers it stays past
 * and is caught here; the net is then worked out exactly (BigInt), so money
 * in past exact integers before money out never gives a safe but wrong net
 * (Codex J on #2941).
 */
function linesOf(byCurrency: Map<string, Sums>): MonthLine[] | null {
  const lines: MonthLine[] = [];
  for (const [currency, s] of [...byCurrency.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (![s.salesCents, s.renewalCents, s.enteredCents, s.refundCents, s.disputeCents, s.reinstatedCents].every(Number.isSafeInteger)) return null;
    const net =
      BigInt(s.salesCents) + BigInt(s.renewalCents) + BigInt(s.enteredCents) + BigInt(s.reinstatedCents) - BigInt(s.refundCents) - BigInt(s.disputeCents);
    const netCents = Number(net);
    if (!Number.isSafeInteger(netCents) || BigInt(netCents) !== net) return null;
    lines.push({ currency, ...s, netCents });
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

/** Every provider's id prefix: a provider's id never holds one after its own ("stripe:paypal:…"). */
const PROVIDER_PREFIX = /^(stripe|paypal):/i;

/**
 * An entry's id: optional only where `required` is false; never the same twice;
 * with `prefix`, its provider's own, the rest never starting with a provider's
 * prefix again (a PayPal row of readPaidSales prefixed by a caller is not Stripe's).
 */
const validId = (id: unknown, seen: Set<string>, required: boolean, prefix = ""): boolean => {
  if (id === undefined) return !required;
  if (typeof id !== "string" || id.length <= prefix.length || !id.startsWith(prefix) || seen.has(id)) return false;
  if (prefix && PROVIDER_PREFIX.test(id.slice(prefix.length))) return false;
  seen.add(id);
  return true;
};

const realDate = (date: string): boolean => {
  const match = DATE.exec(date);
  if (!match) return false;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date;
};

/**
 * A source's months: read with its sums, or unknown with why, for each month
 * shown; `ids` holds every id it read, with the month shown it was added to
 * (null: outside the months shown), so an id in two sources is caught.
 */
type SourceResult = { source: EarningsSource; months: Map<string, SourceMonth>; ids: Map<string, string | null> };

function unknownEverywhere(source: EarningsSource, months: string[], why: UnknownWhy): SourceResult {
  return { source, months: new Map(months.map((m) => [m, { source, state: "unknown", why }])), ids: new Map() };
}

function finish(source: EarningsSource, months: string[], sums: Map<string, Map<string, Sums>>, ids: Map<string, string | null>, known: (month: string) => UnknownWhy | null, leftOut: MoneyKind[], partly: readonly MoneyKind[]): SourceResult {
  const out = new Map<string, SourceMonth>();
  for (const month of months) {
    const why = known(month);
    if (why) {
      out.set(month, { source, state: "unknown", why });
      continue;
    }
    const lines = linesOf(sums.get(month) ?? new Map());
    out.set(month, lines ? { source, state: "read", lines, leftOut: [...leftOut], partly: [...partly] } : { source, state: "unknown", why: "too_large" });
  }
  return { source, months: out, ids };
}

function providerMonths(provider: ProviderReading, months: string[], format: Intl.DateTimeFormat, at: number): SourceResult {
  const { source } = provider;
  const shown = new Set(months);
  const newest = months[0];
  const oldest = months[months.length - 1];
  const oldestFloor = monthFloor(oldest);
  const sums = new Map<string, Map<string, Sums>>();
  const seen = new Set<string>();
  const ids = new Map<string, string | null>();
  const read: { since: number; complete: boolean; reachedBack: number | null }[] = [];
  // Every kind the provider has is in a list or said not read, never both, and only kinds the rule knows (Claude 2 on #2941).
  if (!Array.isArray(provider.lists) || (provider.notRead !== undefined && !Array.isArray(provider.notRead))) return unknownEverywhere(source, months, "invalid");
  const notRead = [...new Set(provider.notRead ?? [])];
  if (!notRead.every(isKind)) return unknownEverywhere(source, months, "invalid");
  // A kind it must read, said not read: the source was not read, never a total without it (pre-review of #2941).
  if (!notRead.every((kind) => MAY_LEAVE_OUT[source].includes(kind))) return unknownEverywhere(source, months, "unread");
  const listed = new Set(provider.lists.map((list) => (list && typeof list === "object" ? list.kind : undefined)));
  if (notRead.some((kind) => listed.has(kind))) return unknownEverywhere(source, months, "invalid");
  if (!EXPECTED_KINDS[source].every((kind) => listed.has(kind) || notRead.includes(kind))) return unknownEverywhere(source, months, "invalid");
  // Money given back is only what a dispute took coming back: beside disputes not read, a list of it (even empty)
  // would add money whose debit was never taken off, so the reading is refused, never trimmed (Claude 2 on #2941 at b9fa7aa7).
  if (notRead.includes("dispute") && listed.has("reinstated")) return unknownEverywhere(source, months, "invalid");
  const prefix = `${source}:`;
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
      // Its own provider's id, required: a PayPal record given as Stripe, or a record with no id, is never added (Claude 2 on #2941).
      if (!event || typeof event !== "object" || !validId(event.id, seen, true, prefix)) return unknownEverywhere(source, months, "invalid");
      if (typeof event.at !== "number" || !inDateRange(event.at) || !validCents(event.cents, false)) return unknownEverywhere(source, months, "invalid");
      // The current month runs to the reading's time: a record after it is not money so far (Codex J on #2941).
      if (event.at > at) return unknownEverywhere(source, months, "invalid");
      ids.set(event.id as string, null);
      // Read only because the reading begins at the oldest month's floor: before every month shown, in any zone.
      if (event.at < oldestFloor) continue;
      const currency = typeof event.currency === "string" ? event.currency.toLowerCase() : "";
      if (!CURRENCY.test(currency)) return unknownEverywhere(source, months, "invalid");
      const month = monthIn(format, event.at);
      // A record in a month after the reading's own cannot be right: the whole source is unknown, not trimmed.
      if (month > newest) return unknownEverywhere(source, months, "invalid");
      // Read only because the reading begins at the oldest month's floor: outside the months shown.
      if (month < oldest || !shown.has(month)) continue;
      ids.set(event.id as string, month);
      add(sums, month, currency, FIELD[list.kind], event.cents);
    }
  }
  if (unread) return unknownEverywhere(source, months, "unread");
  const reached = (month: string): UnknownWhy | null => {
    const floor = monthFloor(month);
    for (const list of read) {
      if (list.since > floor) return "not_reached";
      if (!list.complete && !(list.reachedBack !== null && list.reachedBack < floor)) return "not_reached";
    }
    return null;
  };
  return finish(source, months, sums, ids, reached, notRead, PARTLY_READ[source]);
}

function manualMonths(entries: ManualEntry[] | null, months: string[], today: string): SourceResult {
  const source: EarningsSource = "manual";
  if (entries === null || !Array.isArray(entries)) return unknownEverywhere(source, months, "unread");
  const shown = new Set(months);
  const newest = months[0];
  const sums = new Map<string, Map<string, Sums>>();
  const seen = new Set<string>();
  const ids = new Map<string, string | null>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !validId(entry.id, seen, true)) return unknownEverywhere(source, months, "invalid");
    if (typeof entry.date !== "string" || !realDate(entry.date) || !validCents(entry.cents, true)) return unknownEverywhere(source, months, "invalid");
    const currency = typeof entry.currency === "string" ? entry.currency.toLowerCase() : "";
    if (!CURRENCY.test(currency)) return unknownEverywhere(source, months, "invalid");
    const month = entry.date.slice(0, 7);
    // An entry dated after the reading's own day, in the store's zone, is not money so far (Codex J on #2941).
    if (month > newest || entry.date > today) return unknownEverywhere(source, months, "invalid");
    ids.set(entry.id, shown.has(month) ? month : null);
    if (!shown.has(month)) continue;
    add(sums, month, currency, "enteredCents", entry.cents);
  }
  return finish(source, months, sums, ids, () => null, [], []);
}

const PROVIDERS: ReadonlySet<string> = new Set(["stripe", "paypal"]);

/**
 * The same id in two sources (an ES1 entry of a Stripe payment the Stripe
 * reading already holds) is one payment that would be added twice: in every
 * month shown where any of its copies landed, each source holding it is
 * unknown, so the month has no total (pre-review of #2941 at 925ae7d9ec).
 */
function refuseSharedIds(results: SourceResult[]): void {
  const holders = new Map<string, SourceResult[]>();
  for (const result of results) {
    for (const id of result.ids.keys()) holders.set(id, [...(holders.get(id) ?? []), result]);
  }
  for (const [id, holding] of holders) {
    if (holding.length < 2) continue;
    const landed = holding.flatMap((r) => {
      const month = r.ids.get(id);
      return month ? [month] : [];
    });
    for (const result of holding) {
      for (const month of landed) result.months.set(month, { source: result.source, state: "unknown", why: "invalid" });
    }
  }
}

const listWords = (names: string[]): string => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * What a difference is after, in plain words, from the sources it adds (one
 * source's line, or a month's sources for its total): only what was taken off
 * is named, and what was not read is said (pre-review of #2941 at 925ae7d9ec).
 * Unknown sources are not in a difference, so they are not counted here.
 */
export function netWords(sources: readonly SourceMonth[]): string {
  const read = sources.filter((s): s is Extract<SourceMonth, { state: "read" }> => s.state === "read" && s.source !== "manual");
  if (!read.length) return "Nothing taken off: no Stripe or PayPal reading in it.";
  const name = (s: { source: EarningsSource }) => SOURCE_WORDS[s.source];
  const taken = read.filter((s) => !s.leftOut.includes("dispute")).map(name);
  const notTaken = read.filter((s) => s.leftOut.includes("dispute")).map(name);
  const sentences: string[] = [];
  if (!notTaken.length) sentences.push("After refunds and disputes.");
  else if (!taken.length) sentences.push(`After refunds, before disputes: ${listWords(notTaken)} disputes are not read, so they are not taken off.`);
  else sentences.push(`After refunds and ${listWords(taken)} disputes, before ${listWords(notTaken)} disputes, which are not read.`);
  const noBack = read.filter((s) => s.leftOut.includes("reinstated")).map(name);
  if (noBack.length) sentences.push(`Money given back by ${listWords(noBack)} is not read, so it is not added.`);
  const partRefunds = read.filter((s) => s.partly.includes("refund")).map(name);
  if (partRefunds.length) sentences.push(`Partial ${listWords(partRefunds)} refunds are not recorded, so they are not taken off.`);
  return sentences.join(" ");
}

/**
 * The twelve months by source and currency; null for an unknown zone or
 * reading time, or a provider that is not Stripe or PayPal.
 */
export function earningsByMonth(input: EarningsInput): Earnings | null {
  const format = zoneFormat(input.timeZone);
  const months = earningsMonths(input.at, input.timeZone, input.months ?? EARNINGS_MONTHS);
  if (!format || !months.length) return null;
  if (!Array.isArray(input.providers) || !input.providers.every((p) => p && typeof p === "object" && PROVIDERS.has(p.source))) return null;
  // One wrapper a provider: two of the same would each keep their own seen ids and could add one payment twice,
  // so a provider given more than once is unknown, said once (Codex J on #2941).
  const given = input.providers.map((p) => p.source);
  const providers = input.providers.flatMap((p, i) => {
    if (given.indexOf(p.source) !== i) return [];
    return [given.lastIndexOf(p.source) === i ? providerMonths(p, months, format, input.at) : unknownEverywhere(p.source, months, "invalid")];
  });
  const results = [...providers, manualMonths(input.manual, months, dayIn(format, input.at))];
  refuseSharedIds(results);
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
            // Each field only grows, so a sum past exact integers stays past and linesOf says it as unknown.
            for (const field of Object.values(FIELD)) sums[field] += line[field];
            byCurrency.set(line.currency, sums);
          }
        }
        totals = linesOf(byCurrency);
      }
      const leftOut = sources.flatMap((s) => (s.state === "read" && s.leftOut.length ? [{ source: s.source, kinds: [...s.leftOut] }] : []));
      const partly = sources.flatMap((s) => (s.state === "read" && s.partly.length ? [{ source: s.source, kinds: [...s.partly] }] : []));
      return { month, current: i === 0, sources, totals, leftOut, partly };
    }),
  };
}
