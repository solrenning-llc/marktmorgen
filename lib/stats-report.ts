/**
 * A store's numbers as data, for the two places they leave the studio
 * (added 11 October 2026): the API (/api/v1/stats), for a creator's own tools
 * and assistants, and the weekly email, which brings the week to the creator
 * instead of waiting for them to open the studio.
 *
 * Both are read from exactly what the studio reads (lib/stats.ts): visits
 * from our counts, money from the creator's own Stripe account. Nothing new
 * is recorded for either.
 */
import { paidFiguresComplete } from "@/lib/paid-coverage";
import { ledgerPaymentsComplete } from "@/lib/payment-ledger-coverage";
import { paymentMixFrom } from "@/lib/payment-mix";
import { paymentComparisonFrom } from "@/lib/payment-comparison";
import { refundActivityFrom } from "@/lib/refund-activity";
import { COHORT_AGES } from "@/lib/buyer-channel-rules";
import { dailyCashflowRows } from "@/lib/daily-cashflow";
import { campaignResultsFrom } from "@/lib/campaign-results";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Store } from "@/lib/store";
import { type Ranked, type StatsData, readSales, readsSales, readStats, sourcesToday, studioStats, viewsBefore } from "@/lib/stats";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { standingOf } from "@/lib/plan-standing";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type Claimed, claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { deriveKey } from "@/lib/secret-box";
import { formatMoney } from "@/lib/money";
import { insightsFrom } from "@/lib/insights";
import type { AdSpend } from "@/lib/ad-spend-rules";
import { SITE_URL } from "@/lib/site-url";
import { goalProgress, moneyByDay, monthTitle } from "@/lib/sales-goal-rules";

type Window = "d7" | "d30" | "d90";
const WINDOWS: Window[] = ["d7", "d30", "d90"];

export type SummaryWindow = {
  period: { from: string | null; to: string | null; requested_days: number; days_returned: number; calendar_complete: boolean; timezone: "UTC" };
  attribution: {
    complete: boolean;
    first_visit_complete: boolean;
    window_days: number | null;
    total: { sales: number; revenue: number } | null;
    unknown_last: { sales: number; revenue: number } | null;
    unknown_first: { sales: number; revenue: number } | null;
    rows: { key: string; name: string; last: { sales: number; revenue: number }; first: { sales: number; revenue: number } | null; said: { buyers: number; revenue: number } }[];
    unknown_said: { answer: string; name: string; buyers: number; revenue: number }[];
  };
  visitors: number;
  page_views: number;
  checkouts: number;
  sales: number | null;
  revenue: number | null;
  channels: { channel: string; visits: number; checkouts: number; signups: number; sales: number | null; revenue: number | null }[];
  countries: { country: string; views: number }[];
  devices: { device: string; views: number }[];
  /** The same number of days just before, to compare with; sales and revenue null where they were not read in full. */
  previous: { available: boolean; visitors: number | null; page_views: number | null; checkouts: number | null; sales: number | null; revenue: number | null };
  /** Refunds given in the window; null when they were not read. */
  refunded: number | null;
  refunds_complete: boolean;
  refund_activity: { complete: boolean; from: string | null; to: string | null; records: number | null; share: number | null; rows: { channel: string; gross_receipts: number; refunded: number; records: number; share: number | null }[] };
  /** Gross receipts include renewals; after_refunds excludes fees and ad spend. Smallest currency unit. */
  payments: { complete: boolean; gross_receipts: number | null; after_refunds: number | null };
  daily_payments: {
    payments_complete: boolean;
    refunds_complete: boolean;
    rows: { date: string; gross_receipts: number; refunded: number | null; after_refunds: number | null }[];
  };
  renewals: { complete: boolean; count: number | null; revenue: number | null };
  campaign_results: {
    available: boolean;
    paid_figures_complete: boolean;
    from: string | null;
    to: string | null;
    rows: { campaign: string; visits: number; paid_records: number | null; revenue: number | null; payment_channels: string[] | null }[];
  };
  buyer_channels: {
    complete: boolean;
    unidentified_orders: number | null;
    rows: { channel: string; buyers: number; repeat_buyers: number; orders: number; revenue: number; eligible_30_days: number; repeated_30_days: number; repeat_rate_30_days: number | null }[];
  };
  /** All gross receipt channels, including unidentified origins. Shares are fractions of all receipts. */
  payment_channels: { complete: boolean; from: string | null; to: string | null; rows: { channel: string; gross_receipts: number; share: number; identified: boolean }[] };
  payment_comparison: {
    complete: boolean;
    previous: { from: string; to: string; gross_receipts: number } | null;
    delta: number | null;
    change: number | null;
    rows: { channel: string; current: number; previous: number; delta: number; change: number | null; current_share: number | null; previous_share: number | null; share_change: number | null }[];
  };
  /** Reading coverage; detail lists contain at most 20 entries. */
  sales_by_country_complete: boolean;
  ad_records_complete: boolean;
  sales_by_country_total: number | null;
  sales_by_country_truncated: boolean | null;
  ad_records_total: number | null;
  ad_records_truncated: boolean | null;
  /** Money by the buyer's country, and by the ad it came from (utm_content), the biggest first. */
  sales_by_country: { country: string; sales: number; revenue: number }[];
  ads: { ad: string; channel: string; campaign: string; sales: number; revenue: number }[];
};

export type Summary = {
  currency: string;
  /** "ok" when sales were read from Stripe, "none" with no Stripe account, "error" when Stripe did not answer. */
  sales: StatsData["sales"];
  partial: boolean;
  paid_figures_complete: boolean;
  payments_complete: boolean;
  weekly_buyer_cohorts: {
    complete: boolean;
    as_of: string | null;
    unidentified_orders: number | null;
    rows: { week: string; buyers: number; observations: { days: number; eligible: number; repeated: number; rate: number | null }[] }[];
  };
  days: Record<"last_7_days" | "last_30_days" | "last_90_days", SummaryWindow>;
};

const NAMES: Record<Window, keyof Summary["days"]> = { d7: "last_7_days", d30: "last_30_days", d90: "last_90_days" };

/** The studio's numbers for a store, or null when its counts cannot be read. */
export async function readNumbers(store: Store, now = Date.now()): Promise<StatsData | null> {
  const stats = await readStats(store, now);
  if (!stats) return null;
  let state: StatsData["sales"] = readsSales(store) ? "ok" : "none";
  const sales = readsSales(store)
    ? await readSales(store, now).catch((error) => {
        console.error("reading sales for a summary failed", error);
        state = "error";
        return null;
      })
    : null;
  // No products listed: neither reader shows them, and reading them costs.
  return studioStats(store, stats, sales, state, []);
}

/** What /api/v1/stats answers: the last 7, 30 and 90 days, money in the smallest unit of the store's currency. */
export function summaryOf(data: StatsData, options: { fullDetails?: boolean } = {}): Summary {
  const known = paidFiguresComplete(data);
  const money = (value: { sales: number; cents: number }) => ({ sales: value.sales, revenue: value.cents });
  const detailLimit = options.fullDetails ? undefined : 20;
  const ranked = <K extends string>(rows: Ranked, key: K) => rows.map((r) => ({ [key]: r.name, views: r.visits })) as ({ [P in K]: string } & { views: number })[];
  const days = {} as Summary["days"];
  for (const w of WINDOWS) {
    const t = data.totals[w];
    const requestedDays = w === "d7" ? 7 : w === "d30" ? 30 : 90;
    const selectedDays = data.days.slice(-requestedDays);
    const times = selectedDays.map(day => Date.parse(day.date + "T00:00:00Z"));
    const validDates = times.every((at, i) => Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === selectedDays[i].date);
    const calendarComplete = selectedDays.length === requestedDays && validDates && times.every((at, i) => i === 0 || at - times[i - 1] === 86400000);
    const attribution = known ? data.attribution?.[w] : null;
    const firstKnown = attribution?.unknownFirst != null;
    const refundsKnown = ledgerPaymentsComplete(data) && data.cashflowComplete === true && data.refunds?.[w] != null;
    const payments = paymentMixFrom(data, w);
    const campaigns = data.posts?.[w] != null ? campaignResultsFrom(data, w) : null;
    const daily = payments ? dailyCashflowRows(data, w) : [];
    const refundActivity = payments ? refundActivityFrom(data, w, payments.from, payments.to) : null;
    const comparison = paymentComparisonFrom(data, w);
    const refunded = refundsKnown ? data.refunds![w].reduce((n, r) => n + r.cents, 0) : null;
    const renewalsKnown = known && data.renewals != null && !data.renewals.partial;
    const buyers = known && data.buyerChannels?.historyPartial === false ? data.buyerChannels[w] : null;
    const countriesKnown = known && data.salesCountries?.[w] != null;
    const adsKnown = known && data.ads?.[w] != null;
    days[NAMES[w]] = {
      period: { from: validDates ? selectedDays[0]?.date ?? null : null, to: validDates ? selectedDays[selectedDays.length - 1]?.date ?? null : null, requested_days: requestedDays, days_returned: selectedDays.length, calendar_complete: calendarComplete, timezone: "UTC" },
      attribution: {
        complete: attribution != null,
        first_visit_complete: firstKnown,
        window_days: attribution ? data.attributionDays ?? null : null,
        total: attribution ? money(attribution.total) : null,
        unknown_last: attribution ? money(attribution.unknown) : null,
        unknown_first: attribution?.unknownFirst ? money(attribution.unknownFirst) : null,
        rows: attribution?.rows.map(row => ({ key: row.key, name: row.name, last: money(row.last), first: firstKnown ? money(row.first) : null, said: { buyers: row.said.buyers, revenue: row.said.cents } })) ?? [],
        unknown_said: attribution?.unknownSaid.map(row => ({ answer: row.answer, name: row.name, buyers: row.buyers, revenue: row.cents })) ?? [],
      },
      visitors: t.visitors,
      page_views: t.views,
      checkouts: t.checkouts,
      sales: known ? t.sales : null,
      revenue: known ? t.cents : null,
      channels: (data.channels?.[w] ?? []).map((c) => ({
        channel: c.source,
        visits: c.visits,
        checkouts: c.checkouts,
        signups: c.free,
        sales: known ? c.sales : null,
        revenue: known ? c.cents : null,
      })),
      countries: ranked(data.countries?.[w] ?? [], "country"),
      devices: ranked(data.devices?.[w] ?? [], "device"),
      previous: (() => {
        const p = data.previousTrafficAvailable?.[w] === false ? null : data.previous?.[w];
        return {
          available: p != null,
          visitors: p?.visitors ?? null,
          page_views: p?.views ?? null,
          checkouts: p?.checkouts ?? null,
          sales: known && p ? p.sales : null,
          revenue: known && p ? p.cents : null,
        };
      })(),
      refunded,
      refunds_complete: refundsKnown,
      refund_activity: {
        complete: refundActivity !== null,
        from: refundActivity ? payments!.from : null,
        to: refundActivity ? payments!.to : null,
        records: refundActivity?.records ?? null,
        share: refundActivity?.share ?? null,
        rows: refundActivity?.rows.map(row => ({ channel: row.source, gross_receipts: row.payments, refunded: row.refunds, records: row.records, share: row.share })) ?? [],
      },
      payments: { complete: payments !== null, gross_receipts: payments?.total ?? null, after_refunds: payments !== null && refunded !== null ? payments.total - refunded : null },
      daily_payments: {
        payments_complete: payments !== null,
        refunds_complete: daily.length > 0 && daily.every(row => row.refunds !== null),
        rows: daily.map(row => ({ date: row.date, gross_receipts: row.payments!, refunded: row.refunds, after_refunds: row.afterRefunds })),
      },
      renewals: { complete: renewalsKnown, count: renewalsKnown ? data.renewals![w].payments : null, revenue: renewalsKnown ? data.renewals![w].cents : null },
      campaign_results: {
        available: campaigns !== null,
        paid_figures_complete: campaigns !== null && campaigns.salesKnown,
        from: campaigns?.from ?? null,
        to: campaigns?.to ?? null,
        rows: campaigns?.rows.map(row => ({ campaign: row.campaign, visits: row.visits, paid_records: row.paidRecords, revenue: row.gross, payment_channels: row.paymentChannels })) ?? [],
      },
      buyer_channels: {
        complete: buyers != null,
        unidentified_orders: buyers?.unidentifiedOrders ?? null,
        rows: buyers?.rows.map(row => ({ channel: row.source, buyers: row.buyers, repeat_buyers: row.repeatBuyers, orders: row.orders, revenue: row.cents, eligible_30_days: row.eligible30, repeated_30_days: row.repeated30, repeat_rate_30_days: row.eligible30 > 0 ? row.repeated30 / row.eligible30 : null })) ?? [],
      },
      payment_channels: {
        complete: payments !== null,
        from: payments?.from ?? null,
        to: payments?.to ?? null,
        rows: payments?.rows.map(row => ({ channel: row.source, gross_receipts: row.cents, share: row.share, identified: row.identified })) ?? [],
      },
      payment_comparison: {
        complete: comparison?.previous != null,
        previous: comparison?.previous ? { from: comparison.previous.from, to: comparison.previous.to, gross_receipts: comparison.previous.total } : null,
        delta: comparison?.delta ?? null,
        change: comparison?.change ?? null,
        rows: comparison?.rows.map(row => ({ channel: row.source, current: row.current, previous: row.previous, delta: row.current - row.previous, change: row.change, current_share: row.currentShare, previous_share: row.previousShare, share_change: row.shareChange })) ?? [],
      },
      sales_by_country_complete: countriesKnown,
      ad_records_complete: adsKnown,
      sales_by_country_total: countriesKnown ? data.salesCountries![w].length : null,
      sales_by_country_truncated: countriesKnown ? data.salesCountries![w].length > (detailLimit ?? Infinity) : null,
      ad_records_total: adsKnown ? data.ads![w].length : null,
      ad_records_truncated: adsKnown ? data.ads![w].length > (detailLimit ?? Infinity) : null,
      sales_by_country: countriesKnown ? (data.salesCountries?.[w] ?? []).slice(0, detailLimit).map((r) => ({ country: r.country, sales: r.sales, revenue: r.cents })) : [],
      ads: adsKnown ? (data.ads?.[w] ?? []).slice(0, detailLimit).map((r) => ({ ad: r.content, channel: r.source, campaign: r.campaign, sales: r.sales, revenue: r.cents })) : [],
    };
  }
  const weekly = known && data.buyerChannels?.historyPartial === false ? data.buyerChannels.weekly : null;
  return {
    currency: data.currency, sales: data.sales, partial: data.partial === true,
    paid_figures_complete: known, payments_complete: ledgerPaymentsComplete(data), days,
    weekly_buyer_cohorts: {
      complete: weekly != null,
      as_of: weekly?.asOf ?? null,
      unidentified_orders: weekly?.unidentifiedOrders ?? null,
      rows: weekly?.rows.map(row => ({ week: row.week, buyers: row.buyers, observations: COHORT_AGES.map(age => ({ days: age, eligible: row.observations[age].eligible, repeated: row.observations[age].repeated, rate: row.observations[age].eligible > 0 ? row.observations[age].repeated / row.observations[age].eligible : null })) })) ?? [],
    },
  };
}

// ---- The weekly email ------------------------------------------------------------

const OFF = "nl:weekly:off";
const sentKey = (week: string, handle: string) => `nl:weekly:sent:${week}:${handle}`;

/** The week an email belongs to, as the Monday it starts on (UTC). */
export function weekOf(now = Date.now()): string {
  const d = new Date(now);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}

/** The token in a weekly email's stop link: the store's handle, signed with a key only this deployment has. */
export function weeklyToken(handle: string): string {
  const key = deriveKey("weekly-report");
  if (!key) return "";
  return createHmac("sha256", key).update(`weekly|${handle}`).digest("base64url").slice(0, 32);
}

export function weeklyTokenOk(handle: string, token: string): boolean {
  const want = weeklyToken(handle);
  if (!want || token.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(token));
}

/**
 * Whether the numbers emails are stopped for a store: true when its creator
 * pressed "Stop", and also when the answer is in any other shape than 0 or 1
 * (CX-123 rule 24): an unknown answer is never "not stopped", so no numbers
 * email goes on it this time, and it is said in the log. Sweep A6 (Claude 5).
 */
export async function weeklyOff(handle: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const replies = repliesFor(await redisPipeline([["SISMEMBER", OFF, handle]]), 1);
  const member = replies ? countOf(replies[0]) : null;
  if (member === 0) return false;
  if (member === 1) return true;
  console.error("weekly-off: whether the numbers emails are stopped is unknown; no numbers email this time");
  return true;
}

export async function setWeeklyOff(handle: string, off: boolean): Promise<void> {
  if (!isRedisConfigured()) return;
  await redisPipeline([[off ? "SADD" : "SREM", OFF, handle]]);
}

// ---- The weekly email to the team (added 11 October 2026) ---------------------

/**
 * Team members the owner chose to send the weekly email to as well
 * (Fathom and Umami send their reports to a team the same way). Each is
 * checked against the team when the email goes, so somebody removed from the
 * team, or whose role no longer sees the numbers, gets nothing; and each has
 * their own stop link, which stops only their copy.
 */
const teamKey = (handle: string) => `nl:weekly:to:${handle}`;
export const MAX_WEEKLY_TEAM = 5;

/** Read exactly (CX-123 rule 24): an empty set is nobody; any other shape throws, never "nobody". */
export async function weeklyTeam(handle: string): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["SMEMBERS", teamKey(handle)]]), 1);
  const members = replies ? stringList(replies[0]) : null;
  if (!members) throw new UnknownReplyError("who gets the weekly email");
  return members.sort();
}

export async function setWeeklyTeam(handle: string, emails: string[]): Promise<void> {
  if (!isRedisConfigured()) return;
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_WEEKLY_TEAM);
  await redisPipeline([["DEL", teamKey(handle)], ...(clean.length ? [["SADD", teamKey(handle), ...clean]] : [])]);
}

export async function leaveWeeklyTeam(handle: string, email: string): Promise<void> {
  if (!isRedisConfigured()) return;
  await redisPipeline([["SREM", teamKey(handle), email.trim().toLowerCase()]]);
}

/** A team member's own stop link token: the store and their address, signed. */
export function weeklyMemberToken(handle: string, email: string): string {
  const key = deriveKey("weekly-report");
  if (!key) return "";
  return createHmac("sha256", key).update(`weekly|${handle}|${email.trim().toLowerCase()}`).digest("base64url").slice(0, 32);
}

export function weeklyMemberTokenOk(handle: string, email: string, token: string): boolean {
  const want = weeklyMemberToken(handle, email);
  if (!want || token.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(token));
}

/**
 * Claims this week's email for a store; false when it was already claimed, so nobody gets two. Read exactly
 * (lib/claim-mark.ts, CX-123 rule 24): an answer not known to be this run's is never a claim, and nothing is sent on it.
 */
export async function claimWeek(handle: string, now = Date.now()): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const period = weekPeriod(handle, now);
  return ownClaim(period.key, period.seconds);
}

// ---- A period's summary that did not go (8 November 2026) -------------------------

/**
 * One store's week or month of the numbers summary: the claim's key, and how long it and its marks are kept.
 * The marks sit under the claim's own key (`<claim>:emailed`, `<claim>:posted`, `<claim>:tries`), so they are
 * the same family, kept as long, and gone with it.
 */
export type SummaryPeriod = { key: string; seconds: number };
export const weekPeriod = (handle: string, now = Date.now()): SummaryPeriod => ({ key: sentKey(weekOf(now), handle), seconds: 9 * 86400 });
export const monthPeriod = (handle: string, month: string): SummaryPeriod => ({ key: monthSentKey(month, handle), seconds: 40 * 86400 });

/**
 * The runs that may try one period's summary for a store, at most: the first and two more. The crons run every
 * hour over two days, so a refusal that passes is tried again within the hour; one that does not (an address
 * the provider keeps refusing) stops after three tries, so the cost of trying is bounded.
 */
export const SUMMARY_TRIES = 3;

/** A part of the summary (the owner's email, the channel's post), marked once for the period before it goes. */
export type SummaryPart = "emailed" | "posted";

/**
 * What a part's send came to: true or "sent" went; "refused" surely did not; "unknown" may have gone (a chat post
 * the chat did not confirm: lib/chat-summary.ts, ChatPost). False is lib/email.ts's sendEmail answer, which is
 * "refused" or "unknown" and cannot say which (an SES timeout or 5xx after acceptance, a once-key already held,
 * Resend's unknown or idempotency conflict all answer false).
 */
export type PartSend = boolean | "sent" | "refused" | "unknown";

/**
 * How long a try of the owner's email stays covered by its idempotency key, with an hour to spare: SES's once-key
 * (lib/email.ts) and Resend's idempotency each hold the key 24 hours. Inside it, another try under the same key does
 * not deliver an email whose answer was lost; past it, nothing would stop it, so an email whose first try is older
 * is not tried again (rule 24: a false may be an unknown, and an unknown is never sent blind).
 */
export const EMAIL_KEY_HOLDS_MS = 23 * 3_600_000;

/**
 * When a part was first tried this period, in ms, read exactly (rule 24): set now when it was never tried, else the
 * earlier time; null when the answer has another shape. Kept as long as the part's mark.
 */
async function firstTried(period: SummaryPeriod, part: SummaryPart, now: number): Promise<number | null> {
  const key = `${period.key}:${part}:first`;
  try {
    const replies = repliesFor(await redisPipeline([["SET", key, String(now), "NX", "EX", period.seconds], ["GET", key]]), 2);
    if (!replies || (replies[0] !== "OK" && replies[0] !== null) || typeof replies[1] !== "string" || !/^\d{1,16}$/.test(replies[1])) return null;
    const at = Number(replies[1]);
    return Number.isSafeInteger(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * Sends a part of the period's summary at most once (lib/claim-mark.ts). "sent" now; "earlier" when a previous run
 * of the same period sent it, so a run that tries the period again never sends it twice; "missed" when it surely
 * did not go, or when its mark or its first try's time answered in an unknown shape (rule 24: never sent on it),
 * and then the mark is let go, while it still holds this run's value, so a later run sends it; "unconfirmed" when
 * it may have gone (an unknown answer, a throw), and then the mark is kept, so no later try sends it blind.
 *
 * With `keyHoldsMs` (the owner's email, EMAIL_KEY_HOLDS_MS), a false is let go only while the first try is that
 * recent, since a try under the same key cannot deliver it twice; once the first try is older, the part is not
 * tried again and is "unconfirmed". Without it, a false is "unconfirmed". Never throws.
 */
export async function sendPart(
  period: SummaryPeriod,
  part: SummaryPart,
  send: () => Promise<PartSend>,
  options: { keyHoldsMs?: number } = {},
): Promise<"sent" | "earlier" | "missed" | "unconfirmed"> {
  const key = `${period.key}:${part}`;
  const value = claimValue();
  const got: Claimed = await claimMark(key, period.seconds, value);
  if (got === "taken") return "earlier";
  if (got === "ours") {
    const window = options.keyHoldsMs;
    const now = Date.now();
    const first = window === undefined ? now : await firstTried(period, part, now);
    if (first === null) {
      console.error(`stats-report: when a ${part} part was first tried could not be read; that part is not sent this run`);
    } else if (now - first >= (window ?? Infinity)) {
      console.error(`stats-report: a ${part} part was first tried more than its key holds and never confirmed; its mark is kept, so it is not sent again this period`);
      return "unconfirmed";
    } else {
      const answer: PartSend = await send().catch(() => "unknown" as const);
      if (answer === true || answer === "sent") return "sent";
      if (answer !== "refused" && !(answer === false && window !== undefined)) {
        console.error(`stats-report: a ${part} part's outcome is unknown; its mark is kept, so it is not sent again this period`);
        return "unconfirmed";
      }
    }
  }
  if (got === "unknown") console.error(`stats-report: a ${part} mark answered in an unknown shape; that part is not sent this run`);
  await releaseMark(key, value);
  return "missed";
}

/**
 * A summary that did not go in full: counts the try and lets the period's claim go, so a later run sends what is
 * missing, until SUMMARY_TRIES runs have tried. True when it was let go. A count not read exactly (rule 24) is
 * not a try below the ceiling: the claim is kept and that is said, so an unread count never retries forever.
 * Never throws.
 */
export async function tryPeriodAgain(period: SummaryPeriod): Promise<boolean> {
  const tries = `${period.key}:tries`;
  let count: number | null = null;
  try {
    const replies = repliesFor(await redisPipeline([["INCR", tries], ["EXPIRE", tries, period.seconds]]), 2);
    count = replies && countOf(replies[1]) === 1 ? countOf(replies[0]) : null;
  } catch {
    count = null;
  }
  const family = period.key.split(":").slice(0, 2).join(":");
  if (count === null || count < 1) {
    console.error(`stats-report: the tries of a ${family} summary could not be read; it is not tried again this period`);
    return false;
  }
  if (count >= SUMMARY_TRIES) {
    console.error(`stats-report: a ${family} summary did not go in ${count} tries; it is not tried again this period`);
    return false;
  }
  try {
    const replies = repliesFor(await redisPipeline([["DEL", period.key]]), 1);
    if (replies && countOf(replies[0]) !== null) return true;
  } catch {
    // Said below.
  }
  console.error(`stats-report: a ${family} summary's claim could not be let go; it is not tried again this period`);
  return false;
}

/** A once-only claim (SET NX): true only when it is this run's; taken or unknown is false, and unknown is said. */
async function ownClaim(key: string, seconds: number): Promise<boolean> {
  const got = await claimMark(key, seconds);
  if (got === "unknown") console.error(`stats-report: the claim ${key.split(":").slice(0, 2).join(":")} answered in an unknown shape; nothing is sent on it this time`);
  return got === "ours";
}

const CHANNEL_WORDS: Record<string, string> = {
  direct: "direct or unknown",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
  x: "X",
  google: "Google",
  email: "email",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  threads: "Threads",
  reddit: "Reddit",
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  claude: "Claude",
  gemini: "Gemini",
  copilot: "Copilot",
  deepseek: "DeepSeek",
  grok: "Grok",
};
/** Only the map's own words: a channel is a visitor's utm_source, so "__proto__" or "constructor" stays its own text (tests/proto-keys.test.ts). */
const channelWord = (source: string) => (Object.hasOwn(CHANNEL_WORDS, source) ? CHANNEL_WORDS[source] : source);

/** The week's email, in words. Null when the store had no visitors in the week: nothing to say. */
export function weeklyMessage(store: Store, data: StatsData, stopUrl: string, spends: AdSpend[] = [], goal = 0): { subject: string; text: string } | null {
  const week = data.totals.d7;
  if (week.visitors === 0) return null;
  const known = paidFiguresComplete(data);
  const money = (cents: number) => formatMoney(cents, data.currency ?? "usd");
  const people = `${week.visitors.toLocaleString("en-US")} ${week.visitors === 1 ? "visitor" : "visitors"}`;
  const subject = known
    ? `${store.name}: ${people} and ${money(week.cents)} in sales this week`
    : `${store.name}: ${people} this week`;

  const before = data.previous?.d7;
  const beforeTraffic = data.previousTrafficAvailable?.d7 === false ? null : before;
  // "(up 23% on the week before)", or nothing when there is nothing honest to say.
  const against = (now: number, then: number | null | undefined) => {
    if (then === null || then === undefined || then === 0) return "";
    const value = ((now - then) / then) * 100;
    if (Math.abs(value) < 0.5) return " (the same as the week before)";
    const shown = Math.abs(value) < 10 ? Math.abs(value).toFixed(1) : String(Math.round(Math.abs(value)));
    return ` (${value > 0 ? "up" : "down"} ${shown}% on the week before)`;
  };
  const lines: string[] = [];
  lines.push(`Here is ${store.name} over the last 7 days.`, "");
  lines.push(`Visitors: ${week.visitors.toLocaleString("en-US")}${against(week.visitors, beforeTraffic?.visitors)}`);
  lines.push(`Checkouts started: ${week.checkouts.toLocaleString("en-US")}${against(week.checkouts, beforeTraffic?.checkouts)}`);
  if (known) {
    lines.push(`Sales: ${week.sales.toLocaleString("en-US")}, ${money(week.cents)} before Stripe's fee${against(week.cents, before?.cents)}`);
    const renewals = data.renewals?.d7;
    if (data.renewals?.partial) lines.push("Renewals: incomplete invoice reading; totals are unavailable.");
    else if (renewals && renewals.payments > 0) lines.push(`Renewals: ${renewals.payments.toLocaleString("en-US")}, ${money(renewals.cents)}`);
  } else if (data.sales === "none") {
    lines.push("Sales: connect Stripe in your studio to see them here.");
  } else if (data.sales === "ok") {
    lines.push("Sales: incomplete purchase reading; totals are unavailable.");
  } else {
    lines.push("Sales: the payment provider did not answer; totals are unavailable.");
  }
  const line = ledgerPaymentsComplete(data) ? goalLine(data, goal, money) : goal > 0 ? "Monthly goal progress is unavailable until the payment reading is complete." : "";
  if (line) lines.push(line);

  const measuredChannels = data.channels?.d7 ?? [];
  const channels = (known ? measuredChannels : measuredChannels
    .filter(c => c.visits > 0 || c.checkouts > 0 || c.free > 0)
    .sort((a, b) => b.visits - a.visits || b.checkouts - a.checkouts || a.source.localeCompare(b.source)))
    .slice(0, 3);
  if (channels.length) {
    lines.push("", "Where it came from:");
    for (const c of channels) {
      const sold = known && c.sales > 0 ? `, ${c.sales} ${c.sales === 1 ? "sale" : "sales"} (${money(c.cents)})` : "";
      lines.push(`- ${channelWord(c.source)}: ${c.visits.toLocaleString("en-US")} ${c.visits === 1 ? "visit" : "visits"}${sold}`);
    }
  }

  const worth = insightsFrom(data, "d7", spends, 3);
  if (worth.length) {
    lines.push("", "Worth knowing:");
    for (const item of worth) lines.push(`- ${item.text}`);
  }

  lines.push("", `Everything, day by day and channel by channel, is in your studio: ${SITE_URL}/studio`);
  lines.push("", `You get this every Monday while your store has visitors. To stop it: ${stopUrl}`);
  return { subject: subject.slice(0, 180), text: lines.join("\n") };
}

/** "October goal: $1,240 of $3,000 (41%) …", or "" with no goal. */
function goalLine(data: StatsData, goal: number, money: (cents: number) => string): string {
  const today = data.days[data.days.length - 1]?.date ?? "";
  const progress = goalProgress(goal, moneyByDay(data.channelDays), today);
  if (!progress) return "";
  const name = monthTitle(progress.month).split(" ")[0];
  const share = `${Math.floor(progress.share * 100)}%`;
  if (progress.reachedOn) {
    return `${name} goal: reached on ${name} ${Number(progress.reachedOn.slice(8))}, ${money(progress.done)} of ${money(progress.goal)} (${share}).`;
  }
  const left = progress.days - progress.day;
  return `${name} goal: ${money(progress.done)} of ${money(progress.goal)} (${share})${left > 0 ? `, ${money(progress.perDay)} a day needed for the ${left} ${left === 1 ? "day" : "days"} left` : ""}.`;
}

// ---- The monthly email ------------------------------------------------------------

const monthSentKey = (month: string, handle: string) => `nl:monthly:sent:${month}:${handle}`;

/** The month before the one `now` is in, "2026-09". */
export function lastMonthOf(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** Claims a month's email for a store; false when it was already claimed, or when the answer is not known to be ours. */
export async function claimMonth(handle: string, month: string): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const period = monthPeriod(handle, month);
  return ownClaim(period.key, period.seconds);
}

/** Lets a month's claim go, when the numbers could not be read, so a later run tries again. */
export async function releaseMonth(handle: string, month: string): Promise<void> {
  if (isRedisConfigured()) await redisPipeline([["DEL", monthSentKey(month, handle)]]);
}

/**
 * The month's email (added 11 October 2026), sent on the 1st for the month
 * just ended, as Kissmetrics and Baremetrics send theirs: the month's
 * visitors, sales and money set beside the month before, the channels the
 * money came from, its best day, and the goal if there was one. Read from the
 * same 90 days the studio reads, so the month before is there in full. Null
 * when the month had no visitors and no money.
 */
export function monthlyMessage(store: Store, data: StatsData, month: string, stopUrl: string, goal = 0): { subject: string; text: string } | null {
  const known = paidFiguresComplete(data);
  const paymentsKnown = ledgerPaymentsComplete(data);
  const money = (cents: number) => formatMoney(cents, data.currency ?? "usd");
  const byDay = moneyByDay(data.channelDays);
  const [y, m] = month.split("-").map(Number);
  const before = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const sum = (which: string) => {
    const days = data.days.filter((d) => d.date.startsWith(which));
    return {
      visitors: days.reduce((n, d) => n + d.visitors, 0),
      checkouts: days.reduce((n, d) => n + d.checkouts, 0),
      sales: days.reduce((n, d) => n + d.sales, 0),
      cents: Object.entries(byDay).reduce((n, [day, cents]) => (day.startsWith(which) ? n + cents : n), 0),
    };
  };
  const now = sum(month);
  if (now.visitors === 0 && now.cents === 0) return null;
  // The month before only when the days read start at its first day or earlier.
  const then = data.days[0] && data.days[0].date <= `${before}-01` ? sum(before) : null;
  const against = (a: number, b: number | undefined) => {
    if (!b) return "";
    const value = ((a - b) / b) * 100;
    if (Math.abs(value) < 0.5) return " (the same as the month before)";
    const shown = Math.abs(value) < 10 ? Math.abs(value).toFixed(1) : String(Math.round(Math.abs(value)));
    return ` (${value > 0 ? "up" : "down"} ${shown}% on the month before)`;
  };
  const title = monthTitle(month);
  const lines = [`Here is ${store.name} in ${title}.`, ""];
  lines.push(`Visitors: ${now.visitors.toLocaleString("en-US")}${against(now.visitors, then?.visitors)}`);
  lines.push(`Checkouts started: ${now.checkouts.toLocaleString("en-US")}${against(now.checkouts, then?.checkouts)}`);
  if (known) lines.push(`Sales: ${now.sales.toLocaleString("en-US")}`);
  else if (data.sales === "none") lines.push("Sales: connect Stripe in your studio to see them here.");
  else if (data.sales === "ok") lines.push("Sales: incomplete purchase reading; totals are unavailable.");
  else lines.push("Sales: the payment provider did not answer; totals are unavailable.");
  if (paymentsKnown) {
    lines.push(`Money from sales and renewals: ${money(now.cents)} before Stripe's fee${against(now.cents, then?.cents)}`);
    const channels = Object.entries(data.channelDays ?? {})
      .map(([channel, days]) => ({ channel, cents: Object.entries(days).reduce((n, [day, c]) => (day.startsWith(month) ? n + c : n), 0) }))
      .filter((row) => row.cents > 0)
      .sort((a, b) => b.cents - a.cents)
      .slice(0, 3);
    if (channels.length) {
      lines.push("", "Where the money came from:");
      for (const c of channels) lines.push(`- ${channelWord(c.channel)}: ${money(c.cents)}`);
    }
    const best = Object.entries(byDay)
      .filter(([day]) => day.startsWith(month))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best && best[1] > 0) {
      const [by, bm, bd] = best[0].split("-").map(Number);
      const name = new Date(Date.UTC(by, bm - 1, bd)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
      lines.push("", `Best day: ${name}, ${money(best[1])}. Worth noting what you did that day.`);
    }
    if (goal > 0) {
      const share = Math.floor((now.cents / goal) * 100);
      lines.push(
        "",
        now.cents >= goal
          ? `Your goal of ${money(goal)} was reached: ${share}%.`
          : `Your goal was ${money(goal)}: ${money(now.cents)} came in, ${share}% of it.`,
      );
    }
  } else {
    if (data.sales === "ok") lines.push("Money from sales and renewals: incomplete payment reading; totals are unavailable.");
    if (goal > 0) lines.push("Monthly goal progress is unavailable until the payment reading is complete.");
  }
  lines.push("", `Everything, day by day, is in your studio: ${SITE_URL}/studio`);
  lines.push("", `You get this on the 1st of each month while your store has visitors. To stop it, the weekly one and the busy-day one: ${stopUrl}`);
  // The money is sales and renewals together, so it is not said to be "from" the count of sales.
  const subject = paymentsKnown ? `${store.name} in ${title}: ${money(now.cents)} in sales and renewals` : `${store.name} in ${title}`;
  return { subject: subject.slice(0, 180), text: lines.join("\n") };
}

// ---- The busy-day alert ------------------------------------------------------------

/** The fewest store-page views in a day that can make a busy day. */
export const BUSY_FLOOR = 64;
/** How many times a usual day's views make a busy one. */
export const BUSY_TIMES = 3;

const busyKey = (handle: string, day: string) => `nl:busy:${day}:${handle}`;

/**
 * Whether today's views make a busy day: at least BUSY_FLOOR, at least
 * BUSY_TIMES a usual day of the last two weeks, and more than any one of them.
 * Pure, so the rule is held by a test.
 */
export function isBusy(today: number, before: number[]): { busy: boolean; times: number } {
  const usual = before.length ? before.reduce((a, b) => a + b, 0) / before.length : 0;
  const most = before.length ? Math.max(...before) : 0;
  const busy = today >= BUSY_FLOOR && today >= BUSY_TIMES * usual && today > most;
  return { busy, times: usual >= 5 ? Math.floor(today / usual) : 0 };
}

/**
 * The email when a store is busier than usual (added 11 October 2026): a post
 * is bringing people now, which is the moment to answer comments, pin the
 * post or post again — and the one the creator would otherwise learn about
 * the next week.
 *
 * Asked only when today's views reach 64, 128, 256 and so on (lib/visit.ts),
 * so it costs a visit nothing: the few reads it makes happen a handful of
 * times a day at most. Once a day per store, only for a store with a plan
 * running, and never for one whose creator stopped the numbers emails.
 */
export async function maybeBusyAlert(store: Store, today: number, now = Date.now()): Promise<boolean> {
  if (today < BUSY_FLOOR || (today & (today - 1)) !== 0) return false;
  if (!isRedisConfigured() || !isSenderConfigured()) return false;
  const standing = standingOf(store);
  if (standing !== "paid" && standing !== "trial") return false;
  if (await weeklyOff(store.handle)) return false;
  const verdict = isBusy(today, await viewsBefore(store, 14, now));
  if (!verdict.busy) return false;
  const day = new Date(now).toISOString().slice(0, 10);
  if (!(await ownClaim(busyKey(store.handle, day), 2 * 86400))) return false;

  const top = (await sourcesToday(store, now)).filter((s) => s.name !== "direct")[0];
  const token = weeklyToken(store.handle);
  const stopUrl = `${SITE_URL}/api/store/weekly?h=${encodeURIComponent(store.handle)}&t=${encodeURIComponent(token)}`;
  const lines = [
    `${store.name} is having a busy day: ${today.toLocaleString("en-US")} visits to your store page so far today${
      verdict.times >= 2 ? `, about ${verdict.times} times a usual day` : ", more than any day in the last two weeks"
    }.`,
    "",
    top ? `Most of them came from ${channelWord(top.name)}.` : "",
    "While people are arriving is a good moment to answer comments, pin the post that is working, or share it again.",
    "",
    `See who is on your store right now and where they came from: ${SITE_URL}/studio`,
    "",
    `This comes at most once a day, on a day that is clearly busier than usual. To stop these emails and the weekly one: ${stopUrl}`,
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "");
  return sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: `${store.name} is busy today: ${today.toLocaleString("en-US")} visits so far`.slice(0, 180),
    text: lines.join("\n"),
    headers: { "List-Unsubscribe": `<${stopUrl}>` },
  }).catch(() => false);
}

/** Lets this week's claim go, when the numbers could not be read, so a later run tries again (as releaseMonth does for the month). */
export async function releaseWeek(handle: string, now = Date.now()): Promise<void> {
  if (isRedisConfigured()) await redisPipeline([["DEL", sentKey(weekOf(now), handle)]]);
}
