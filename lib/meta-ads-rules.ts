/**
 * What a Meta ad account spent, made into the lines the numbers already
 * read (lib/ad-spend-rules.ts), so a channel's "Left", its call and the days
 * it took to pay back use what Meta charged rather than what was typed
 * (added 13 October 2026). Pure; read and kept by lib/meta-ads.ts.
 *
 * Meta's Insights answer one row per campaign, per day, per platform the ads
 * showed on. Each row becomes a line of one day:
 *
 *   - the channel is the platform as the numbers count it: Instagram is
 *     "instagram", Threads "threads", and Facebook, Messenger and the
 *     Audience Network "facebook";
 *   - the campaign is the campaign's name as a utm_campaign is counted
 *     (lib/source-rules.ts, cleanTag), so a link tagged
 *     utm_campaign={{campaign.name}} in Ads Manager lands on the same row;
 *   - the amount is in the ad account's currency, in its smallest unit, and
 *     is read only when that is the store's currency: no rate is guessed.
 */
import { createHash } from "node:crypto";
import { type AdSpend, readSpend } from "@/lib/ad-spend-rules";
import { cleanTag } from "@/lib/source-rules";
import { decimalsOf } from "@/lib/money";

/** How many days back each daily read asks for: Meta can still correct a day for a while after it. */
export const READ_DAYS = 30;
/** How long lines read from Meta are kept, like the days of visits. */
export const KEEP_DAYS = 400;
/** The most lines kept from Meta: 30 days by the day and a year by the week, for ten campaigns on two platforms, is under it. */
export const MAX_META_LINES = 2_000;

export type InsightRow = {
  campaign_id?: unknown;
  campaign_name?: unknown;
  spend?: unknown;
  date_start?: unknown;
  publisher_platform?: unknown;
};

/** The channel a Meta platform's visits are counted under. */
export function platformChannel(platform: unknown): string {
  const p = typeof platform === "string" ? platform.toLowerCase() : "";
  if (p === "instagram") return "instagram";
  if (p === "threads") return "threads";
  return "facebook";
}

/** Meta's amount ("12.34", in the account's currency) in that currency's smallest unit. */
export function minorUnits(spend: unknown, currency: string): number {
  const value = typeof spend === "string" || typeof spend === "number" ? Number(spend) : NaN;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 10 ** decimalsOf(currency));
}

const lineId = (day: string, channel: string, campaign: string) => `meta-${createHash("sha256").update(`${day}|${channel}|${campaign}`).digest("hex").slice(0, 12)}`;

/**
 * Meta's rows as one-day lines: added up by day, channel and campaign, rows
 * of nothing spent left out. `currency` is the account's.
 */
export function linesFrom(rows: InsightRow[], currency: string): AdSpend[] {
  const sums = new Map<string, { day: string; channel: string; campaign: string; cents: number }>();
  for (const row of rows) {
    const day = typeof row.date_start === "string" ? row.date_start : "";
    const cents = minorUnits(row.spend, currency);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !cents) continue;
    const channel = platformChannel(row.publisher_platform);
    const campaign = cleanTag(typeof row.campaign_name === "string" ? row.campaign_name : "");
    const id = lineId(day, channel, campaign);
    const sum = sums.get(id) ?? { day, channel, campaign, cents: 0 };
    sum.cents += cents;
    sums.set(id, sum);
  }
  const out: AdSpend[] = [];
  for (const [id, sum] of sums) {
    const read = readSpend({ channel: sum.channel, campaign: sum.campaign, cents: sum.cents, from: sum.day, to: sum.day }, Number.MAX_SAFE_INTEGER);
    if (read.ok) out.push({ id, ...read.spend, source: "meta" });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id));
}

/** The Monday of the week a day is in (UTC). */
function mondayOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  const back = (new Date(at).getUTCDay() + 6) % 7;
  return new Date(at - back * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The lines kept after a read of the days `from` to `to`: what was read
 * replaces every line of those days (Meta's figure for a day can change, and
 * a campaign it no longer reports had nothing spent), the days before stay,
 * and nothing older than KEEP_DAYS before `to` is kept. Days before `from`,
 * which Meta no longer changes, are kept a week to a line for each channel
 * and campaign, so a year of them stays small enough to send to the studio;
 * a window that starts mid-week is charged its days' share of that week.
 */
export function mergeLines(kept: AdSpend[], fresh: AdSpend[], from: string, to: string): AdSpend[] {
  const oldest = new Date(Date.parse(`${to}T00:00:00Z`) - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const before = kept.filter((line) => line.to < from && line.from >= oldest);
  const weeks = new Map<string, { from: string; to: string; channel: string; campaign: string; cents: number }>();
  for (const line of before) {
    const group = `${mondayOf(line.from)}|${line.channel}|${line.campaign}`;
    const week = weeks.get(group);
    if (!week) weeks.set(group, { from: line.from, to: line.to, channel: line.channel, campaign: line.campaign, cents: line.cents });
    else {
      week.cents += line.cents;
      if (line.from < week.from) week.from = line.from;
      if (line.to > week.to) week.to = line.to;
    }
  }
  const compact: AdSpend[] = [];
  for (const week of weeks.values()) {
    const read = readSpend(week, Number.MAX_SAFE_INTEGER);
    if (read.ok) compact.push({ id: lineId(`w${week.from}`, week.channel, week.campaign), ...read.spend, source: "meta" });
  }
  return [...compact, ...fresh].sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id)).slice(-MAX_META_LINES);
}

/**
 * Lines read back from where they are kept, whole or not at all (CX-123 rule 24; Codex Z on #2924): the kept text,
 * a JSON list whose every member is a line this code writes. Anything else, a single member in another shape
 * included, is null (unknown): never the other lines as if they were all of it. Redis's nil (nothing kept) is the
 * caller's to read as no lines.
 */
export function parseLines(raw: unknown): AdSpend[] | null {
  if (typeof raw !== "string" || !raw) return null;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const out: AdSpend[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const v = item as Record<string, unknown>;
    if (typeof v.id !== "string" || !/^meta-[0-9a-f]{12}$/.test(v.id)) return null;
    const read = readSpend({ channel: v.channel, campaign: v.campaign, cents: v.cents, from: v.from, to: v.to }, Number.MAX_SAFE_INTEGER);
    if (!read.ok) return null;
    out.push({ id: v.id, ...read.spend, source: "meta" });
  }
  return out.slice(-MAX_META_LINES);
}

/** The first and last day of a read made at `now`: the last READ_DAYS days, today included (UTC). */
export function readWindow(now: number): { from: string; to: string } {
  return {
    from: new Date(now - (READ_DAYS - 1) * 86_400_000).toISOString().slice(0, 10),
    to: new Date(now).toISOString().slice(0, 10),
  };
}
