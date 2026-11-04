/**
 * A member moving the day their own membership is charged (630 [HN6], item
 * 13; added 4 November 2026), as rules the browser can read too. Nothing
 * calls them yet: the preview, the page and the change itself are the next
 * units, beside lib/membership-manage.ts.
 *
 * Read before it was built, on docs.stripe.com, on 4 November 2026 (and read
 * again that day for the review's findings):
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
 *     automatically generate a new invoice"; `always_invoice` makes it. The
 *     same page also says that with `billing_mode[type]=flexible` "the
 *     billing cycle anchor remains unchanged" in the scenarios it lists; how
 *     that reads beside the reset to now is checked on a test clock below.
 *   - /api/subscriptions/update. On update, `billing_cycle_anchor` takes
 *     only `now` (the current time, in UTC) or `unchanged`. `proration_date`
 *     makes the prorations "as though the subscription was updated at the
 *     given time". With `payment_behavior=error_if_incomplete`, "if payment
 *     fails, return an HTTP 402 status code and don't update the
 *     subscription", and a payment that needs the member (3D Secure) is an
 *     error too; "the subscription update does not go into effect", so
 *     metadata sent in that same request is not written either.
 *     `off_session` "indicates if a customer is on or off-session while an
 *     invoice payment is attempted. Defaults to false".
 *   - /api/invoices/create_preview. A preview "will show you all the charges
 *     that are pending, including subscription renewal charges, invoice item
 *     charges", and the customer's balance lands on it as
 *     `starting_balance`; "exchange rates may vary between the time of the
 *     preview and the time of the actual invoice creation". For an existing
 *     subscription the preview's anchor is `now` or `unchanged`;
 *     `proration_date` "must be within the current subscription period",
 *     needs `subscription` and `subscription_details.items`, and cannot go
 *     with `none`. For an item kept as it is: "If you're updating an
 *     existing item without changing its price, omit both" `price` and
 *     `price_data`, so only its `id` is sent.
 *   - /billing/customer/balance. The balance "automatically applies to the
 *     next invoice finalized for the customer"; "a debit invoice balance
 *     applies the full balance to the invoice".
 *   - /billing/subscriptions/billing-mode. From 2025-09-30.clover on, a
 *     subscription made through the API is flexible by default; a credit
 *     there is worked out from what was actually paid, not from today's
 *     price. Older subscriptions may still be classic. The subscription
 *     says which in `billing_mode.type`; one that does not say is refused.
 *
 * The design, so the creator never gives away a day they did not agree to
 * and the member is never charged more than one full period:
 *
 *   - The member picks a day from 1 to 28, so every month has it, never the
 *     day they pay on now. The change happens on the last such day before
 *     the payment already due (`moveOn`): the member's next payment is
 *     brought forward, never pushed back. A day later than the next payment
 *     is offered again once that payment has been taken. The server works
 *     `on` out again with `moveOn` from the day the member chose and never
 *     trusts a moment sent by the browser.
 *   - The change runs at some instant from `on` to `on + MOVE_GRACE_SECONDS`
 *     (whenever the caller's run reaches it), and lapses after that. The
 *     anchor is reset to that real instant (`now`), with `proration_date`
 *     at `on`, `always_invoice` and `off_session` (`moveBody`). The member
 *     pays one full period from then, less a credit for the days already
 *     paid that they no longer use. If the payment fails, Stripe refuses the
 *     change (`error_if_incomplete`, as lib/membership-pause.ts does on an
 *     early return), and the payment day stays as it was.
 *   - The preview made when the member asks gives two amounts, both kept
 *     with the request (`requestMeta`): what it charges today
 *     (`previewAmount`, its whole `amount_due`, tax added on top included),
 *     shown to the member as today's figure, and the ceiling
 *     (`previewCeiling`): the full new period with its tax, the sum of the
 *     preview's lines that are not prorations. A preview that carries
 *     anything else (a pending invoice item, a balance owed or held), whose
 *     tax cannot be read, or whose `amount_due` is above its ceiling, is
 *     refused (`previewRefusal`).
 *   - In flexible billing mode the credit depends on what was actually paid,
 *     so the fresh preview at the moment of the change may differ from the
 *     first one. The bound kept is therefore the ceiling, never more than a
 *     full period: the change is made only through `mayRun`, the only door
 *     to `moveBody`. It refuses when the membership no longer runs
 *     normally, the moment is not due, the period changed since the request
 *     (`cannotRun`), the fresh preview fails the same checks, or its
 *     `amount_due` is above the ceiling kept (`runPreviewRefusal`). The
 *     request carries `moveIdempotencyKey`, so a retry never charges twice.
 *   - The request lives in the metadata of a subscription on the creator's
 *     Standard account, which the creator can edit. So it is signed: the
 *     server signs `requestSigText` (`billing-day:v1|{sub.id}|{customer}|
 *     {at}|{on}|{shown}|{ceiling}|{end}|{months}`) with HMAC-SHA256 under
 *     its own key derived for this alone (`deriveKey("billing-day-request")`
 *     in lib/secret-box.ts, never another feature's key), keeps it as
 *     `META_SIG`, and checks it with `timingSafeEqual`. The rules stay
 *     browser-safe: `requestMeta` takes the signer and every reader takes a
 *     verifier (`RequestVerifier`), and a request whose signature is
 *     missing or wrong is read as no request at all. The subscription and
 *     customer ids in the text keep a request copied from another
 *     membership from being read.
 *   - After a 402 Stripe leaves the subscription as it was, but the
 *     proration invoice it made may stay open, and an open last invoice
 *     refuses every later request ("invoice"). So the route that runs the
 *     change must: remember `latest_invoice`'s id before the update; on a
 *     402, read the subscription again with `latest_invoice` expanded;
 *     void the invoice `openMoveInvoice` names (as lib/yearly-switch.ts
 *     voids a declined move to yearly) before clearing the request
 *     (`clearMoveBody`); and if it cannot be voided, leave it, so the
 *     "invoice" refusal keeps holding.
 *   - Not verified yet, and needed before the unit that calls Stripe: on a
 *     test clock, in both classic and flexible billing modes, how far the
 *     preview made a day ahead, the fresh one at the moment and the invoice
 *     the change makes differ, that the anchor really moves in flexible
 *     mode, and whether a 402 leaves an open invoice. The ceiling keeps the
 *     member safe if they differ; it does not show by how much.
 *   - The day is the member's own, in their time zone (UTC when it is not
 *     known), worked out for that very date. Stripe repeats the anchor's UTC
 *     day and time every month (a day past a month's end going to its last
 *     day), so the moment is chosen inside both that day where the member
 *     lives and the same day in UTC, an hour clear of either edge for the
 *     whole run window up to `on + MOVE_GRACE_SECONDS` (`moveInstant`):
 *     noon locally where that fits, otherwise the nearest such hour (New
 *     Zealand, Kiribati, Samoa). A day from 1 to 28 then exists every month
 *     in UTC, and a daylight-saving change, which moves the local clock by
 *     an hour, never moves the payment to another day where the member
 *     lives, wherever in that window the change really ran.
 *   - At most once a billing period: once a month for a monthly membership,
 *     once a year for a yearly one, counted from the last change that was
 *     made (`META_DONE`, written by the change itself). A request that was
 *     declined or lapsed does not count.
 *
 * Offered only on a membership running normally: monthly or yearly, until
 * canceled, active and paid up, its billing mode known, its last invoice
 * paid, not in a trial, not paused or set to pause, not set to end, one item
 * of one, no discount on the subscription, its item or the customer (a
 * coupon for a few months would land differently on the moved payment), not
 * a payment plan, no affiliate share for a set number of months still
 * running (an extra payment inside those months would add to the share), no
 * schedule, no pending update, charged automatically to a card (a bank debit
 * settles days later, after the change would be made), and no balance on
 * the customer. The subscription is read with `MOVE_EXPAND`; anything not
 * read is refused.
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

/**
 * The run window: the change runs at some instant from `on` to
 * `on + MOVE_GRACE_SECONDS`, whenever the caller's run reaches it, and
 * Stripe anchors at that real instant. Later, it lapses and nothing moves.
 * `moveInstant` keeps the whole window inside the chosen day, locally and in
 * UTC.
 */
export const MOVE_GRACE_SECONDS = 2 * 60 * 60;

/** The local hour the new payment falls on where it fits: noon. */
export const MOVE_LOCAL_HOUR = 12;

/** Room kept from the edges of the day, for a daylight-saving change in a later month. */
const EDGE_MS = 60 * 60 * 1000;

/**
 * What the change keeps in the subscription's metadata, as decimal strings.
 * The request: when the member asked (seconds), when the change runs
 * (seconds), the amount Stripe's preview showed (`amount_due`, in the
 * smallest unit of the currency, never below zero), the ceiling (the full
 * new period with its tax, same unit), the period it was priced on (its end
 * in seconds, and its months), and the server's signature over all of it
 * (`META_SIG`, hex). The request is removed once the change ran, was
 * declined or lapsed. `META_DONE` is when the last change was made
 * (seconds), written only by the change that succeeded.
 */
export const META_AT = "billing_day_at";
export const META_ON = "billing_day_on";
export const META_SHOWN = "billing_day_shown";
export const META_CEILING = "billing_day_ceiling";
export const META_END = "billing_day_end";
export const META_MONTHS = "billing_day_months";
export const META_SIG = "billing_day_sig";
export const META_DONE = "billing_day_done";

/** What a request writes and the end of a request clears. */
const REQUEST_KEYS = [META_AT, META_ON, META_SHOWN, META_CEILING, META_END, META_MONTHS, META_SIG] as const;

/**
 * What the caller expands when it reads the subscription for these rules, so
 * the last invoice, the customer's balance and discount, and the payment
 * method are known. Anything not expanded is refused.
 */
export const MOVE_EXPAND = ["latest_invoice", "customer", "default_payment_method", "customer.invoice_settings.default_payment_method"] as const;

/** The parts of a Stripe subscription these rules read. */
export type BillingDaySub = {
  id?: unknown;
  status?: unknown;
  billing_mode?: { type?: unknown } | null;
  cancel_at?: unknown;
  cancel_at_period_end?: unknown;
  pause_collection?: unknown;
  discount?: unknown;
  discounts?: unknown;
  schedule?: unknown;
  pending_update?: unknown;
  collection_method?: unknown;
  current_period_start?: unknown;
  current_period_end?: unknown;
  latest_invoice?: unknown;
  default_payment_method?: unknown;
  default_source?: unknown;
  customer?: unknown;
  metadata?: Record<string, string> | null;
  items?: {
    data?: {
      quantity?: unknown;
      discounts?: unknown;
      current_period_start?: unknown;
      current_period_end?: unknown;
      price?: { recurring?: { interval?: unknown; interval_count?: unknown } | null } | null;
    }[];
  } | null;
};

/**
 * Whether the request kept on this subscription carries the server's own
 * signature over `requestSigText(sub, sub.metadata)`. On the server:
 * HMAC-SHA256 under `deriveKey("billing-day-request")`, compared with
 * `timingSafeEqual`; false when the text is null or the key is missing.
 */
export type RequestVerifier = (sub: BillingDaySub) => boolean;

/** The server's signer: HMAC-SHA256 of the text, as hex, or null when it cannot sign. */
export type RequestSigner = (text: string) => string | null;

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
  | "invoice"
  | "balance"
  | "card"
  | "pending"
  | "recent"
  | "changed";

/** Why a preview of the change cannot be shown or charged as it is. */
export type PreviewRefusal = "amount" | "balance" | "extra";

const seconds = (value: unknown) =>
  typeof value === "string" && /^\d{9,11}$/.test(value) ? Number(value) : typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;

/** When the period already paid for ends, read as a pause reads it. */
const endOf = (sub: BillingDaySub) => periodEndOf(sub as PauseSub);

/** When the period already paid for started; 0 when not known. */
function startOf(sub: BillingDaySub): number {
  const fromItem = sub.items?.data?.[0]?.current_period_start;
  if (typeof fromItem === "number") return fromItem;
  return typeof sub.current_period_start === "number" ? sub.current_period_start : 0;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const nonEmpty = (value: unknown) => (Array.isArray(value) && value.length > 0) || (record(value) !== null);

/** A Stripe id as these rules accept one: letters, digits and underscores only. */
const stripeId = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z0-9_]{1,255}$/.test(value) ? value : null);

/** The customer's id, whether the customer was expanded or not. */
const customerIdOf = (sub: BillingDaySub): string | null => stripeId(typeof sub.customer === "string" ? sub.customer : record(sub.customer)?.id);

/**
 * Whether the payment method Stripe would charge is a card, which is paid or
 * declined at once. The subscription's own default comes first, then an old
 * source, then the customer's default, as Stripe chooses. A method that was
 * not expanded, a source and anything else are not.
 */
function chargesCard(sub: BillingDaySub, customer: Record<string, unknown>): boolean {
  const own = sub.default_payment_method;
  if (own) return record(own)?.type === "card";
  if (sub.default_source) return false;
  const settings = record(customer.invoice_settings);
  const theirs = settings?.default_payment_method;
  if (theirs) return record(theirs)?.type === "card";
  return false;
}

/** Months in one billing period: 1 or 12, or 0 for any other schedule. */
export function periodMonths(sub: BillingDaySub): 0 | 1 | 12 {
  const recurring = sub.items?.data?.[0]?.price?.recurring;
  if (!recurring || (recurring.interval_count ?? 1) !== 1) return 0;
  return recurring.interval === "month" ? 1 : recurring.interval === "year" ? 12 : 0;
}

/**
 * The exact text the server signs for a request, or null when any part is
 * not as these rules write it (so nothing is signed or read):
 * `billing-day:v1|{sub.id}|{customer}|{at}|{on}|{shown}|{ceiling}|{end}|{months}`.
 */
export function requestSigText(sub: BillingDaySub, meta: Record<string, string>): string | null {
  const id = stripeId(sub.id);
  const customer = customerIdOf(sub);
  if (!id || !customer) return null;
  const parts = [meta[META_AT], meta[META_ON], meta[META_SHOWN], meta[META_CEILING], meta[META_END], meta[META_MONTHS]];
  if (!parts.every((part) => typeof part === "string" && /^\d{1,12}$/.test(part))) return null;
  return ["billing-day:v1", id, customer, ...parts].join("|");
}

/** The request kept on this subscription, only when the server's signature over it holds. */
function signedMeta(sub: BillingDaySub, verify: RequestVerifier): Record<string, string> | null {
  const meta = sub.metadata;
  if (!meta || typeof meta[META_SIG] !== "string" || !meta[META_SIG]) return null;
  if (requestSigText(sub, meta) === null) return null;
  return verify(sub) ? meta : null;
}

/** When a signed change this membership is waiting for runs, in seconds; null when none waits. */
export function pendingMove(sub: BillingDaySub, nowSeconds: number, verify: RequestVerifier): number | null {
  const meta = signedMeta(sub, verify);
  const on = seconds(meta?.[META_ON]);
  return on && nowSeconds < on + MOVE_GRACE_SECONDS ? on : null;
}

/** Whether the change waiting on this membership should run now: its moment has come, and not too long ago. */
export function moveDue(sub: BillingDaySub, nowSeconds: number, verify: RequestVerifier): boolean {
  const on = pendingMove(sub, nowSeconds, verify);
  return on !== null && nowSeconds >= on;
}

/**
 * Whether the billing mode is read and the period is known where that mode
 * keeps it: on the item in flexible mode; on the item or, failing that, the
 * subscription in classic mode.
 */
function periodKnown(sub: BillingDaySub): boolean {
  const mode = record(sub.billing_mode)?.type;
  const item = sub.items?.data?.[0];
  if (mode === "flexible") return typeof item?.current_period_end === "number" && typeof item?.current_period_start === "number" && endOf(sub) > 0;
  if (mode === "classic") return endOf(sub) > 0;
  return false;
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
  const customer = record(sub.customer);
  if (customer?.deleted === true) return "state";
  if (discounted(sub) || nonEmpty(items[0].discounts) || nonEmpty(customer?.discount)) return "discount";
  if (affiliateMonthsLeft(meta, nowSeconds)) return "affiliate";
  if (sub.schedule || sub.pending_update || (sub.collection_method !== undefined && sub.collection_method !== "charge_automatically")) return "managed";
  if (record(sub.latest_invoice)?.status !== "paid") return "invoice";
  if (!customer || customer.balance !== 0) return "balance";
  if (!chargesCard(sub, customer)) return "card";
  if (!periodKnown(sub)) return "state";
  return null;
}

/** Why the member cannot ask to move this membership's day now, or null when they can. */
export function cannotMove(sub: BillingDaySub, nowSeconds: number, verify: RequestVerifier): MoveRefusal | null {
  const held = cannotHold(sub, nowSeconds);
  if (held) return held;
  if (pendingMove(sub, nowSeconds, verify) !== null) return "pending";
  const done = seconds(sub.metadata?.[META_DONE]);
  if (done && nowSeconds < addMonths(done, periodMonths(sub))) return "recent";
  return null;
}

/**
 * Why the change waiting on this membership must not run now, or null when it
 * may. The membership must still be running normally, its signed request
 * due, inside the period it was priced on (the same end and the same months
 * as kept with the request, its moment not before that period started), and
 * still before the payment it brings forward, as Stripe's `proration_date`
 * needs. The fresh preview is checked after this, in `mayRun`.
 */
export function cannotRun(sub: BillingDaySub, nowSeconds: number, verify: RequestVerifier): MoveRefusal | "due" | null {
  const held = cannotHold(sub, nowSeconds);
  if (held) return held;
  const on = pendingMove(sub, nowSeconds, verify);
  if (on === null || nowSeconds < on) return "due";
  const end = endOf(sub);
  const meta = sub.metadata ?? {};
  const start = startOf(sub);
  if (seconds(meta[META_END]) !== end || meta[META_MONTHS] !== String(periodMonths(sub)) || !start || on < start) return "changed";
  if (on >= end) return "due";
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

/** One formatter per time zone, made once: making one is far slower than using it. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = FORMATTERS.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    if (FORMATTERS.size > 600) FORMATTERS.clear();
    FORMATTERS.set(timeZone, found);
  }
  return found;
}

/** The calendar date and hour an instant falls on in a time zone. */
export function localParts(atSeconds: number, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const parts = formatter(timeZone).formatToParts(new Date(atSeconds * 1000));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24 };
}

/** Minutes the time zone is ahead of UTC at that instant. */
function offsetMinutes(atMs: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(atMs));
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
export function daysOffered(sub: BillingDaySub, timeZone: string, nowSeconds: number, verify: RequestVerifier): { day: number; on: number }[] {
  if (cannotMove(sub, nowSeconds, verify)) return [];
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
 * last day. Stripe anchors at the instant the change really ran, anywhere
 * from `on` to `on + MOVE_GRACE_SECONDS`, so `anchor` is that instant once
 * known. Before the change runs, `on` gives the same days: `moveInstant`
 * keeps the whole run window inside the chosen day.
 */
export function paymentsAfter(anchor: number, months: number, count: number): number[] {
  const out: number[] = [];
  for (let k = 1; k <= count; k += 1) out.push(addMonths(anchor, k * months));
  return out;
}

/** Whether Stripe's amount on the day may be charged: a whole amount, never below zero, never above the ceiling kept. */
export function withinCeiling(ceiling: number, due: number): boolean {
  return Number.isInteger(ceiling) && Number.isInteger(due) && due >= 0 && due <= ceiling;
}

const AMOUNT_MAX = 999_999_999_999;
const wholeAmount = (value: number) => Number.isInteger(value) && value >= 0 && value <= AMOUNT_MAX;

/**
 * The metadata the request writes: when asked, when it runs, the amount
 * shown, the ceiling, the period it was priced on, and the server's
 * signature (`sign(requestSigText(...))`). Null when an amount is not a
 * whole number from zero up, the amount shown is above the ceiling, the
 * period or the ids are not known, or the signer cannot sign.
 */
export function requestMeta(sub: BillingDaySub, on: number, shown: number, ceiling: number, nowSeconds: number, sign: RequestSigner): Record<string, string> | null {
  const end = endOf(sub);
  const months = periodMonths(sub);
  if (!wholeAmount(shown) || !wholeAmount(ceiling) || shown > ceiling || !end || !months) return null;
  const meta: Record<string, string> = {
    [META_AT]: String(nowSeconds),
    [META_ON]: String(on),
    [META_SHOWN]: String(shown),
    [META_CEILING]: String(ceiling),
    [META_END]: String(end),
    [META_MONTHS]: String(months),
  };
  const text = requestSigText(sub, meta);
  const sig = text === null ? null : sign(text);
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return null;
  meta[META_SIG] = sig;
  return meta;
}

const keptAmount = (sub: BillingDaySub, key: string, verify: RequestVerifier): number | null => {
  const raw = signedMeta(sub, verify)?.[key];
  return typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : null;
};

/** The amount the member was shown, kept with a signed request; null when none was kept. */
export function shownOf(sub: BillingDaySub, verify: RequestVerifier): number | null {
  return keptAmount(sub, META_SHOWN, verify);
}

/** The ceiling kept with a signed request (the full new period with its tax); null when none was kept. */
export function ceilingOf(sub: BillingDaySub, verify: RequestVerifier): number | null {
  return keptAmount(sub, META_CEILING, verify);
}

type PreviewTax = { amount?: unknown; tax_behavior?: unknown };

/** The parts of a preview invoice these rules read. */
export type MovePreview = {
  amount_due?: unknown;
  starting_balance?: unknown;
  lines?: {
    has_more?: unknown;
    data?: {
      amount?: unknown;
      type?: unknown;
      proration?: unknown;
      discount_amounts?: { amount?: unknown }[] | null;
      taxes?: PreviewTax[] | null;
      tax_amounts?: unknown;
      parent?: { type?: unknown; subscription_item_details?: unknown; invoice_item_details?: unknown } | null;
    }[] | null;
  } | null;
};

/**
 * The ceiling: the full new period with its tax, the sum of the preview's
 * lines that are not prorations (each line's amount, less its discounts,
 * plus the tax added on top of it; a tax included in the price is already in
 * the amount). Null when it cannot be read exactly: no such line, a line
 * whose proration flag is not a yes or no, an amount that is not whole, a
 * tax whose behavior is neither, or the older `tax_amounts` form.
 */
export function previewCeiling(invoice: MovePreview): number | null {
  const lines = invoice.lines?.data;
  if (!Array.isArray(lines)) return null;
  let sum = 0;
  let periods = 0;
  for (const line of lines) {
    const proration = record(line.parent?.subscription_item_details)?.proration;
    if (typeof proration !== "boolean") return null;
    if (proration) continue;
    if (nonEmpty(line.tax_amounts)) return null;
    if (typeof line.amount !== "number" || !Number.isInteger(line.amount)) return null;
    sum += line.amount;
    for (const d of line.discount_amounts ?? []) {
      if (typeof d?.amount !== "number" || !Number.isInteger(d.amount)) return null;
      sum -= d.amount;
    }
    for (const t of line.taxes ?? []) {
      if (typeof t?.amount !== "number" || !Number.isInteger(t.amount)) return null;
      if (t.tax_behavior === "exclusive") sum += t.amount;
      else if (t.tax_behavior !== "inclusive") return null;
    }
    periods += 1;
  }
  return periods > 0 && wholeAmount(sum) ? sum : null;
}

/**
 * Why a preview of the change cannot be shown as what will be charged, or
 * null when it can. Every line must come from the subscription's own item
 * (its proration credit and its new period); a pending invoice item, or a
 * line from anywhere else, is "extra". A balance owed or held lands on the
 * invoice, so anything but a starting balance of exactly zero is "balance".
 * `amount_due` must be a whole number from zero up, and its ceiling
 * (`previewCeiling`) readable and not below it ("amount").
 */
export function previewRefusal(invoice: MovePreview): PreviewRefusal | null {
  const lines = invoice.lines?.data;
  if (!Array.isArray(lines) || lines.length === 0 || invoice.lines?.has_more === true) return "extra";
  for (const line of lines) {
    const parent = line.parent;
    if (!parent || (parent.type !== undefined && parent.type !== "subscription_item_details") || !record(parent.subscription_item_details)) return "extra";
  }
  if (invoice.starting_balance !== 0) return "balance";
  const due = invoice.amount_due;
  if (typeof due !== "number" || !Number.isInteger(due) || due < 0) return "amount";
  const ceiling = previewCeiling(invoice);
  if (ceiling === null || !withinCeiling(ceiling, due)) return "amount";
  return null;
}

/** The amount to show: the preview's whole `amount_due`, or null when the preview is refused. */
export function previewAmount(invoice: MovePreview): number | null {
  return previewRefusal(invoice) ? null : (invoice.amount_due as number);
}

/**
 * Why the fresh preview made at the moment of the change stops it, or null
 * when the change may be made: the same checks as the first preview, and
 * its `amount_due` not above the ceiling kept with the signed request (the
 * full new period with its tax). It may be above the amount first shown:
 * in flexible mode the credit is worked out from what was actually paid.
 */
export function runPreviewRefusal(sub: BillingDaySub, fresh: MovePreview, verify: RequestVerifier): PreviewRefusal | "above" | null {
  const refused = previewRefusal(fresh);
  if (refused) return refused;
  const ceiling = ceilingOf(sub, verify);
  return ceiling !== null && withinCeiling(ceiling, fresh.amount_due as number) ? null : "above";
}

/**
 * The only door to `moveBody`: why the change waiting on this membership
 * must not be made now, or null when it may. Both `cannotRun` (the
 * membership, the moment, the period) and `runPreviewRefusal` (the fresh
 * preview, against the ceiling) must pass, with the same verifier. The
 * caller makes the fresh preview with `previewMoveBody` just before.
 */
export function mayRun(sub: BillingDaySub, fresh: MovePreview, nowSeconds: number, verify: RequestVerifier): MoveRefusal | PreviewRefusal | "due" | "above" | null {
  return cannotRun(sub, nowSeconds, verify) ?? runPreviewRefusal(sub, fresh, verify);
}

/**
 * The invoice to void after the change was declined (402), or null: the last
 * invoice read after the decline, when it is open and is not the one that
 * was last before the update. Stripe changed nothing else, but an open
 * invoice left there would refuse every later request ("invoice").
 */
export function openMoveInvoice(before: { id?: unknown } | null, after: { id?: unknown; status?: unknown } | null): string | null {
  const id = stripeId(after?.id);
  if (!id || after?.status !== "open") return null;
  return id === stripeId(before?.id) ? null : id;
}

/**
 * Stripe's preview of the change, worked out at the second `on`; made when
 * the member asks, and again at the moment of the change. The item is named
 * by its id alone, kept as it is, because a preview with `proration_date`
 * needs one.
 */
export function previewMoveBody(customer: string, subscription: string, itemId: string, on: number): URLSearchParams {
  return new URLSearchParams({
    customer,
    subscription,
    "subscription_details[items][0][id]": itemId,
    "subscription_details[billing_cycle_anchor][type]": "now",
    "subscription_details[proration_behavior]": "always_invoice",
    "subscription_details[proration_date]": String(on),
  });
}

/**
 * The change itself, made only after `mayRun` passed: charged at once with
 * prorations at the previewed second, the anchor at the real instant, with
 * nobody present, and made only if it is paid. The request is cleared and
 * the change marked done in the same update, so both are written only when
 * Stripe makes it.
 */
export function moveBody(on: number): URLSearchParams {
  const body = new URLSearchParams({
    "billing_cycle_anchor[type]": "now",
    proration_behavior: "always_invoice",
    proration_date: String(on),
    payment_behavior: "error_if_incomplete",
    off_session: "true",
  });
  for (const key of REQUEST_KEYS) body.set(`metadata[${key}]`, "");
  body.set(`metadata[${META_DONE}]`, String(on));
  body.append("expand[]", "latest_invoice");
  return body;
}

/**
 * The update that clears a request after its change was declined (402, once
 * an open invoice it left was voided: `openMoveInvoice`), was refused at run
 * time or lapsed. Metadata only: the payment day and every past change stay
 * as they were, so the member may ask again at once.
 */
export function clearMoveBody(): URLSearchParams {
  const body = new URLSearchParams();
  for (const key of REQUEST_KEYS) body.set(`metadata[${key}]`, "");
  return body;
}

/** The idempotency key of the change, so a retry of the same moment never charges twice. */
export function moveIdempotencyKey(subscription: string, on: number): string {
  return `billing-day:${subscription}:${on}`;
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
 * the member confirms. `amount` is the preview's `amount_due`
 * (`previewAmount`) and `ceiling` its full new period (`previewCeiling`),
 * both already written as money ("$12.40"). Each sentence says only what
 * the code holds: the amount on the day may differ from today's, never
 * above the ceiling (`mayRun`), and a failed or refused payment leaves the
 * day as it was.
 */
export function moveWords(input: { from: number; on: number; months: 1 | 12; amount: string; ceiling: string; timeZone: string }): string[] {
  const zone = zoneOf(input.timeZone);
  const from = dateWords(input.from, zone);
  const on = dateWords(input.on, zone);
  const local = localParts(input.on, zone);
  const span = input.months === 1 ? "month" : "year";
  const month = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "long" }).format(new Date(input.on * 1000));
  return [
    `Your next payment moves from ${from}, to ${on}.`,
    `On ${on}, you pay one full ${span}, less the days you already paid for.`,
    `Today, Stripe works that out as ${input.amount}.`,
    `It is never more than one full ${span}, ${input.ceiling}. If it would be, nothing changes.`,
    input.months === 1
      ? `After that, you pay on the ${ordinal(local.day)} of each month.`
      : `After that, you pay every year on ${month} ${local.day}.`,
    "If that payment fails, your payment day stays the same.",
    `You can change the day once a ${span}.`,
  ];
}
