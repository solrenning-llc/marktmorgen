/**
 * A member moving the day their own membership is charged (630 [HN6], item
 * 13; added 4 November 2026), as rules the browser can read too. Nothing
 * calls them yet: the preview, the page and the change itself are the next
 * units, beside lib/membership-manage.ts.
 *
 * Read before it was built, on docs.stripe.com, on 4 November 2026:
 *
 *   - /billing/subscriptions/billing-cycle ("Set the subscription billing
 *     renewal date"). An existing subscription's date changes in one of three
 *     ways: reset the anchor to the current time, reset it to a set
 *     timestamp, or add a free trial whose end becomes the anchor. The set
 *     timestamp is in private preview, needs API version 2026-09-30.preview
 *     and flexible billing mode, so it is not used: lib/stripe-connect.ts
 *     pins 2026-08-26.dahlia. A trial gives away the days until it ends, and
 *     with prorations it also credits back days already paid for, so it is
 *     not used either. In flexible mode a reset to now "doesn't
 *     automatically generate a new invoice"; `always_invoice` makes it.
 *   - /api/subscriptions/update. On update, `billing_cycle_anchor` takes
 *     only `now` (the current time, in UTC) or `unchanged`; there is no
 *     `billing_cycle_anchor_config` on update. `proration_date` makes the
 *     prorations "as though the subscription was updated at the given
 *     time", so the change can be charged exactly as previewed.
 *   - /api/invoices/create_preview. For an existing subscription the
 *     preview's anchor is `now` or `unchanged`; `proration_date` "must be
 *     within the current subscription period", needs `subscription` and
 *     `subscription_details.items`, and cannot go with `none`.
 *   - /billing/subscriptions/billing-mode. From 2025-09-30.clover on, a
 *     subscription made through the API is flexible by default; a credit
 *     there is worked out from what was actually paid, not from today's
 *     price. Older subscriptions may still be classic; the change below
 *     invoices at once in both modes.
 *
 * The design, so the creator never gives away a day they did not agree to
 * and the member never pays more than they were shown:
 *
 *   - The member picks a day from 1 to 28, so every month has it, never the
 *     day they pay on now. The change happens on the last such day before
 *     the payment already due (`moveOn`): the member's next payment is
 *     brought forward, never pushed back. A day later than the next payment
 *     is offered again once that payment has been taken.
 *   - On that day the anchor is reset to now, with `proration_date` at that
 *     day and `always_invoice` (`moveBody`). The member pays one full period
 *     from then, less a credit for the days already paid that they no
 *     longer use. No day is free and no day is paid twice. If the payment
 *     fails, Stripe is asked to refuse the change (`error_if_incomplete`, as
 *     lib/membership-pause.ts does on an early return), and nothing moves.
 *   - The amount shown before confirming is Stripe's own preview at that
 *     same second (`previewMoveBody`). It is kept with the request, and the
 *     change is made only while Stripe's amount on the day is not above it
 *     (`withinShown`).
 *   - The day is the member's own, in their time zone (UTC when it is not
 *     known), worked out for that very date. Stripe repeats the anchor's UTC
 *     day and time every month (a day past a month's end going to its last
 *     day), so the moment is chosen inside both that day where the member
 *     lives and the same day in UTC, an hour clear of either edge and of the
 *     run's grace (`moveInstant`): noon locally where that fits, otherwise
 *     the nearest such hour (New Zealand, Kiribati, Samoa). A day from 1 to
 *     28 then exists every month in UTC, and a daylight-saving change, which
 *     moves the local clock by an hour, never moves the payment to another
 *     day where the member lives.
 *   - At most once a billing period: once a month for a monthly membership,
 *     once a year for a yearly one, counted from the last request.
 *
 * Offered only on a membership running normally: monthly or yearly, until
 * canceled, active and paid up, not in a trial, not paused or set to pause,
 * not set to end, one item of one, no discount (a coupon for a few months
 * would land differently on the moved payment), not a payment plan, no
 * affiliate share for a set number of months still running (an extra
 * payment inside those months would add to the share), no schedule, no
 * pending update, charged automatically.
 *
 * Browser-safe.
 */
import { type PauseSub, addMonths, periodEndOf } from "@/lib/membership-pause-rules";
import { affiliateMonthsLeft, discounted } from "@/lib/yearly-switch-rules";

/** The days a member may choose: every month has them. */
export const FIRST_DAY = 1;
export const LAST_DAY = 28;

/** The change must be at least this far ahead, so the amount is seen and the change can run. */
export const MOVE_LEAD_SECONDS = 24 * 60 * 60;

/** How late the change may still run after its moment; later, it lapses and nothing moves. */
export const MOVE_GRACE_SECONDS = 2 * 60 * 60;

/** The local hour the new payment falls on where it fits: noon. */
export const MOVE_LOCAL_HOUR = 12;

/** Room kept from the edges of the day, for a daylight-saving change in a later month. */
const EDGE_MS = 60 * 60 * 1000;

/**
 * What the change keeps in the subscription's metadata, as decimal strings:
 * when the member asked (seconds), when the change runs (seconds; removed
 * once it ran or lapsed) and the amount Stripe's preview showed (in the
 * smallest unit of the currency, negative for a credit).
 */
export const META_AT = "billing_day_at";
export const META_ON = "billing_day_on";
export const META_SHOWN = "billing_day_shown";

/** The parts of a Stripe subscription these rules read. */
export type BillingDaySub = {
  status?: unknown;
  cancel_at?: unknown;
  cancel_at_period_end?: unknown;
  pause_collection?: unknown;
  discount?: unknown;
  discounts?: unknown;
  schedule?: unknown;
  pending_update?: unknown;
  collection_method?: unknown;
  current_period_end?: unknown;
  metadata?: Record<string, string> | null;
  items?: {
    data?: {
      quantity?: unknown;
      current_period_end?: unknown;
      price?: { recurring?: { interval?: unknown; interval_count?: unknown } | null } | null;
    }[];
  } | null;
};

export type MoveRefusal =
  | "interval"
  | "trial"
  | "behind"
  | "state"
  | "paused"
  | "ending"
  | "fixed"
  | "plan"
  | "items"
  | "discount"
  | "affiliate"
  | "managed"
  | "pending"
  | "recent";

const seconds = (value: unknown) =>
  typeof value === "string" && /^\d{9,11}$/.test(value) ? Number(value) : typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;

/** When the period already paid for ends, read as a pause reads it. */
const endOf = (sub: BillingDaySub) => periodEndOf(sub as PauseSub);

/** Months in one billing period: 1 or 12, or 0 for any other schedule. */
export function periodMonths(sub: BillingDaySub): 0 | 1 | 12 {
  const recurring = sub.items?.data?.[0]?.price?.recurring;
  if (!recurring || (recurring.interval_count ?? 1) !== 1) return 0;
  return recurring.interval === "month" ? 1 : recurring.interval === "year" ? 12 : 0;
}

/** When a change this membership is waiting for runs, in seconds; null when none waits. */
export function pendingMove(sub: BillingDaySub, nowSeconds: number): number | null {
  const on = seconds(sub.metadata?.[META_ON]);
  return on && nowSeconds < on + MOVE_GRACE_SECONDS ? on : null;
}

/** Whether the change waiting on this membership should run now: its moment has come, and not too long ago. */
export function moveDue(sub: BillingDaySub, nowSeconds: number): boolean {
  const on = pendingMove(sub, nowSeconds);
  return on !== null && nowSeconds >= on;
}

/** The checks that hold both when a member asks and when the change runs. */
function cannotHold(sub: BillingDaySub, nowSeconds: number): MoveRefusal | null {
  if (!periodMonths(sub)) return "interval";
  const status = String(sub.status ?? "");
  if (status === "trialing") return "trial";
  if (status === "past_due" || status === "unpaid") return "behind";
  if (status !== "active") return "state";
  const meta = sub.metadata ?? {};
  if ((sub.pause_collection && typeof sub.pause_collection === "object") || meta.pause_from) return "paused";
  if (sub.cancel_at_period_end === true || seconds(sub.cancel_at) > 0) return "ending";
  if (meta.ends_after) return "fixed";
  if (meta.kind === "plan") return "plan";
  const items = sub.items?.data ?? [];
  if (items.length !== 1 || (items[0].quantity ?? 1) !== 1) return "items";
  if (discounted(sub)) return "discount";
  if (affiliateMonthsLeft(meta, nowSeconds)) return "affiliate";
  if (sub.schedule || sub.pending_update || (sub.collection_method !== undefined && sub.collection_method !== "charge_automatically")) return "managed";
  if (!endOf(sub)) return "state";
  return null;
}

/** Why the member cannot ask to move this membership's day now, or null when they can. */
export function cannotMove(sub: BillingDaySub, nowSeconds: number): MoveRefusal | null {
  const held = cannotHold(sub, nowSeconds);
  if (held) return held;
  if (pendingMove(sub, nowSeconds) !== null) return "pending";
  const at = seconds(sub.metadata?.[META_AT]);
  if (at && nowSeconds < addMonths(at, periodMonths(sub))) return "recent";
  return null;
}

/**
 * Why the change waiting on this membership must not run now, or null when it
 * may. The membership must still be running normally, its moment due, and
 * still before the payment it brings forward, as Stripe's `proration_date`
 * needs.
 */
export function cannotRun(sub: BillingDaySub, nowSeconds: number): MoveRefusal | "due" | null {
  const held = cannotHold(sub, nowSeconds);
  if (held) return held;
  const on = pendingMove(sub, nowSeconds);
  if (on === null || nowSeconds < on || on >= endOf(sub)) return "due";
  return null;
}

/** A time zone the browser and the server both know, or UTC. */
export function zoneOf(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(raw)) return "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** The calendar date and hour an instant falls on in a time zone. */
export function localParts(atSeconds: number, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(atSeconds * 1000));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24 };
}

/** Minutes the time zone is ahead of UTC at that instant. */
function offsetMinutes(atMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(atMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60_000);
}

/**
 * Noon on a calendar date in a time zone, in seconds. `month` counts from 1
 * and may run past 12 or below 1. The offset is read for that date itself,
 * so a daylight-saving change is counted.
 */
export function localNoon(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, MOVE_LOCAL_HOUR);
  const first = guess - offsetMinutes(guess, timeZone) * 60_000;
  const second = guess - offsetMinutes(first, timeZone) * 60_000;
  return Math.floor(second / 1000);
}

/**
 * The moment a change to that calendar date runs, in seconds: inside the date
 * both where the member lives and in UTC, an hour clear of the edges, with the
 * run's grace still inside; noon locally when that fits, else the nearest
 * moment that does. `month` counts from 1 and may run past 12 or below 1.
 */
export function moveInstant(year: number, month: number, day: number, timeZone: string): number {
  const noonMs = localNoon(year, month, day, timeZone) * 1000;
  const utcStart = Date.UTC(year, month - 1, day);
  const localStart = utcStart - offsetMinutes(noonMs, timeZone) * 60_000;
  const from = Math.max(utcStart, localStart) + EDGE_MS;
  const to = Math.min(utcStart, localStart) + 24 * EDGE_MS - EDGE_MS - MOVE_GRACE_SECONDS * 1000;
  return Math.floor(Math.min(Math.max(noonMs, from), to) / 1000);
}

/** The day of the month the member pays on now, where they live. */
export function currentDay(sub: BillingDaySub, timeZone: string): number {
  const end = endOf(sub);
  return end ? localParts(end, timeZone).day : 0;
}

/**
 * When moving to `day` would happen, in seconds (`moveInstant`): on the last
 * such date, where the member lives, at least a day from now and before the
 * payment already due. Null when that day is not offered now.
 */
export function moveOn(sub: BillingDaySub, day: number, timeZone: string, nowSeconds: number): number | null {
  if (!Number.isInteger(day) || day < FIRST_DAY || day > LAST_DAY) return null;
  const end = endOf(sub);
  if (!end || day === currentDay(sub, timeZone)) return null;
  const due = localParts(end, timeZone);
  let on = moveInstant(due.year, due.month, day, timeZone);
  if (on >= end) on = moveInstant(due.year, due.month - 1, day, timeZone);
  if (on >= end || on < nowSeconds + MOVE_LEAD_SECONDS) return null;
  return on;
}

/** The days the member may choose now, each with when the change would happen. */
export function daysOffered(sub: BillingDaySub, timeZone: string, nowSeconds: number): { day: number; on: number }[] {
  if (cannotMove(sub, nowSeconds)) return [];
  const out: { day: number; on: number }[] = [];
  for (let day = FIRST_DAY; day <= LAST_DAY; day += 1) {
    const on = moveOn(sub, day, timeZone, nowSeconds);
    if (on !== null) out.push({ day, on });
  }
  return out;
}

/**
 * The payments after the moved one, in seconds, as Stripe counts them: whole
 * months from the new anchor in UTC, a day past a month's end going to its
 * last day. The change runs a few seconds after `on`; Stripe anchors there.
 */
export function paymentsAfter(on: number, months: number, count: number): number[] {
  const out: number[] = [];
  for (let k = 1; k <= count; k += 1) out.push(addMonths(on, k * months));
  return out;
}

/** Whether Stripe's amount on the day may be charged: never above what the member was shown. */
export function withinShown(shown: number, due: number): boolean {
  return Number.isInteger(shown) && Number.isInteger(due) && due <= shown;
}

/** The metadata the request writes, beside the request itself. */
export function requestMeta(on: number, shown: number, nowSeconds: number): Record<string, string> {
  return { [META_AT]: String(nowSeconds), [META_ON]: String(on), [META_SHOWN]: String(Math.trunc(shown)) };
}

/** The amount the member was shown, kept with the request; null when none was kept. */
export function shownOf(sub: BillingDaySub): number | null {
  const raw = sub.metadata?.[META_SHOWN];
  return typeof raw === "string" && /^-?\d{1,12}$/.test(raw) ? Number(raw) : null;
}

/**
 * Stripe's preview of the change, worked out at the second `on`. The anchor
 * resets at the moment of the preview, so the new period's line starts then:
 * read it with `dueNow(invoice, previewSecond)` (lib/tier-rules.ts). The item
 * is named, unchanged, because a preview with `proration_date` needs one.
 */
export function previewMoveBody(customer: string, subscription: string, itemId: string, price: string, on: number): URLSearchParams {
  return new URLSearchParams({
    customer,
    subscription,
    "subscription_details[items][0][id]": itemId,
    "subscription_details[items][0][price]": price,
    "subscription_details[billing_cycle_anchor][type]": "now",
    "subscription_details[proration_behavior]": "always_invoice",
    "subscription_details[proration_date]": String(on),
  });
}

/** The change itself, on the day: charged at once at the previewed second, and made only if it is paid. */
export function moveBody(on: number): URLSearchParams {
  const body = new URLSearchParams({
    "billing_cycle_anchor[type]": "now",
    proration_behavior: "always_invoice",
    proration_date: String(on),
    payment_behavior: "error_if_incomplete",
    [`metadata[${META_ON}]`]: "",
    [`metadata[${META_SHOWN}]`]: "",
  });
  body.append("expand[]", "latest_invoice");
  return body;
}

const ORDINAL = new Intl.PluralRules("en-US", { type: "ordinal" });
const SUFFIX: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" };

/** 1st, 2nd, 3rd, 4th, ... 28th. */
export function ordinal(n: number): string {
  return `${n}${SUFFIX[ORDINAL.select(n)] ?? "th"}`;
}

/** A date as the member reads it, in their time zone: "Friday, November 20, 2026". */
export function dateWords(atSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zoneOf(timeZone), dateStyle: "full" }).format(new Date(atSeconds * 1000));
}

/**
 * What the change will do, in plain US English, for the page to show before
 * the member confirms. `amount` is Stripe's preview, already written as money
 * ("$12.40"); a credit is written by the caller as such.
 */
export function moveWords(input: { from: number; on: number; months: 1 | 12; amount: string; timeZone: string }): string[] {
  const zone = zoneOf(input.timeZone);
  const from = dateWords(input.from, zone);
  const on = dateWords(input.on, zone);
  const local = localParts(input.on, zone);
  const span = input.months === 1 ? "month" : "year";
  const month = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "long" }).format(new Date(input.on * 1000));
  return [
    `Your next payment moves from ${from} to ${on}.`,
    `On ${on}, you pay ${input.amount}.`,
    `That is one full ${span}, less the days you already paid for.`,
    "Stripe worked out this amount. You will never pay more than it.",
    input.months === 1
      ? `After that, you pay on the ${ordinal(local.day)} of each month.`
      : `After that, you pay every year on ${month} ${ordinal(local.day)}.`,
    "If that payment fails, nothing changes.",
    `You can change the day once a ${span}.`,
  ];
}
