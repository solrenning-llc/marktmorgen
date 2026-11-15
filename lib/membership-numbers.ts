/**
 * How a store's memberships are doing, in the numbers a subscription business
 * is run on: recurring revenue, members, churn and trials that became paying.
 *
 * Measured before it was built (30 September 2026): Whop shows MRR, ARR,
 * churn rate, churned revenue and trial conversion; Circle shows MRR, churn
 * and trial conversion from its payments page. Stan's analytics count store
 * visits and sales. Here the figures are worked out from the creator's own
 * Stripe account — every membership of this store Stripe holds — so they
 * are the creator's own truth, not a copy that can drift.
 *
 * What each figure means, exactly, because a number nobody can check is a
 * number nobody should act on:
 *
 *   - Monthly recurring revenue: every paying membership (active, or with a
 *     payment being retried), at its list price, before discounts and tax,
 *     turned into a month — a yearly one counts a twelfth, a weekly one 52
 *     twelfths. Memberships still in their free trial are counted apart.
 *   - Churn over 30 days: of the memberships that were paying 30 days ago,
 *     the share that has ended since.
 *   - Trials that became paying: of the free trials that ended in the last
 *     90 days, how many were still running a day after the trial ended.
 *
 * Payment plans are not memberships and are left out. Only one currency is
 * summed, the store's own; memberships sold in another before the store
 * changed its currency are counted as members and said apart.
 *
 * Read at most MAX_PAGES pages of 100 and kept CACHE_SECONDS, so the page
 * that shows them asks Stripe at most once every few minutes.
 */
import { DISCOUNT_KINDS, type DiscountKind, entryOf } from "@/lib/discount-impact";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { normaliseEmail } from "@/lib/auth";
import { keepUnlessErased, suppressedAmong } from "@/lib/suppression";
import { onAccount } from "@/lib/stripe-account";
import { type Store, saleHandles } from "@/lib/store";
import { type Invoice, type Movements, movementsFrom, pricesFrom, UnreadInvoiceError } from "@/lib/mrr-movements";
import { LEAVE_NAMES, LEAVE_REASONS, type LeaveReason, isLeaveReason, isOwnReasonId } from "@/lib/leave-rules";
import { stopsBeforeSoldEnd } from "@/lib/fixed-end-rules";

const MAX_PAGES = 20;
const CACHE_SECONDS = 10 * 60;
const DAY = 86_400;

export type Sub = {
  id: string;
  /** The customer's address when Stripe gave the customer whole; "" otherwise (never kept in the numbers). */
  email?: string;
  status: string;
  product: string;
  /** In the currency's smallest unit, per interval, quantity included. */
  amount: number;
  currency: string;
  interval: string;
  count: number;
  start: number;
  ended: number;
  trialEnd: number;
  /**
   * The channel it was sold through (lib/visit-channel.ts), "direct" for none
   * the store could name, and "unrecorded" for one sold before channels were
   * written onto memberships on October 11, 2026.
   */
  channel: string;
  /** How it began: at full price, or with which discount (lib/discount-impact.ts). Absent on a reading from before October 12, 2026. */
  entry?: DiscountKind;
  /** When the member asked to cancel (seconds), 0 for never; and why, as Stripe's portal recorded it. */
  canceledAt: number;
  /** Stripe's own reason: "cancellation_requested", "payment_failed" or "payment_disputed"; "" for none. */
  cancelCause: string;
  /**
   * The answer the member picked ("too_expensive", "unused"…, or one of the
   * creator's own, "own_…"), "" for none: on the store's own page when it
   * asked (lib/leave-rules.ts), otherwise in Stripe's portal.
   */
  feedback: string;
  /** The words of the creator's own reason, as the member read them; "" for any other. */
  feedbackText?: string;
  /** What the member wrote, if anything, at most COMMENT_LENGTH characters. */
  comment: string;
  /** The Stripe customer it belongs to: one member, whatever memberships they hold (lib/mrr-movements.ts). */
  customer?: string;
};

/**
 * Why members leave (added 11 October 2026). The Stripe page where a member
 * cancels (lib/membership-manage.ts) asks them why, from a short list, with
 * room for a sentence; Stripe keeps the answer on the membership. Or, with
 * the store's own question on (lib/leave-rules.ts), the answer given there,
 * written on the membership as it is opened for cancelling. Baremetrics
 * sells reading those answers as Cancellation Insights. Here they are summed
 * over the last year and the latest sentences shown as written, without the
 * member's name or address beside them.
 */
export { LEAVE_NAMES, LEAVE_REASONS, type LeaveReason, isLeaveReason };
const COMMENT_LENGTH = 400;
const MAX_COMMENTS = 10;
/** The sentences of the last 90 days kept for the monthly summary of what customers say (lib/customer-voice.ts). */
const MAX_RECENT_COMMENTS = 60;
/** What members wrote that a reading can show at all: the latest MAX_COMMENTS and the 90 days' MAX_RECENT_COMMENTS. */
export const SHOWN_COMMENTS = MAX_COMMENTS + MAX_RECENT_COMMENTS;

export type Leaving = {
  /** Members who asked to cancel in the last year, by their own choice (not a failed payment). */
  canceled: number;
  /** Of them, how many picked a reason. */
  answered: number;
  /** The reasons picked, most first. */
  reasons: { reason: string; members: number; mrr: number }[];
  /** Memberships ended by a payment that never went through, in the last year. */
  paymentFailed: number;
  /** The latest sentences members wrote, newest first. */
  comments: { at: number; reason: string; text: string }[];
  /** Every sentence of the last 90 days, newest first, up to 60 (lib/customer-voice.ts). */
  recent?: { at: number; reason: string; text: string }[];
  /** The words of the creator's own reasons among the answers, by id. */
  own: Record<string, string>;
};

/** Why members left in the last year. Pure. */
export function leavingFrom(subs: Sub[], currency: string, now: number): Leaving {
  const since = now - 365 * DAY;
  const by = new Map<string, { members: number; mrr: number }>();
  const out: Leaving = { canceled: 0, answered: 0, reasons: [], paymentFailed: 0, comments: [], own: {} };
  for (const sub of subs) {
    const at = sub.canceledAt || (sub.cancelCause ? sub.ended : 0);
    if (!at || at < since || at > now) continue;
    if (sub.cancelCause === "payment_failed" || sub.cancelCause === "payment_disputed") {
      out.paymentFailed += 1;
      continue;
    }
    out.canceled += 1;
    const reason = isLeaveReason(sub.feedback) || isOwnReasonId(sub.feedback) ? sub.feedback : "";
    if (isOwnReasonId(reason) && sub.feedbackText) out.own[reason] = sub.feedbackText;
    if (reason) {
      out.answered += 1;
      const row = by.get(reason) ?? { members: 0, mrr: 0 };
      row.members += 1;
      if (sub.currency === currency) row.mrr += monthly(sub.amount, sub.interval, sub.count);
      by.set(reason, row);
    }
    if (sub.comment) out.comments.push({ at, reason, text: sub.comment });
  }
  out.reasons = [...by.entries()]
    .map(([reason, r]) => ({ reason, members: r.members, mrr: Math.round(r.mrr) }))
    .sort((a, b) => b.members - a.members || b.mrr - a.mrr);
  out.comments = out.comments.sort((a, b) => b.at - a.at);
  out.recent = out.comments.filter((c) => c.at >= now - 90 * DAY).slice(0, MAX_RECENT_COMMENTS);
  out.comments = out.comments.slice(0, MAX_COMMENTS);
  return out;
}

/**
 * The next three months, if the pace of the last 90 days holds (added 11
 * October 2026), as Baremetrics' Forecast does: each month keeps the share of
 * paying members the last 90 days kept, and gains the recurring revenue the
 * last 90 days gained from members who joined in them and are still paying. An estimate, said as one; null when fewer than
 * FORECAST_MIN members were paying 90 days ago, because a pace read off three
 * people is not a pace.
 */
export type Forecast = {
  /** Monthly recurring revenue at the end of each of the next three months. */
  months: number[];
  /** Recurring revenue gained a month, on average over the last 90 days. */
  gained: number;
  /** The share of paying members lost a month, on average over the last 90 days (0 to 1). */
  lost: number;
};
export const FORECAST_MIN = 5;

export function forecastFrom(subs: Sub[], currency: string, now: number, mrr: number): Forecast | null {
  const t90 = now - 90 * DAY;
  let base = 0;
  let left = 0;
  let gained = 0;
  for (const sub of subs) {
    if (sub.currency !== currency || !sub.start) continue;
    const paying = Math.max(sub.start, sub.trialEnd || 0);
    // A trial that ended without a payment never paid.
    if (sub.trialEnd && sub.ended && sub.ended <= sub.trialEnd + DAY) continue;
    if (paying < t90 && (!sub.ended || sub.ended > t90)) {
      base += 1;
      if (sub.ended && sub.ended <= now) left += 1;
    } else if (paying >= t90 && paying <= now && PAYING.has(sub.status) && (!sub.ended || sub.ended > now)) {
      // Only those still paying: one that joined and left again inside the
      // 90 days gained nothing, and the departures of members who joined
      // before them are all the loss that is read.
      gained += monthly(sub.amount, sub.interval, sub.count);
    }
  }
  if (base < FORECAST_MIN) return null;
  const lost = 1 - Math.pow(1 - left / base, 1 / 3);
  const perMonth = gained / 3;
  const months: number[] = [];
  let at = mrr;
  for (let i = 0; i < 3; i += 1) {
    at = at * (1 - lost) + perMonth;
    months.push(Math.round(at));
  }
  return { months, gained: Math.round(perMonth), lost };
}

/**
 * Who stays (added 11 October 2026): the memberships begun in one month, and
 * the share still running a number of months later. Mixpanel, Amplitude and
 * Matomo call it a cohort table; it is how a membership business sees whether
 * the people who join now stay as long as the people who joined before.
 */
export type Cohort = {
  /** The month the memberships began, "2026-08". */
  month: string;
  started: number;
  /** For each age in STAY_AGES, the share (0 to 1) still running at it, or null before every one of them can be that old. */
  stayed: (number | null)[];
};

/** By the channel it was sold through: of those begun in the last year, how many stayed and for how long. */
export type ChannelStay = {
  channel: string;
  started: number;
  /** Still running now (paying, in a trial, or with a payment being retried). */
  running: number;
  /** The share still running three months in, of those begun at least three months ago; null with none that old. */
  stayed3: number | null;
  /** Months each was kept on average, so far: a running one counts the months it has run. */
  months: number;
};

/** The ages a cohort is read at, in months. */
export const STAY_AGES = [1, 2, 3, 6, 12];
const MONTH = 30.4375 * DAY;

export type ProductNumbers = { product: string; members: number; trialing: number; mrr: number };

export type Numbers = {
  currency: string;
  mrr: number;
  paying: number;
  trialing: number;
  /** Paying members whose latest payment failed and is being retried. */
  atRisk: number;
  /** MRR the at-risk members make up. */
  atRiskMrr: number;
  /** Ended in the last 30 days, and the MRR they made up. */
  ended30: number;
  endedMrr30: number;
  /** 0 to 1, or null with nobody paying 30 days ago. */
  churn30: number | null;
  /** Trials that ended in the last 90 days, and how many became paying. */
  trialsEnded: number;
  trialsConverted: number;
  /** Memberships in a currency other than the store's, not in the sums. */
  elsewhere: number;
  byProduct: ProductNumbers[];
  /** Whether every membership Stripe holds was read. */
  complete: boolean;
  at: number;
  /** The last twelve months' cohorts, newest first; absent on a reading from before October 11, 2026. */
  cohorts?: Cohort[];
  /** By the channel each was sold through, the biggest first; absent on a reading from before. */
  byChannel?: ChannelStay[];
  /** By how each began, full price or which discount (lib/discount-impact.ts), full price first; absent on a reading from before. */
  byEntry?: (Omit<ChannelStay, "channel"> & { entry: DiscountKind })[];
  /** Why members left in the last year; absent on a reading from before. */
  leaving?: Leaving;
  /** The next three months at the pace of the last 90 days; null with too few members to read a pace from. */
  forecast?: Forecast | null;
  /** Recurring revenue month by month, by what moved it (lib/mrr-movements.ts); absent on a reading from before. */
  movements?: Movements;
};

const LIVE = new Set(["active", "trialing", "past_due"]);
const PAYING = new Set(["active", "past_due"]);

/**
 * One payment, as a month's worth: what MRR adds up. Not rounded: twelve
 * yearly members at $290 are $290 a month, not $290.04, so the sums are
 * rounded once, at the end.
 */
export function monthly(amount: number, interval: string, count: number): number {
  const every = Math.max(1, count);
  const perMonth = interval === "year" ? 1 / 12 : interval === "week" ? 52 / 12 : interval === "day" ? 365 / 12 : 1;
  return (amount * perMonth) / every;
}

/** The numbers, from memberships as read. Pure, so the tests can feed it. */
export function numbersFrom(subs: Sub[], currency: string, now: number, complete = true): Numbers {
  const t30 = now - 30 * DAY;
  const t90 = now - 90 * DAY;
  const byProduct = new Map<string, ProductNumbers>();
  const out: Numbers = {
    currency,
    mrr: 0,
    paying: 0,
    trialing: 0,
    atRisk: 0,
    atRiskMrr: 0,
    ended30: 0,
    endedMrr30: 0,
    churn30: null,
    trialsEnded: 0,
    trialsConverted: 0,
    elsewhere: 0,
    byProduct: [],
    complete,
    at: now,
  };
  let payingThen = 0;
  let churned = 0;
  for (const sub of subs) {
    const own = sub.currency === currency;
    if (!own && LIVE.has(sub.status)) out.elsewhere += 1;
    const month = own ? monthly(sub.amount, sub.interval, sub.count) : 0;
    const row = byProduct.get(sub.product) ?? { product: sub.product, members: 0, trialing: 0, mrr: 0 };
    if (PAYING.has(sub.status)) {
      out.paying += 1;
      out.mrr += month;
      row.members += 1;
      row.mrr += month;
      if (sub.status === "past_due") {
        out.atRisk += 1;
        out.atRiskMrr += month;
      }
    } else if (sub.status === "trialing") {
      out.trialing += 1;
      row.trialing += 1;
    }
    if (row.members || row.trialing) byProduct.set(sub.product, row);

    const endedAt = sub.ended || 0;
    if (endedAt > t30 && endedAt <= now) {
      out.ended30 += 1;
      out.endedMrr30 += month;
    }
    // Paying 30 days ago: begun before then, not ended before then, and past
    // any free trial by then.
    const payingAtStart = sub.start < t30 && (!endedAt || endedAt > t30) && (!sub.trialEnd || sub.trialEnd < t30);
    if (payingAtStart) {
      payingThen += 1;
      if (endedAt && endedAt <= now) churned += 1;
    }
    // A trial that ended in the last 90 days: converted when the membership
    // was still running a day after it ended.
    if (sub.trialEnd && sub.trialEnd >= t90 && sub.trialEnd <= now - DAY) {
      out.trialsEnded += 1;
      if (!endedAt || endedAt > sub.trialEnd + DAY) out.trialsConverted += 1;
    }
  }
  out.churn30 = payingThen > 0 ? churned / payingThen : null;
  out.cohorts = cohortsFrom(subs, now);
  out.byChannel = channelsFrom(subs, now);
  out.byEntry = entriesFrom(subs, now);
  out.leaving = leavingFrom(subs, currency, now);
  out.forecast = forecastFrom(subs, currency, now, out.mrr);
  out.mrr = Math.round(out.mrr);
  out.atRiskMrr = Math.round(out.atRiskMrr);
  out.endedMrr30 = Math.round(out.endedMrr30);
  out.byProduct = [...byProduct.values()]
    .map((row) => ({ ...row, mrr: Math.round(row.mrr) }))
    .sort((a, b) => b.mrr - a.mrr || b.members - a.members);
  return out;
}

/** Whether a membership was still running at a moment: begun by then and not ended by then. */
const runningAt = (sub: Sub, at: number) => sub.start <= at && (!sub.ended || sub.ended > at);

/** The month a moment falls in, "2026-08" (UTC). */
const monthOf = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 7);

/** The last twelve months' cohorts, newest first. Pure. */
export function cohortsFrom(subs: Sub[], now: number): Cohort[] {
  const months: string[] = [];
  const today = new Date(now * 1000);
  for (let i = 0; i < 12; i += 1) months.push(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return months
    .map((month) => {
      const group = subs.filter((sub) => sub.start > 0 && monthOf(sub.start) === month);
      const stayed = STAY_AGES.map((age) => {
        // Only memberships that can already be that old are counted at that age.
        const old = group.filter((sub) => sub.start + age * MONTH <= now);
        if (!old.length || old.length < group.length) return null;
        return old.filter((sub) => runningAt(sub, sub.start + age * MONTH)).length / old.length;
      });
      return { month, started: group.length, stayed };
    })
    .filter((cohort) => cohort.started > 0);
}

/** By channel, for memberships begun in the last year. Pure. */
export function channelsFrom(subs: Sub[], now: number): ChannelStay[] {
  return staysBy(subs, now, (sub) => sub.channel);
}

/**
 * By how each began, for memberships begun in the last year: full price
 * first, then each discount; empty when none began with a discount, so there
 * is nothing to set beside full price. Pure.
 */
export function entriesFrom(subs: Sub[], now: number): (Omit<ChannelStay, "channel"> & { entry: DiscountKind })[] {
  const rows = staysBy(subs, now, (sub) => sub.entry ?? "full");
  if (!rows.some((row) => row.channel !== "full")) return [];
  return DISCOUNT_KINDS.flatMap((kind) => rows.filter((row) => row.channel === kind)).map(({ channel, ...row }) => ({ ...row, entry: channel as DiscountKind }));
}

/** Who stayed and for how long, grouped by `keyOf`, for memberships begun in the last year, the biggest group first. Pure. */
export function staysBy(subs: Sub[], now: number, keyOf: (sub: Sub) => string): ChannelStay[] {
  const by = new Map<string, { started: number; running: number; old: number; stayed: number; months: number }>();
  for (const sub of subs) {
    if (!sub.start || sub.start < now - 365 * DAY) continue;
    const key = keyOf(sub);
    const row = by.get(key) ?? { started: 0, running: 0, old: 0, stayed: 0, months: 0 };
    row.started += 1;
    if (LIVE.has(sub.status) && (!sub.ended || sub.ended > now)) row.running += 1;
    if (sub.start + 3 * MONTH <= now) {
      row.old += 1;
      if (runningAt(sub, sub.start + 3 * MONTH)) row.stayed += 1;
    }
    row.months += (Math.min(sub.ended || now, now) - sub.start) / MONTH;
    by.set(key, row);
  }
  return [...by.entries()]
    .map(([channel, r]) => ({
      channel,
      started: r.started,
      running: r.running,
      stayed3: r.old ? r.stayed / r.old : null,
      months: Math.round((r.months / r.started) * 10) / 10,
    }))
    .sort((a, b) => b.started - a.started || a.channel.localeCompare(b.channel));
}

type Raw = {
  id?: unknown;
  customer?: unknown;
  status?: unknown;
  metadata?: Record<string, string> | null;
  currency?: unknown;
  start_date?: unknown;
  ended_at?: unknown;
  trial_end?: unknown;
  canceled_at?: unknown;
  cancel_at?: unknown;
  billing_cycle_anchor?: unknown;
  cancellation_details?: { reason?: unknown; feedback?: unknown; comment?: unknown } | null;
  items?: { data?: { quantity?: unknown; price?: { unit_amount?: unknown; recurring?: { interval?: unknown; interval_count?: unknown } | null } | null }[] } | null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The reason a member gave. The store's own question writes its answer on the
 * membership as Stripe's page is opened (leave_reason, leave_at); it counts
 * when the membership was canceled within two days of it, so an answer given
 * by somebody who then stayed is not pinned on a later cancellation.
 */
function feedbackOf(raw: Raw): { feedback: string; feedbackText: string } {
  const meta = raw.metadata ?? {};
  const asked = meta.leave_reason ?? "";
  const at = Number(meta.leave_at) || 0;
  const canceled = num(raw.canceled_at);
  if ((isLeaveReason(asked) || isOwnReasonId(asked)) && at && canceled && canceled >= at && canceled - at <= 2 * DAY) {
    return { feedback: asked, feedbackText: isOwnReasonId(asked) ? (meta.leave_text ?? "").slice(0, 80) : "" };
  }
  return { feedback: typeof raw.cancellation_details?.feedback === "string" ? raw.cancellation_details.feedback : "", feedbackText: "" };
}

/** The intervals a Stripe price recurs by. */
const SUB_INTERVALS = new Set(["day", "week", "month", "year"]);
/** A whole number Stripe gave, at least `least`: null when it gave none (absent or null); any other shape throws. */
function exactCount(v: unknown, least: number, what: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < least) throw new Error(`Stripe gave ${what} in a shape that cannot be read`);
  return v;
}

/** A record Stripe gave: undefined when it gave none (absent or null); any other shape (text, a list) throws. */
function exactRecord(v: unknown, what: string): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`Stripe gave ${what} in a shape that cannot be read`);
  return v as Record<string, unknown>;
}

/** A membership as Stripe holds it, when it is one of this store's (not a plan). */
export function readSub(raw: Raw, handles: Set<string>): Sub | null {
  const meta = raw.metadata ?? {};
  if (!handles.has(meta.store ?? "") || !meta.product || meta.kind === "plan") return null;
  // What a member is worth a month is shown as a fact, so its parts are read in their exact shape (CX-123 rule 24):
  // absent or null reads as before (no price, one, a month, once); any other shape throws, never one, a month or free.
  // The records that hold them too (Codex Z on #3055; rule 30): a price or a recurrence in text or as a list is unknown.
  const items = exactRecord(raw.items, "a membership's items");
  const list = items?.data;
  if (list !== undefined && list !== null && !Array.isArray(list)) throw new Error("Stripe gave a membership's items in a shape that cannot be read");
  const item = exactRecord(list?.[0], "a membership's item");
  const price = exactRecord(item?.price, "a membership's price");
  const recurring = exactRecord(price?.recurring, "a membership's recurrence");
  const unit = exactCount(price?.unit_amount, 0, "a membership's price") ?? 0;
  const quantity = exactCount(item?.quantity, 0, "a membership's quantity") ?? 1;
  const every = recurring?.interval;
  if (every !== undefined && every !== null && (typeof every !== "string" || !SUB_INTERVALS.has(every))) throw new Error("Stripe gave a membership's interval in a shape that cannot be read");
  const count = exactCount(recurring?.interval_count, 1, "a membership's interval count") ?? 1;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    status: typeof raw.status === "string" ? raw.status : "",
    product: meta.product,
    amount: unit * quantity,
    currency: typeof raw.currency === "string" ? raw.currency : "",
    interval: typeof every === "string" ? every : "month",
    count,
    start: num(raw.start_date),
    ended: num(raw.ended_at),
    trialEnd: num(raw.trial_end),
    channel: "channel" in meta ? (meta.channel && meta.channel !== "direct" ? meta.channel : "direct") : meta.utm_source || "unrecorded",
    entry: entryOf(meta),
    // A membership with a set number of payments is given its end when it is
    // bought; that is not somebody leaving. Stopped before that end, it is
    // (lib/fixed-end-rules.ts): counted from when the member asked, written by
    // the store's page, else Stripe's own moment.
    canceledAt: meta.ends_after ? (stopsBeforeSoldEnd(raw) ? num(Number(meta.cancel_requested_at)) || num(raw.canceled_at) : 0) : num(raw.canceled_at),
    cancelCause: (!meta.ends_after || stopsBeforeSoldEnd(raw)) && typeof raw.cancellation_details?.reason === "string" ? raw.cancellation_details.reason : "",
    ...feedbackOf(raw),
    customer: typeof raw.customer === "string" ? raw.customer : raw.customer && typeof raw.customer === "object" && typeof (raw.customer as { id?: unknown }).id === "string" ? (raw.customer as { id: string }).id : "",
    // The customer's address, when Stripe gives the customer whole (expand[]=data.customer): to leave out what an erased member wrote.
    email: raw.customer && typeof raw.customer === "object" && typeof (raw.customer as { email?: unknown }).email === "string" ? normaliseEmail((raw.customer as { email: string }).email) : "",
    comment: typeof raw.cancellation_details?.comment === "string" ? raw.cancellation_details.comment.replace(/\s+/g, " ").trim().slice(0, COMMENT_LENGTH) : "",
  };
}

/** The store's membership numbers kept CACHE_SECONDS; a person's erasure deletes it (lib/store-readings.ts, forgetReadingsPerson). */
export const membershipCacheKey = (statsId: string) => `nl:mnum:${statsId}`;
const cacheKey = (store: Store) => membershipCacheKey(store.statsId as string);

/** At most this many addresses read in what a member wrote; one with more is left out whole (it cannot be checked). */
export const COMMENT_ADDRESSES = 2;
const ADDRESS_IN_TEXT = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[a-z]{2,}/gi;

/**
 * Who may be named by what a member wrote when leaving: their customer's
 * address on Stripe (when Stripe gave it) and every address typed in it; null
 * when it holds more addresses than are looked up (then it is left out).
 */
function commentNames(sub: Sub): string[] | null {
  const typed = sub.comment.match(ADDRESS_IN_TEXT) ?? [];
  if (typed.length > COMMENT_ADDRESSES) return null;
  return [...new Set([sub.email ?? "", ...typed].map((e) => normaliseEmail(e)).filter(Boolean))];
}

/** The numbers without what members wrote (a copy that could not be checked, or named someone deleted meanwhile). */
export function withoutMemberWords(numbers: Numbers | null): Numbers | null {
  return numbers?.leaving ? { ...numbers, leaving: { ...numbers.leaving, comments: [], recent: [] } } : numbers;
}

/**
 * What a member wrote when leaving, left out when it may name someone the
 * store deleted (Codex E2 on #2111; rule: an erased person's data never comes
 * back): Stripe keeps the membership and its comment, so every reading would
 * show it again. One HMGET of their prints (lib/suppression.ts); a reply that
 * is not whole throws, and nothing is read. Returns who the words left in
 * may name, for the copies kept to be checked again where they are written.
 */
async function withoutErasedWords(store: Store, subs: Sub[], now: number): Promise<string[]> {
  // Only the newest that can be shown are looked up (leavingFrom keeps MAX_COMMENTS and MAX_RECENT_COMMENTS of
  // them); every other's words are left out, so nothing unchecked is ever shown. One deleted among them leaves
  // fewer shown, never an older one unchecked.
  const atOf = (s: Sub) => s.canceledAt || (s.cancelCause ? s.ended : 0);
  const eligible = subs
    .filter((s) => s.comment && s.cancelCause !== "payment_failed" && s.cancelCause !== "payment_disputed" && atOf(s) >= now - 365 * DAY && atOf(s) <= now)
    .sort((a, b) => atOf(b) - atOf(a));
  const said = eligible.slice(0, SHOWN_COMMENTS);
  const shown = new Set(said);
  for (const sub of subs) if (sub.comment && !shown.has(sub)) sub.comment = "";
  const names = new Map<Sub, string[]>();
  for (const sub of said) {
    const found = commentNames(sub);
    if (found === null) sub.comment = "";
    else names.set(sub, found);
  }
  const all = [...new Set([...names.values()].flat())];
  if (!store.listId || !all.length) return all;
  const gone = await suppressedAmong(store.listId, all);
  for (const [sub, found] of names) if (found.some((e) => gone.has(e))) sub.comment = "";
  return all.filter((e) => !gone.has(e));
}

/**
 * How many bytes this store's kept membership numbers hold, 0 when none are
 * kept, looked up before they are read by a reading that pays for its size
 * (lib/mcp-tools.ts, membershipsTool); null when it did not come back.
 */
export async function keptMembershipBytes(store: Store): Promise<number | null> {
  if (!store.stripeAccountId || !store.statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["STRLEN", cacheKey(store)]]);
  const bytes = Number(n);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

/** This store's membership numbers, from its Stripe account, kept a few minutes. */
export async function membershipNumbers(store: Store, fresh = false, now = Date.now()): Promise<Numbers | null> {
  const read = await membershipNumbersPaid(store, null, fresh, now);
  return read === "refused" ? null : read;
}

/**
 * The numbers read from Stripe now, with who the words of members left in
 * may name (lib/store-readings.ts, keptMembers checks them again where its
 * copy is written).
 */
export async function membershipNumbersNamed(store: Store, now = Date.now()): Promise<{ numbers: Numbers; named: string[] } | null> {
  const read = await readMemberships(store, null, true, now);
  return read === "refused" || read === null ? null : { numbers: read.numbers, named: read.named ?? [] };
}

/**
 * membershipNumbers, asking `beforeStripe` first when they are not kept and
 * the creator's Stripe account is about to be read, so a reading that pays
 * for its size (lib/mcp-tools.ts, membershipsTool) takes it then: "refused"
 * when it says no, with nothing read from Stripe.
 */
export async function membershipNumbersPaid(
  store: Store,
  beforeStripe: (() => Promise<boolean>) | null,
  fresh = false,
  now = Date.now(),
): Promise<Numbers | null | "refused"> {
  const read = await readMemberships(store, beforeStripe, fresh, now);
  return read === "refused" || read === null ? read : read.numbers;
}

/** membershipNumbersPaid, with who its members' words may name when read from Stripe now (null when kept). */
async function readMemberships(
  store: Store,
  beforeStripe: (() => Promise<boolean>) | null,
  fresh: boolean,
  now: number,
): Promise<{ numbers: Numbers; named: string[] | null } | null | "refused"> {
  if (!store.stripeAccountId || !store.statsId) return null;
  if (!fresh && isRedisConfigured()) {
    const [cached] = await redisPipeline([["GET", cacheKey(store)]]);
    if (typeof cached === "string") {
      try {
        return { numbers: JSON.parse(cached) as Numbers, named: null };
      } catch {
        // Read again below.
      }
    }
  }
  if (beforeStripe && !(await beforeStripe())) return "refused";
  const handles = saleHandles(store);
  const subs: Sub[] = [];
  let after = "";
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ status: "all", limit: "100" });
    // Each customer whole, for its address: what an erased member wrote is left out by it (withoutErasedWords).
    query.append("expand[]", "data.customer");
    if (after) query.set("starting_after", after);
    const listed = await onAccount("GET", store.stripeAccountId, `/subscriptions?${query}`);
    // A page in an unknown shape is a reading not made (CX-123 rule 24), said as Stripe not answering, never as a
    // whole list with no members and nothing recurring.
    if (!Array.isArray(listed.data)) throw new Error("Stripe gave a page of memberships that is not a list");
    if (typeof listed.has_more !== "boolean") throw new Error("Stripe gave whether there are more memberships in a shape that cannot be read");
    const rows = listed.data as Raw[];
    for (const raw of rows) {
      const sub = readSub(raw, handles);
      if (sub) subs.push(sub);
    }
    if (!listed.has_more) {
      complete = true;
      break;
    }
    const last = rows[rows.length - 1];
    if (!last || typeof last.id !== "string") throw new Error("Stripe gave a page of memberships with no last one to go on from");
    after = last.id;
  }
  const named = await withoutErasedWords(store, subs, Math.floor(now / 1000));
  let numbers = numbersFrom(subs, store.currency, Math.floor(now / 1000), complete);
  // What moved recurring revenue each month: the invoices of the last thirteen
  // months say what each membership was charged at, and from when.
  try {
    const invoices: Invoice[] = [];
    let page = "";
    const since = Math.floor(now / 1000) - 400 * DAY;
    // Drawn only from the whole list (CX-123 rule 24): Stripe lists the newest first, so a list cut short would
    // leave out the oldest invoices, and a member would seem new or never to have changed price.
    let whole = false;
    for (let n = 0; n < MAX_PAGES; n += 1) {
      const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
      if (page) query.set("starting_after", page);
      const listed = await onAccount("GET", store.stripeAccountId, `/invoices?${query}`);
      if (!Array.isArray(listed.data)) throw new UnreadInvoiceError("a page of invoices that is not a list");
      if (typeof listed.has_more !== "boolean") throw new UnreadInvoiceError("whether there are more invoices");
      const rows = listed.data as (Invoice & { id?: unknown })[];
      invoices.push(...rows);
      if (!listed.has_more) {
        whole = true;
        break;
      }
      const last = rows[rows.length - 1];
      if (!last || typeof last.id !== "string") throw new UnreadInvoiceError("a page of invoices with no last invoice to go on from");
      page = last.id;
    }
    if (!whole) throw new UnreadInvoiceError(`more invoices than ${MAX_PAGES} pages`);
    const byId = new Map(subs.map((s) => [s.id, s]));
    numbers.movements = movementsFrom(subs, pricesFrom(invoices, byId), store.currency, Math.floor(now / 1000));
  } catch (error) {
    console.error("reading invoices for recurring revenue movements failed", store.handle, error);
  }
  if (isRedisConfigured()) {
    const text = JSON.stringify(numbers);
    const said = numbers.leaving?.recent?.length || numbers.leaving?.comments.length;
    if (store.listId && said && named.length) {
      // Kept only when nobody the words may name was deleted since they were looked up, in one step with the write;
      // otherwise, or when the step cannot run, nothing is kept and the words are not shown (Codex E2 on #2111).
      const gone = await keepUnlessErased(cacheKey(store), store.listId, text, CACHE_SECONDS, named).catch(async () => {
        await redisPipeline([["DEL", cacheKey(store)]]).catch(() => {});
        return null;
      });
      if (gone === null || gone.size) numbers = withoutMemberWords(numbers) as Numbers;
    } else {
      await redisPipeline([["SET", cacheKey(store), text, "EX", CACHE_SECONDS]]);
    }
  }
  return { numbers, named };
}
