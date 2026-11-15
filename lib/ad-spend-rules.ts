/**
 * What the creator spent on ads, set against what each channel brought
 * (added 11 October 2026). Pure, so the studio's panel, the server and the
 * tests read it the same way; kept by lib/ad-spend.ts.
 *
 * Revenue alone says where money came from; it does not say where money was
 * made. A channel that brought $900 on $1,200 of ads lost $300, and only the
 * creator knows the $1,200. So they type it in — the channel, a post or
 * campaign if they like, the amount, and the days it ran — and each channel's
 * row gains what was spent, what is left, and how much came back for each
 * dollar. Typed, not read from the ad networks: nothing to connect, nothing
 * of the creator's handed to anybody, and it works for a sponsor paid by
 * transfer as well as for Meta.
 *
 * An amount that ran over several days is spread evenly over them, and a
 * window is charged the part of it that fell inside. Amounts are in the
 * store's currency, in its smallest unit, like every other figure there.
 */

export type AdSpend = {
  id: string;
  /** The channel, as the numbers count it: "instagram", "tiktok", a utm_source. */
  channel: string;
  /** A post or campaign, as its utm_campaign; empty for the whole channel. */
  campaign: string;
  cents: number;
  /** First and last day it ran, inclusive (UTC). */
  from: string;
  to: string;
  /** Where it came from when it was not typed: "meta", read from the creator's ad account (lib/meta-ads.ts). */
  source?: "meta";
};

/**
 * Which part of a store's ad spend could not be read just now: Meta's lines ("meta", the typed lines are known),
 * the typed lines ("typed", nothing is known), or none (null). While any part is unread, every figure that uses ad
 * spend is left out, never shown with one part as all of it or with nothing as $0 (Claude 5 on #2924).
 */
export type SpendUnread = "meta" | "typed" | null;

/** What the studio's numbers say where the figures that use ad spend are left out because a part is unread. */
export const SPEND_FIGURES_UNREAD = "Ad spend could not be read in full just now, so the results after ads are not shown. Reload to try again.";

export const MAX_SPEND_ENTRIES = 300;
/** A million in the store's currency, which no single line a creator types should be over. */
export const MAX_SPEND_CENTS = 100_000_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A channel or campaign as the numbers count it: lower case, letters, digits, dots, dashes, underscores. */
export function spendTag(raw: unknown, max = 30): string {
  return typeof raw === "string" ? raw.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, max) : "";
}

function dayValue(raw: string): number | null {
  if (!DAY.test(raw)) return null;
  const at = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === raw ? at : null;
}

/** Days from `from` to `to`, both counted. */
export function daysBetween(from: string, to: string): number {
  const a = dayValue(from);
  const b = dayValue(to);
  return a === null || b === null || b < a ? 0 : Math.round((b - a) / DAY_MS) + 1;
}

/**
 * An entry as typed, made whole, or the reason it cannot be one. The days
 * must be real, in order, no more than 400 apart and not in the future, the
 * amount a positive whole number of cents, and the channel a word.
 */
export function readSpend(input: { channel: unknown; campaign?: unknown; cents: unknown; from: unknown; to: unknown }, now = Date.now()):
  | { ok: true; spend: Omit<AdSpend, "id"> }
  | { ok: false; reason: "channel" | "amount" | "days" } {
  const channel = spendTag(input.channel);
  if (!channel || channel === "direct") return { ok: false, reason: "channel" };
  const cents = Number(input.cents);
  if (!Number.isInteger(cents) || cents <= 0 || cents > MAX_SPEND_CENTS) return { ok: false, reason: "amount" };
  const from = typeof input.from === "string" ? input.from : "";
  const to = typeof input.to === "string" ? input.to : "";
  const span = daysBetween(from, to);
  const last = dayValue(to);
  if (!span || span > 400 || last === null || last > now + DAY_MS) return { ok: false, reason: "days" };
  return { ok: true, spend: { channel, campaign: spendTag(input.campaign, 40), cents, from, to } };
}

/** The part of an entry that fell between two days, both counted: spread evenly over the days it ran. */
export function spendWithin(entry: Pick<AdSpend, "cents" | "from" | "to">, from: string, to: string): number {
  const span = daysBetween(entry.from, entry.to);
  if (!span) return 0;
  const start = entry.from > from ? entry.from : from;
  const end = entry.to < to ? entry.to : to;
  const inside = daysBetween(start, end);
  if (!inside) return 0;
  // Allocate by differences of rounded cumulative amounts. Every split of a
  // recorded interval then conserves its smallest currency units exactly.
  const before = daysBetween(entry.from, start) - 1;
  return Math.round(entry.cents * (before + inside) / span) - Math.round(entry.cents * before / span);
}

/** What was spent on each channel, and on each campaign, between two days. */
export function spendBy(entries: AdSpend[], from: string, to: string): { channels: Map<string, number>; campaigns: Map<string, number>; total: number } {
  const channels = new Map<string, number>();
  const campaigns = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    const cents = spendWithin(entry, from, to);
    if (!cents) continue;
    total += cents;
    channels.set(entry.channel, (channels.get(entry.channel) ?? 0) + cents);
    if (entry.campaign) campaigns.set(entry.campaign, (campaigns.get(entry.campaign) ?? 0) + cents);
  }
  return { channels, campaigns, total };
}

/**
 * Spend more, keep, or cut, for one channel's ads (added 11 October 2026).
 * Wicked Reports sells this call as "Scale, Chill or Kill"; here it is two
 * lines over the figures the row already shows: a channel whose sales came to
 * at least SCALE_AT times what its ads cost is worth more money, one whose
 * sales did not cover its ads is losing it, and the rest hold their own. Said
 * only once at least VERDICT_MIN_CENTS was spent, because $3 of ads proves
 * nothing either way. Before Stripe's fee and the creator's own costs, which
 * only they know, and the panel says so.
 */
export const SCALE_AT = 2;
export const VERDICT_MIN_CENTS = 1000;
export type Verdict = "scale" | "keep" | "cut";
export const VERDICT_NAMES: Record<Verdict, string> = { scale: "Spend more", keep: "Keep", cut: "Cut" };

export function verdictFor(cents: number, cost: number): Verdict | null {
  if (!Number.isFinite(cost) || cost < VERDICT_MIN_CENTS) return null;
  const back = cents / cost;
  return back >= SCALE_AT ? "scale" : back >= 1 ? "keep" : "cut";
}

/** The day after `day`, as YYYY-MM-DD. */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * When one channel's ads paid for themselves (added 11 October 2026), as
 * Ripples reads payback: from the first day money was spent on it inside the
 * days shown, the channel's money — first sales and the renewals of the
 * memberships it sold, day by day (lib/stats.ts, channelDays) — added up until
 * it reaches everything spent on it in those days. `days` is how many days
 * that took, counting the first; null while it has not happened, with `back`
 * saying how much has come back so far. Null altogether below
 * VERDICT_MIN_CENTS of spend.
 */
export function paybackOf(
  entries: AdSpend[],
  channel: string,
  money: Record<string, number> | undefined,
  from: string,
  to: string,
): { spent: number; back: number; days: number | null } | null {
  const mine = entries.filter((entry) => entry.channel === channel && spendWithin(entry, from, to) > 0);
  const spent = mine.reduce((sum, entry) => sum + spendWithin(entry, from, to), 0);
  if (spent < VERDICT_MIN_CENTS) return null;
  const first = mine.reduce((day, entry) => (entry.from < day ? entry.from : day), to);
  const start = first > from ? first : from;
  let back = 0;
  let count = 0;
  for (let day = start; day <= to && count < 401; day = nextDay(day)) {
    count += 1;
    back += money?.[day] ?? 0;
    if (back >= spent) return { spent, back, days: count };
  }
  return { spent, back, days: null };
}

/**
 * Typed lines that may repeat what Meta reads: on a channel Meta's lines
 * are on, over a day Meta read. Shown to the creator, never removed for
 * them: a sponsored post paid to someone on Instagram is not a Meta ad.
 */
export function typedOverlap(typed: AdSpend[], meta: AdSpend[]): AdSpend[] {
  if (!meta.length) return [];
  const days = new Map<string, { first: string; last: string }>();
  for (const line of meta) {
    const span = days.get(line.channel) ?? { first: line.from, last: line.to };
    if (line.from < span.first) span.first = line.from;
    if (line.to > span.last) span.last = line.to;
    days.set(line.channel, span);
  }
  return typed.filter((line) => {
    const span = days.get(line.channel);
    return Boolean(span && line.from <= span.last && line.to >= span.first);
  });
}
