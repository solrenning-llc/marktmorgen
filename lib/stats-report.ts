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
import { STORE_ID_PATTERN, type Store } from "@/lib/store";
import { type StopOwner, readStop, stopCommand } from "@/lib/store-stop";
import { type Ranked, type StatsData, readSales, readsSales, readStats, sourcesToday, studioStats, viewsBefore } from "@/lib/stats";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { standingOf } from "@/lib/plan-standing";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark } from "@/lib/claim-mark";
import { deriveKey } from "@/lib/secret-box";
import { formatMoney } from "@/lib/money";
import { insightsFrom } from "@/lib/insights";
import type { AdSpend } from "@/lib/ad-spend-rules";
import { SITE_URL } from "@/lib/site-url";
import { goalProgress, moneyByDay, monthTitle } from "@/lib/sales-goal-rules";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";

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

/**
 * The token of a stop link signed for an address, as every numbers email carried until 9 November 2026 and a
 * store without an id yet still does: the address, signed with a key only this deployment has. Such a link is
 * honored only for a store known to have held that address since before then (addressLinkHolds).
 */
export function weeklyToken(handle: string): string {
  return signed(`weekly|${handle}`);
}

export function weeklyTokenOk(handle: string, token: string): boolean {
  return sameToken(weeklyToken(handle), token);
}

const signed = (text: string): string => {
  const key = deriveKey("weekly-report");
  if (!key) return "";
  return createHmac("sha256", key).update(text).digest("base64url").slice(0, 32);
};

const sameToken = (want: string, token: string): boolean =>
  want !== "" && token.length === want.length && timingSafeEqual(Buffer.from(want), Buffer.from(token));

/**
 * The stop link of a numbers email, or "" when this deployment has no key to sign it (then no email goes).
 * Signed for the store's id, with the address it had when the email went for the page to show (siblings of
 * finding 5 of the handles audit, Claude 5): a link signed for an address stopped, or started again, the emails
 * of whichever store held that address when it was pressed, so once a store let an address go and another took
 * it after the quarantine, the old store's link changed the new store's emails. An address never holds ":", so
 * the id's text is never read as an address's. A store without an id yet (one made before there were several,
 * until its owner opens the studio) has only its address to sign.
 */
export function weeklyStopUrl(store: Pick<Store, "sid" | "handle">): string {
  const sid = typeof store.sid === "string" && STORE_ID_PATTERN.test(store.sid) ? store.sid : null;
  const token = sid ? signed(`weekly|sid:${sid}|${store.handle}`) : weeklyToken(store.handle);
  if (!token) return "";
  return `${SITE_URL}/api/store/weekly?${sid ? `s=${sid}&` : ""}h=${encodeURIComponent(store.handle)}&t=${encodeURIComponent(token)}`;
}

/** A team member's own stop link, which stops only their copy: the store's id, the address shown and theirs, signed. */
export function weeklyMemberStopUrl(store: Pick<Store, "sid" | "handle">, email: string): string {
  const address = email.trim().toLowerCase();
  const sid = typeof store.sid === "string" && STORE_ID_PATTERN.test(store.sid) ? store.sid : null;
  const token = sid ? signed(`weekly|sid:${sid}|${store.handle}|${address}`) : weeklyMemberToken(store.handle, address);
  if (!token) return "";
  return `${SITE_URL}/api/store/weekly?${sid ? `s=${sid}&` : ""}h=${encodeURIComponent(store.handle)}&e=${encodeURIComponent(address)}&t=${encodeURIComponent(token)}`;
}

/** Whether a link's token is the one signed for this store's id and the address it shows (and the member's address). */
export function weeklyStoreTokenOk(sid: string, handle: string, token: string, email?: string): boolean {
  if (!STORE_ID_PATTERN.test(sid)) return false;
  return sameToken(signed(`weekly|sid:${sid}|${handle}${email === undefined ? "" : `|${email.trim().toLowerCase()}`}`), token);
}

/**
 * From this moment every numbers email of a store with an id carries a link signed for the id (weeklyStopUrl), so
 * a link signed for an address was sent before it. Set no later than the day the change was written: a store that
 * took an address at or after it may have taken it from a store that let it go, and the link was not sent to it.
 */
export const ADDRESS_LINKS_END = Date.parse("2026-11-09T00:00:00.000Z");

/**
 * Whether a link signed for `handle` (weeklyToken, weeklyMemberToken) may change this store's emails: the store
 * the address leads to now (storeForHandle: the current address or one it still owns, never one let go of), and
 * known to have held it since before ADDRESS_LINKS_END, so the link was sent to it and not to a store that held
 * the address before. Its current address since its last rename (renamedAt) or since it was made (createdAt);
 * an address it used before, since before its last rename at the latest. A store without an id yet is only ever
 * sent such links, and holds the address it had before ids. A time missing from a record older than the field is
 * before; one that does not read is not known, and the link changes nothing (the newest email has a link that does).
 * One case stays out of reach: an address let go of and taken again before ADDRESS_LINKS_END, as on main before.
 */
export function addressLinkHolds(store: Pick<Store, "sid" | "handle" | "previousHandles" | "createdAt" | "renamedAt">, handle: string): boolean {
  const current = store.handle === handle;
  if (!current && !(store.previousHandles ?? []).includes(handle)) return false;
  if (!store.sid) return true;
  const before = (at: unknown): boolean => at === "" || at === undefined || (typeof at === "string" && Date.parse(at) < ADDRESS_LINKS_END);
  return current ? before(store.renamedAt ? store.renamedAt : store.createdAt) : before(store.renamedAt);
}

/** The set of stopped stores, for the step that carries a stop before an address is let go (lib/store-stop.ts). */
export const WEEKLY_OFF_SET = OFF;

/**
 * Whether the numbers emails are stopped for a store: true when its creator
 * pressed "Stop", and also when the answer is in any other shape than 0 or 1
 * (CX-123 rule 24): an unknown answer is never "not stopped", so no numbers
 * email goes on it this time, and it is said in the log. Sweep A6 (Claude 5).
 * Read by the store's id and the addresses it owns (lib/store-stop.ts), so a
 * rename never loses the stop (finding 5 of the handles audit, Claude 5).
 */
export async function weeklyOff(store: StopOwner): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const stopped = await readStop(OFF, store);
  if (stopped !== "unknown") return stopped;
  console.error("weekly-off: whether the numbers emails are stopped is unknown; no numbers email this time");
  return true;
}

export async function setWeeklyOff(store: StopOwner, off: boolean): Promise<void> {
  if (!isRedisConfigured()) return;
  // "Stop" adds one member; "Start again" takes out the id and every address the store owns, so it may answer up to that many.
  const command = stopCommand(OFF, store, off);
  confirmedWrite(await redisPipeline([command]), [command.length - 2], "the weekly email's stop");
}

/**
 * A write's own answer read exactly (CX-123 rule 24): one whole count per command, none above what that command
 * could change; any other shape throws, so a stop or a change is never said as done when nothing confirmed it.
 */
function confirmedWrite(replies: unknown, most: number[], what: string): void {
  const exact =
    Array.isArray(replies) &&
    replies.length === most.length &&
    replies.every((reply, i) => typeof reply === "number" && Number.isSafeInteger(reply) && reply >= 0 && reply <= most[i]);
  if (!exact) throw new UnknownReplyError(what);
}

// ---- The weekly email to the team (added 11 October 2026) ---------------------

/**
 * Team members the owner chose to send the weekly email to as well
 * (Fathom and Umami send their reports to a team the same way). Each is
 * checked against the team when the email goes, so somebody removed from the
 * team, or whose role no longer sees the numbers, gets nothing; and each has
 * their own stop link, which stops only their copy.
 */
const teamKey = (sid: string) => `nl:weekly:team:${sid}`;
/** Where the list was kept until 9 November 2026: under the store's address, so a rename lost it. Read, never written. */
const addressTeamKey = (handle: string) => `nl:weekly:to:${handle}`;
export const MAX_WEEKLY_TEAM = 5;

/** What names a store for its team list: its id, and the addresses it still owns, for a list written before. */
export type TeamOwner = Pick<Store, "sid" | "handle" | "previousHandles">;

const teamIdOf = (store: TeamOwner): string | null => (typeof store.sid === "string" && STORE_ID_PATTERN.test(store.sid) ? store.sid : null);
const ownedAddresses = (store: TeamOwner): string[] =>
  [...new Set([store.handle, ...[...(store.previousHandles ?? [])].reverse()].filter((h) => typeof h === "string" && h !== ""))];

/**
 * Kept in the id's list beside the addresses, so a list the owner set, even an empty one, is told apart from no list
 * at all: a set Redis holds cannot be empty, and an empty list read as "none" would bring back one written before.
 * Never an email address (no "@"), so never sent to.
 */
const LIST_SET = ":set";

const membersOf = (list: string[]): string[] =>
  [...new Set(list.filter((e) => e !== LIST_SET).map((e) => e.trim().toLowerCase()))].sort().slice(0, MAX_WEEKLY_TEAM);

/**
 * Who the owner chose, read exactly (CX-123 rule 24) in one pipeline of at most two commands: the list kept by the
 * store's id once it is set there (LIST_SET); until then, the list written before under its current address, the
 * only one the code before read. The address is read first and the id second: a pipeline is not atomic, and a
 * rename's move (keepWeeklyTeamById) landing between the two reads then finds the list in one place or the other,
 * never in neither (pre-review of claude5/email-stop-by-sid-2, L3). Never one under an address the store used before (pre-review P2 of
 * claude5/email-stop-by-sid-2): after a rename there the owner chose again under the new address, so an older list
 * read now would bring back members taken out or stopped since. A rename sets the list by the id first
 * (keepWeeklyTeamById), so a rename loses nobody. Any answer of another shape throws, never "nobody".
 */
export async function weeklyTeam(store: TeamOwner): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const sid = teamIdOf(store);
  const current = typeof store.handle === "string" && store.handle !== "" ? addressTeamKey(store.handle) : null;
  const commands = [...(current ? [["SMEMBERS", current]] : []), ...(sid ? [["SMEMBERS", teamKey(sid)]] : [])];
  if (!commands.length) return [];
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  const lists = replies?.map(stringList);
  if (!lists || lists.some((list) => list === null)) throw new UnknownReplyError("who gets the weekly email");
  const byAddress = current ? (lists[0] as string[]) : [];
  const byId = sid ? (lists[commands.length - 1] as string[]) : null;
  if (byId && byId.includes(LIST_SET)) return membersOf(byId);
  return membersOf(byAddress);
}

/** The owner's choice, kept by the store's id and marked set (LIST_SET); a list written before under any address it owns is taken out with it. */
export async function setWeeklyTeam(store: TeamOwner, emails: string[]): Promise<void> {
  if (!isRedisConfigured()) return;
  const sid = teamIdOf(store);
  if (!sid) throw new Error("a store without an id keeps no team list");
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e !== "" && e !== LIST_SET))].slice(0, MAX_WEEKLY_TEAM);
  const keys = [teamKey(sid), ...ownedAddresses(store).map(addressTeamKey)];
  // DEL and SADD are each one command, so each is whole; should the SADD be refused after the DEL, nobody gets a
  // copy (never somebody taken out) and the owner is told it was not saved.
  const replies = await redisPipeline([["DEL", ...keys], ["SADD", teamKey(sid), LIST_SET, ...clean]]);
  confirmedWrite(replies, [keys.length, clean.length + 1], "who gets the weekly email");
}

/**
 * A member's own stop: their address out of the list, wherever the store's list is kept. The id's list is taken out of
 * last (pre-review of claude5/email-stop-by-sid-2, A1): the only way onto it is a rename's move from the address,
 * already taken out of when the move lands later, or the owner's own save, a new choice. So a 0 from every SREM
 * means the member was on no list at that moment, and "stopped" is true without reading the list again.
 */
export async function leaveWeeklyTeam(store: TeamOwner, email: string): Promise<void> {
  if (!isRedisConfigured()) return;
  const sid = teamIdOf(store);
  const keys = [...ownedAddresses(store).map(addressTeamKey), ...(sid ? [teamKey(sid)] : [])];
  const address = email.trim().toLowerCase();
  if (address === LIST_SET) return;
  confirmedWrite(await redisPipeline(keys.map((key) => ["SREM", key, address])), keys.map(() => 1), "a team member's weekly email stop");
}

/**
 * Before the store's address changes (app/api/store/rename/route.ts): the list it reads now, while still kept under
 * its current address, goes to its id, so a rename loses nobody. A SADD of the mark into the address's list,
 * confirmed, then one RENAMENX, which moves the whole list to the id at once (a pipeline is not atomic; RENAMENX is
 * one command, so the list is never in neither place). With no list under the address the mark alone makes an empty
 * list, set, so a list left under the next address is never read.
 *
 * RENAMENX, never RENAME (pre-review of claude5/email-stop-by-sid-2, M2): the owner may save a new list by the id
 * while the rename runs, and RENAME would put the older address list over it. When RENAMENX answers 0 the id already
 * holds a list, which only the owner's save or an earlier move writes, always marked set: it wins, and the address's
 * list, never read again, is taken out at once with one DEL, confirmed, rather than left to wait for the address to
 * be let go (should it ever lapse another way, the next store there would find it). The same path serves a store
 * whose list was moved by an earlier rename, so no SISMEMBER is asked first, and a rename stays at three commands.
 * When the owner's save took the address's list out between the mark and the move, RENAMENX answers Redis's "no such
 * key" (lib/redis.ts throws it): the route then changes nothing and says so (not_confirmed), and the next try moves
 * nothing over the id's list. Any answer of another shape throws UnknownReplyError.
 */
export async function keepWeeklyTeamById(store: TeamOwner): Promise<void> {
  if (!isRedisConfigured()) return;
  const sid = teamIdOf(store);
  // No id, no team copy is sent (the weekly job sends to a team only with one), so there is nothing to keep.
  if (!sid || typeof store.handle !== "string" || store.handle === "") return;
  const from = addressTeamKey(store.handle);
  confirmedWrite(await redisPipeline([["SADD", from, LIST_SET]]), [1], "the team list marked set before it moves to the store's id");
  const moved = repliesFor(await redisPipeline([["RENAMENX", from, teamKey(sid)]]), 1);
  const answer = moved ? countOf(moved[0]) : null;
  if (answer !== 0 && answer !== 1) throw new UnknownReplyError("the team list moved to the store's id (RENAMENX)");
  if (answer === 0) confirmedWrite(await redisPipeline([["DEL", from]]), [1], "the address's older team list taken out");
}

/**
 * Before the store lets go of `handle` (app/api/store/release/route.ts): a list under that address is never read
 * (weeklyTeam reads the id's or the current address's), so it is taken out, and the next store at the address
 * does not inherit it. One DEL; any answer of another shape throws UnknownReplyError, so nothing is let go on it.
 */
export async function forgetWeeklyTeamAt(store: TeamOwner, handle: string): Promise<void> {
  if (!isRedisConfigured() || handle === store.handle || !(store.previousHandles ?? []).includes(handle)) return;
  confirmedWrite(await redisPipeline([["DEL", addressTeamKey(handle)]]), [1], "a team list under an address let go of");
}

/** A team member's stop link token signed for an address, as before 9 November 2026 (see weeklyToken). */
export function weeklyMemberToken(handle: string, email: string): string {
  return signed(`weekly|${handle}|${email.trim().toLowerCase()}`);
}

export function weeklyMemberTokenOk(handle: string, email: string, token: string): boolean {
  return sameToken(weeklyMemberToken(handle, email), token);
}

/**
 * Claims this week's email for a store; false when it was already claimed, so nobody gets two. Read exactly
 * (lib/claim-mark.ts, CX-123 rule 24): an answer not known to be this run's is never a claim, and nothing is sent on it.
 */
export async function claimWeek(handle: string, now = Date.now()): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  return ownClaim(sentKey(weekOf(now), handle), 9 * 86400);
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
  return ownClaim(monthSentKey(month, handle), 40 * 86400);
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
  if (await weeklyOff(store)) return false;
  const verdict = isBusy(today, await viewsBefore(store, 14, now));
  if (!verdict.busy) return false;
  const day = new Date(now).toISOString().slice(0, 10);
  if (!(await ownClaim(busyKey(store.handle, day), 2 * 86400))) return false;

  const top = (await sourcesToday(store, now)).filter((s) => s.name !== "direct")[0];
  const stopUrl = weeklyStopUrl(store);
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
