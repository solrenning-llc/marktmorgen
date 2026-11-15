/**
 * Monthly recurring revenue, month by month, split by what moved it (added 12
 * October 2026), as ChartMogul, Baremetrics and ProfitWell show it: new,
 * expansion, contraction, canceled and reactivated. And ARPU, ARR and net
 * revenue retention over twelve months.
 *
 * Counted per member (a Stripe customer), so a member who moves to a dearer
 * membership is expansion and not one leaving and one joining:
 *
 *   - new:          paying nothing at the start of the month, paying at its
 *                   end, and never paid before;
 *   - reactivated:  the same, for somebody who had paid before and left;
 *   - expansion and contraction: paying at both ends, more or less;
 *   - canceled:     paying at the start, nothing at the end.
 *
 * What each membership was worth at a moment comes from its invoices on the
 * creator's own Stripe account: each invoice line of a membership says the
 * price it was charged at from the start of its period, so a switch to
 * another plan shows from the day it was made. At list price, before
 * discounts and tax, as the MRR the page shows above; free trials are worth
 * nothing until they end; and "now" is the membership as Stripe holds it
 * today, so the last month ends on exactly the MRR above.
 *
 * Read with the page's other numbers (lib/membership-numbers.ts), in the same
 * ten-minute reading, never on a visit to the store.
 */
import type { Sub } from "@/lib/membership-numbers";

const DAY = 86_400;
const PAYING = new Set(["active", "past_due"]);
const NEVER_PAID = new Set(["incomplete", "incomplete_expired"]);

export type Movement = {
  /** "2026-09" */
  month: string;
  start: number;
  new: number;
  expansion: number;
  contraction: number;
  canceled: number;
  reactivated: number;
  end: number;
  /** Members paying at the month's end. */
  members: number;
};

export type Movements = {
  months: Movement[];
  /** Average revenue per paying member, a month, now. */
  arpu: number;
  arr: number;
  /** Of what the members paying twelve months ago brought then, the share they bring now (1 = all of it); null when nobody was paying then. */
  nrr: number | null;
};

type Entry = { at: number; value: number };

/** A payment as a month's worth, unrounded. */
function perMonth(amount: number, interval: string, count: number): number {
  const per = interval === "year" ? 1 / 12 : interval === "week" ? 52 / 12 : interval === "day" ? 365 / 12 : 1;
  return (amount * per) / Math.max(1, count);
}

type Line = {
  amount?: unknown;
  quantity?: unknown;
  proration?: unknown;
  subscription?: unknown;
  period?: { start?: unknown } | null;
  price?: { unit_amount?: unknown; recurring?: { interval?: unknown; interval_count?: unknown } | null } | null;
  pricing?: { unit_amount_decimal?: unknown } | null;
  parent?: { subscription_item_details?: { subscription?: unknown; proration?: unknown } | null } | null;
};
export type Invoice = {
  created?: unknown;
  subscription?: unknown;
  customer?: unknown;
  parent?: { subscription_details?: { subscription?: unknown } | null } | null;
  lines?: { data?: Line[]; has_more?: unknown } | null;
};

/**
 * An invoice or one of its lines in a shape these rules cannot read (CX-123
 * rule 24). The movements are then not shown (lib/membership-numbers.ts
 * catches it, as it does an invoice reading that failed), rather than shown
 * with a member worth nothing for a month they paid.
 */
export class UnreadInvoiceError extends Error {
  constructor(what: string) {
    super(`Stripe gave ${what} in a shape that cannot be read`);
    this.name = "UnreadInvoiceError";
  }
}

/** A number Stripe gave, or a numeric string (a decimal price); null when it gave none (absent or null). Anything else throws. */
const num = (v: unknown, what: string): number | null => {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new UnreadInvoiceError(what);
  return n;
};
/** A subscription Stripe referred to: its id, or the expanded object with that id; "" when it gave none (absent or null). Anything else throws. */
const ref = (v: unknown, what: string): string => {
  if (v === undefined || v === null) return "";
  const id = typeof v === "object" && !Array.isArray(v) ? (v as { id?: unknown }).id : v;
  if (typeof id !== "string" || !id) throw new UnreadInvoiceError(what);
  return id;
};
/** A count Stripe gave (a quantity, an interval count): a number, null when it gave none (absent or null). Text throws, even text that reads as a number. */
const whole = (v: unknown, what: string): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new UnreadInvoiceError(what);
  return v;
};
/** A yes or no Stripe gave: false when it gave none (absent or null). Anything else throws. */
const bool = (v: unknown, what: string): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new UnreadInvoiceError(what);
  return v;
};
/** The intervals a Stripe price recurs by. */
const INTERVALS = new Set(["day", "week", "month", "year"]);
/** An object Stripe nests what a line is read by in (`parent` and its details, a price, its recurring terms, decimal pricing, a period): the object, or undefined when it gave none (absent or null). Anything else throws. */
const obj = <T,>(v: T, what: string): NonNullable<T> | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new UnreadInvoiceError(what);
  return v as NonNullable<T>;
};
/** A line's subscription item details under its `parent`, read exactly as `obj` reads them. */
const details = (line: Line) => obj(obj(line.parent, "an invoice line's parent")?.subscription_item_details, "an invoice line's subscription details");

/**
 * What each membership was charged at, and from when, from its invoices.
 * Either shape Stripe has given a line: the older one with the price on it,
 * and the newer one with the subscription under `parent`.
 */
export function pricesFrom(invoices: Invoice[], subs: Map<string, Sub>): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  for (const invoice of invoices) {
    if (!invoice || typeof invoice !== "object") throw new UnreadInvoiceError("an invoice");
    const fromInvoice = ref(invoice.subscription, "an invoice's subscription") || ref(obj(obj(invoice.parent, "an invoice's parent")?.subscription_details, "an invoice's subscription details")?.subscription, "an invoice's subscription");
    const lines = invoice.lines === undefined || invoice.lines === null ? [] : invoice.lines.data;
    if (!Array.isArray(lines)) throw new UnreadInvoiceError("an invoice's lines");
    // Stripe embeds at most 10 lines: one that says there are more is a list cut short, not the whole invoice, when it
    // may hold a member's line. Another business's invoice on the same Stripe account is passed over.
    if (bool(invoice.lines?.has_more, "whether an invoice has more lines")) {
      const lineIds = (lines as unknown[]).map((l) => {
        if (!l || typeof l !== "object") throw new UnreadInvoiceError("an invoice line");
        return ref((l as Line).subscription, "an invoice line's subscription") || ref(details(l as Line)?.subscription, "an invoice line's subscription");
      });
      const members = new Set([...subs.values()].map((s) => s.customer).filter((c): c is string => typeof c === "string" && c !== ""));
      // No customer given may be a member's (with Accounts v2 an invoice can carry only customer_account): unknown.
      const customer = ref(invoice.customer, "an invoice's customer");
      if (subs.has(fromInvoice) || lineIds.some((id) => subs.has(id)) || customer === "" || members.has(customer)) {
        throw new UnreadInvoiceError("an invoice with more lines than it gave");
      }
      continue;
    }
    for (const line of lines as unknown[] as Line[]) {
      if (!line || typeof line !== "object") throw new UnreadInvoiceError("an invoice line");
      const id = ref(line.subscription, "an invoice line's subscription") || ref(details(line)?.subscription, "an invoice line's subscription") || fromInvoice;
      const sub = subs.get(id);
      if (!sub) continue;
      const amount = num(line.amount, "an invoice line's amount");
      if (amount === null) throw new UnreadInvoiceError("an invoice line with no amount");
      if (amount < 0) continue;
      const price = obj(line.price, "an invoice line's price");
      const unit = num(price?.unit_amount, "an invoice line's price") || num(obj(line.pricing, "an invoice line's decimal pricing")?.unit_amount_decimal, "an invoice line's decimal price") || 0;
      const proration = bool(line.proration, "an invoice line's proration") || bool(details(line)?.proration, "an invoice line's proration");
      // A line without its price says only what a part of a period cost; that is not a month's worth.
      if (!unit && proration) continue;
      // None given counts one; 0 is worth nothing, never one at the full price.
      const given = whole(line.quantity, "an invoice line's quantity");
      if (given !== null && (given < 0 || !Number.isInteger(given))) throw new UnreadInvoiceError("an invoice line's quantity");
      const quantity = given === null ? 1 : given;
      const recurring = obj(price?.recurring, "an invoice line's recurring terms");
      // None given (absent or null) is the membership's own terms; any other value than Stripe's four throws.
      const every = recurring?.interval;
      if (every !== undefined && every !== null && (typeof every !== "string" || !INTERVALS.has(every))) throw new UnreadInvoiceError("an invoice line's interval");
      const interval = typeof every === "string" ? every : sub.interval;
      // A whole number from 1; none given is one with the line's interval, or the membership's own.
      const counted = whole(recurring?.interval_count, "an invoice line's interval count");
      if (counted !== null && (counted < 1 || !Number.isInteger(counted))) throw new UnreadInvoiceError("an invoice line's interval count");
      const count = counted ?? (typeof every === "string" ? 1 : sub.count);
      const value = unit ? perMonth(unit * quantity, interval, count) : perMonth(amount, sub.interval, sub.count);
      const at = num(obj(line.period, "an invoice line's period")?.start, "an invoice line's period") || num(invoice.created, "an invoice's date");
      if (!at) throw new UnreadInvoiceError("an invoice line with no time");
      out.set(id, [...(out.get(id) ?? []), { at, value }]);
    }
  }
  for (const entries of out.values()) entries.sort((a, b) => a.at - b.at);
  return out;
}

/** What one membership brought a month at a moment: nothing outside its paid time. */
function valueAt(sub: Sub, prices: Entry[] | undefined, at: number, now: number, currency: string): number {
  if (sub.currency !== currency || NEVER_PAID.has(sub.status)) return 0;
  if (at >= now) return PAYING.has(sub.status) ? perMonth(sub.amount, sub.interval, sub.count) : 0;
  if (sub.start > at || (sub.ended && sub.ended <= at) || (sub.trialEnd && at < sub.trialEnd)) return 0;
  if (!prices?.length) return perMonth(sub.amount, sub.interval, sub.count);
  let value = prices[0].value;
  for (const entry of prices) {
    if (entry.at > at) break;
    value = entry.value;
  }
  return value;
}

const monthStart = (seconds: number, back = 0) => {
  const d = new Date(seconds * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) / 1000;
};

/** The months, ARPU, ARR and net revenue retention. Pure. */
export function movementsFrom(subs: Sub[], prices: Map<string, Entry[]>, currency: string, now: number, months = 12): Movements {
  const byMember = new Map<string, Sub[]>();
  for (const sub of subs) {
    const who = sub.customer || sub.id;
    byMember.set(who, [...(byMember.get(who) ?? []), sub]);
  }
  const memberAt = (list: Sub[], at: number) => list.reduce((sum, sub) => sum + valueAt(sub, prices.get(sub.id), at, now, currency), 0);
  // When a member first paid anything: the start of their first paid time.
  const firstPaid = new Map<string, number>();
  for (const [who, list] of byMember) {
    let first = Infinity;
    for (const sub of list) {
      if (sub.currency !== currency || NEVER_PAID.has(sub.status)) continue;
      const from = Math.max(sub.start, sub.trialEnd || 0);
      if (sub.ended && sub.ended <= from) continue;
      first = Math.min(first, from);
    }
    firstPaid.set(who, first);
  }

  const out: Movement[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const from = monthStart(now, back);
    const to = back === 0 ? now : monthStart(now, back - 1);
    const row: Movement = { month: new Date(from * 1000).toISOString().slice(0, 7), start: 0, new: 0, expansion: 0, contraction: 0, canceled: 0, reactivated: 0, end: 0, members: 0 };
    for (const [who, list] of byMember) {
      const a = memberAt(list, from);
      const b = memberAt(list, to);
      row.start += a;
      row.end += b;
      if (b > 0) row.members += 1;
      if (a === 0 && b > 0) {
        if ((firstPaid.get(who) ?? Infinity) < from) row.reactivated += b;
        else row.new += b;
      } else if (a > 0 && b === 0) row.canceled += a;
      else if (b > a) row.expansion += b - a;
      else if (a > b) row.contraction += a - b;
    }
    out.push(row);
  }
  const rounded = out.map((r) => ({
    ...r,
    start: Math.round(r.start),
    new: Math.round(r.new),
    expansion: Math.round(r.expansion),
    contraction: Math.round(r.contraction),
    canceled: Math.round(r.canceled),
    reactivated: Math.round(r.reactivated),
    end: Math.round(r.end),
  }));
  // From the first month anything was paid, so a store that began in May does not open on seven empty months.
  const firstUsed = rounded.findIndex((r) => r.start || r.end || r.canceled);
  const shown = firstUsed < 0 ? [] : rounded.slice(firstUsed);

  const last = out[out.length - 1];
  const yearAgo = now - 365 * DAY;
  let then = 0;
  let still = 0;
  for (const list of byMember.values()) {
    const was = memberAt(list, yearAgo);
    if (was > 0) {
      then += was;
      still += memberAt(list, now);
    }
  }
  return {
    months: shown,
    arpu: last && last.members ? Math.round(last.end / last.members) : 0,
    arr: Math.round((last?.end ?? 0) * 12),
    nrr: then > 0 ? still / then : null,
  };
}
