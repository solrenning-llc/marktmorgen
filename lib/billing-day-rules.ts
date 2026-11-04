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
 *     The same page says that with flexible mode "the billing cycle anchor
 *     remains unchanged" in the cases it lists, so until a test clock shows
 *     the anchor really moves on a reset to now, a flexible subscription is
 *     refused (`FLEXIBLE_MOVE_PROVEN`, false).
 *
 * The design, so the creator gives away at most the run window (two hours,
 * below) and the member is never charged more than one full period:
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
 *     pays one full period from then, less a credit for the paid days they
 *     will no longer use. The credit is worked out from `on` while the new
 *     period starts at the real instant, so the time between the two, at
 *     most `MOVE_GRACE_SECONDS` (two hours), is neither paid nor charged:
 *     that is all the creator gives away, never a day. If the payment
 *     fails, Stripe refuses the change (`error_if_incomplete`, as
 *     lib/membership-pause.ts does on an early return), and the payment day
 *     stays as it was.
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
 *     membership from being read; the price id kept and signed with it
 *     (`META_PRICE`) makes a request for a price since changed "changed".
 *     The last change made (`META_DONE`) is signed the same way, with the
 *     subscription and customer (`doneSigText`, `META_DONE_SIG`): one
 *     edited, or a signature without its time, is read as made just now
 *     ("recent"). That does not stop every edit: deleting the time and its
 *     signature together, or putting back an older signed pair, lets the
 *     member change again before a period has passed. The harm falls on
 *     the creator alone (each change gives away at most the two-hour run
 *     window, below), and the route keeps the last change on the server
 *     (Redis, by subscription) as well, which `lastDone` lets win.
 *   - The route reads the subscription with `Stripe-Version` 2025-03-31.basil
 *     or later (lib/stripe-connect.ts pins 2026-08-26.dahlia): with an older
 *     version, such as the 2024-06-20 used elsewhere, `billing_mode` and the
 *     period on the item are not there, and every membership is refused.
 *   - The route previews, checks `mayRun` and updates under the same
 *     subscription lock (`withLock` on `nl:tier:{subscription}:lock`, as
 *     lib/yearly-switch.ts does), so no other change to the membership
 *     slips between the fresh preview and the update. Things outside the
 *     subscription (a pending invoice item, a customer balance) can still
 *     be added by the creator in the seconds between the two, so the route
 *     checks the invoice the update returns (`latest_invoice`) with
 *     `overCeiling`, and refunds any excess it reports at once, by code.
 *   - After a 402 Stripe "doesn't update the subscription", so its
 *     `latest_invoice` stays the old paid one, but a proration invoice it
 *     made may be left open (or draft) outside it, could be paid later by
 *     the member through Stripe's link or a retry, or collected (or its
 *     lines left as pending invoice items for the next renewal), for a
 *     change that never happened. So the route, on a 402, first writes the
 *     signed sweep marker (`sweepMarkBody`), bound to the request's moment,
 *     with the last invoice before the send; it refuses the member with
 *     its own reason ("sweep") and nothing but `clearSweepBody` removes it.
 *     If it cannot be written, the route keeps the request and retries, and
 *     never clears the request after a 402 without it. It finds the 402's
 *     own invoice (from its `payment_intent`, through `/invoice_payments`)
 *     and signs it into the marker (`sweepMarkInvoiceBody`), so every sweep
 *     reads it again by id. Then it sweeps: lists, every page, the open,
 *     draft, uncollectible and paid invoices over the marker's window by
 *     the subscription and by the customer, and the customer's pending
 *     invoice items (`sweepQueries`: from `SWEEP_SKEW_SECONDS` before the
 *     send to `SWEEP_WINDOW_SECONDS` after it, short of the period's end),
 *     and does what `sweepAction` returns, each with
 *     retries: for a draft, stop it advancing first (`auto_advance=false`),
 *     then finalize it without advancing and void it (a subscription's
 *     draft cannot be deleted); void each open or uncollectible one, and if
 *     voiding keeps failing, mark it uncollectible
 *     (`/invoices/{id}/mark_uncollectible`) and sweep again; refund each
 *     paid one in full (`refundBody`, `refundIdempotencyKey`); delete each
 *     pending invoice item of the subscription (`DELETE /invoiceitems/{id}`);
 *     tell the creator about each invoice or item whose subscription
 *     cannot be read (never voided or refunded blindly); never leave one
 *     collectible or kept. The request itself may then be cleared
 *     (`clearRequestBody`, which never touches the marker). A scheduler of
 *     its own, independent of `moveDue`, sweeps again at `nextSweepAt`
 *     ("clear" only when a sweep read to the end, with the 402's invoice
 *     re-read, found nothing; "tell" the creator after `SWEEP_MAX_SECONDS`
 *     or for a marker that is not signed, then sweeping daily, with the
 *     refusal kept). Before every request and every run the route lists the
 *     subscription's open, draft and uncollectible invoices, every page,
 *     and passes them as `MoveContext.openInvoices`; while any is known, or
 *     the list was not read, the member is refused ("invoice").
 *   - After any run that does not move the day ("above", "invoice", any
 *     other refusal, a lapse or a 402), the route tells the member, in the
 *     same words the page uses, that the payment day stays as it was and
 *     why, so a request never ends in silence.
 *   - Not verified yet, and needed before the unit that calls Stripe: on a
 *     test clock, in both classic and flexible billing modes, how far the
 *     preview made a day ahead, the fresh one at the moment and the invoice
 *     the change makes differ; that the anchor really moves in flexible
 *     mode (until then `FLEXIBLE_MOVE_PROVEN` stays false, and a flexible
 *     membership, which is almost every new one, is refused with its own
 *     reason, "mode": the feature is effectively off); and "does the
 *     402 leave an open invoice, and where?" (in `latest_invoice`, only in
 *     the subscription's invoice list, or reached only from the 402's
 *     payment), and which `billing_reason` that invoice has; and "does the
 *     402 leave pending invoice items?" (proration lines with no invoice,
 *     which would ride on the next renewal); whether the 402's invoice,
 *     paid later, applies the change after all; whether Stripe retries
 *     that invoice and emails the member about it, and when; whether the
 *     402 error of the update carries a `payment_intent`; and which
 *     `billing_reason` the invoice of a checkout with `invoice_creation`
 *     has (lib/tax.ts). The ceiling
 *     keeps the member safe if the amounts differ; it does not show by how
 *     much.
 *
 * What the route that calls Stripe must do (the next unit), in one list:
 *
 *   1. Sign and verify with HMAC-SHA256 under `deriveKey("billing-day-request")`
 *      (lib/secret-box.ts), compared with `timingSafeEqual`.
 *   2. Read the subscription with `MOVE_EXPAND`, `Stripe-Version`
 *      2025-03-31.basil or later and `Stripe-Account` of the creator.
 *   3. Before each request and each run, list the subscription's open,
 *      draft and uncollectible invoices, every page, into
 *      `MoveContext.openInvoices`.
 *   4. Preview, check `mayRun` and update under `withLock` on
 *      `nl:tier:{subscription}:lock`, with a lock time longer than the
 *      Stripe calls, only from `on + RUN_SKEW_SECONDS`.
 *   5. Before every send, write the send record (`sendRecordFor`: the first
 *      send's second and the key) to Redis. Read the result with
 *      `sendResult`. A timeout, a network error, a 5xx or any other status
 *      is "unknown", never a 402: write the marker (item 6) from the first
 *      send's second, read the subscription again, and if `moveApplied`
 *      holds, it was a success (item 8); otherwise send the very same body
 *      with the same key again, without `mayRun` again, while `mayResend`
 *      allows, updating the record's last send. The request is cleared
 *      only when `mayClearRequest` allows, never by the lapsed-request
 *      cleanup while a send of it has no confirmed result and no marker.
 *   6. On a 402 or an "unknown" result: the sweep marker first
 *      (`sweepMarkBody`, from the send record, so the window starts at the
 *      first send), kept in Redis too; never clear the request until it is
 *      written; then the sweep (above). Before
 *      signing the invoice found through `/invoice_payments` into the
 *      marker, check it is this subscription's and was made from
 *      `sentAt - SWEEP_SKEW_SECONDS` on. A re-read by id that answers 404
 *      is passed to `sweepAction` as `{ id, status: "deleted" }`, read as
 *      closed. A paid invoice's `refunded` comes only from its charge's
 *      `amount_refunded`, never from the route's own record.
 *   7. Keep a Redis index of the subscriptions with a request or a sweep
 *      marker, by store, so the scheduler finds them; sweep again from it
 *      at `nextSweepAt` (`sweepDue`, `sweepAction`), keeping the last
 *      sweep's time there.
 *   8. On success (a 200, or `moveApplied` after an "unknown" result), check
 *      the expanded `latest_invoice` with `overCeiling` and refund any
 *      excess at once (`refundBody` with the amount,
 *      `refundIdempotencyKey`); never tell the member the day did not
 *      change.
 *   9. Keep on the server too (Redis) the last change made and each sweep
 *      marker, and pass them as `MoveContext.lastDone` and
 *      `MoveContext.serverMarker` (and `SweepOptions.serverMarker`): they
 *      win over a tampered, deleted or older one in the metadata. When the
 *      metadata was tampered with (`sweepAction`'s `rewrite`), write the
 *      marker back and tell the creator.
 *  9a. Every sweep, marker write (`sweepMarkBody`, `sweepMarkInvoiceBody`)
 *      and `clearSweepBody` runs under the same `withLock` as the change,
 *      reading the subscription again inside it; `clearSweepBody` clears
 *      only the marker the sweep read.
 *  10. Let the member cancel their own waiting request (`clearRequestBody`,
 *      under the same lock, only while it is not running).
 *  11. On "tell", tell the creator once (kept in Redis, not on every
 *      sweep), with the invoices and items listed in `clear.tell` or still
 *      open, and the member (`refusalWords("stuck")`).
 *  12. After any run that did not move the day, tell the member
 *      (`refusalWords`).
 *  13. Run the test-clock checks above before enabling anything; nothing
 *      is announced in help, feature pages or pricing before those proofs.
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
 * canceled, active and paid up, its billing mode known (and classic
 * until flexible is proven), a licensed price (never metered), its last
 * invoice paid and no other invoice of it open or in draft, not in a trial, not paused or set to pause, not set to end, one item
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

/**
 * Whether a test clock has shown that, in flexible billing mode, resetting
 * the anchor to now with these bodies really moves the payment day (Stripe's
 * billing-mode page says the anchor "remains unchanged" in the cases it
 * lists). Not a product flag: a rule toggle the unit that calls Stripe
 * flips only with that recorded proof. While false, a flexible
 * subscription is refused with its own reason, "mode" (not offered for
 * this membership yet), never "state", which a page reads as a membership
 * that is not active.
 */
export const FLEXIBLE_MOVE_PROVEN = false;

/** Room kept from the edges of the day, for a daylight-saving change in a later month. */
const EDGE_MS = 60 * 60 * 1000;

/**
 * What the change keeps in the subscription's metadata, as decimal strings.
 * The request: when the member asked (seconds), when the change runs
 * (seconds), the amount Stripe's preview showed (`amount_due`, in the
 * smallest unit of the currency, never below zero), the ceiling (the full
 * new period with its tax, same unit), the period it was priced on (its end
 * in seconds, its months and its price id), and the server's signature over
 * all of it (`META_SIG`, hex). The request is removed once the change ran,
 * was declined or lapsed. `META_DONE` is when the last change was made
 * (seconds), written only by the change that succeeded, with its own
 * signature (`META_DONE_SIG`).
 */
export const META_AT = "billing_day_at";
export const META_ON = "billing_day_on";
export const META_SHOWN = "billing_day_shown";
export const META_CEILING = "billing_day_ceiling";
export const META_END = "billing_day_end";
export const META_MONTHS = "billing_day_months";
export const META_PRICE = "billing_day_price";
export const META_SIG = "billing_day_sig";
export const META_DONE = "billing_day_done";
export const META_DONE_SIG = "billing_day_done_sig";
/** After a 402: the sweep marker (`SweepMarker`, dot-separated) and its signature; cleared only after a later sweep found nothing (`sweepAction`). */
export const META_SWEEP = "billing_day_sweep";
export const META_SWEEP_SIG = "billing_day_sweep_sig";

/** What a request writes and the end of a request clears; never the sweep marker. */
const REQUEST_KEYS = [META_AT, META_ON, META_SHOWN, META_CEILING, META_END, META_MONTHS, META_PRICE, META_SIG] as const;

/** The sweep marker, cleared only by `clearSweepBody` once `sweepAction` says "clear". */
const SWEEP_KEYS = [META_SWEEP, META_SWEEP_SIG] as const;

/** How long after a 402 the next sweep runs: a later run, once Stripe's lists have caught up. */
export const SWEEP_AGAIN_SECONDS = 15 * 60;

/** After this long with invoices still found, the route tells the creator; the refusal stays. */
export const SWEEP_MAX_SECONDS = 7 * 24 * 60 * 60;

/** After `SWEEP_MAX_SECONDS`, the sweep runs this often instead. */
export const SWEEP_SLOW_SECONDS = 24 * 60 * 60;

/**
 * How long after the update was sent an invoice it made is looked for:
 * Stripe makes it inside the call, so a short slack for its clock. The
 * 402's own invoice, kept in the marker by id, covers anything later.
 */
export const SWEEP_WINDOW_SECONDS = 5 * 60;

/** How far before the send the sweep looks, for Stripe's clock behind the server's (the skew tested). */
export const SWEEP_SKEW_SECONDS = 10 * 60;

/** A run is refused this close to the period's end, so a renewal invoice never falls near a declined change. */
export const RUN_END_CLEAR_SECONDS = 60 * 60;

/** The change runs only from this long after its moment, for the server's clock against Stripe's. */
export const RUN_SKEW_SECONDS = 60;

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
      price?: {
        id?: unknown;
        unit_amount?: unknown;
        recurring?: { interval?: unknown; interval_count?: unknown; usage_type?: unknown } | null;
      } | null;
    }[];
  } | null;
};

/**
 * Whether `sig` is the server's own signature of `text` (a
 * `requestSigText` or a `doneSigText`). On the server: HMAC-SHA256 under
 * `deriveKey("billing-day-request")`, compared with `timingSafeEqual`;
 * false when the key is missing or the signature is not 64 hex digits.
 */
export type RequestVerifier = (text: string, sig: string) => boolean;

/**
 * What the route read beside the subscription, for the checks that need it:
 * the verifier; the subscription's invoices found open, in draft or
 * uncollectible (`/invoices?subscription={id}&status=...`, every page), or
 * null when they were not read (any such invoice, or a list not read,
 * refuses); the server's own record of the last change (seconds), when it
 * keeps one (`lastDone`); and the server's copy of a sweep marker
 * (`serverMarker`), which refuses ("sweep") even when the metadata's is
 * gone.
 */
export type MoveContext = {
  verify: RequestVerifier;
  openInvoices: readonly unknown[] | null;
  lastDone?: number | null;
  serverMarker?: SweepMarker | null;
};

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
  | "changed"
  | "mode"
  | "sweep";

/** Why a waiting change does not run on account of its timing: no request, too early, or too late. */
export type RunTiming = "none" | "early" | "late";

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
 * source (a card only when it is one: `card_...`), then the customer's
 * default, as Stripe chooses. A method that was not expanded, another
 * source and anything else are not.
 */
function chargesCard(sub: BillingDaySub, customer: Record<string, unknown>): boolean {
  const own = sub.default_payment_method;
  if (own) return record(own)?.type === "card";
  const source = sub.default_source;
  if (source) return (typeof source === "string" && /^card_[A-Za-z0-9]+$/.test(source)) || record(source)?.object === "card";
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

/** The price id of the membership's one item, or null when not read. */
const priceIdOf = (sub: BillingDaySub): string | null => stripeId(sub.items?.data?.[0]?.price?.id);

/**
 * What one full period of the membership's one item costs before tax: its
 * price's `unit_amount` times its quantity (one), or null when not read.
 */
export function periodPrice(sub: BillingDaySub): number | null {
  const item = sub.items?.data?.[0];
  const unit = item?.price?.unit_amount;
  if ((item?.quantity ?? 1) !== 1 || typeof unit !== "number" || !Number.isInteger(unit) || unit < 0) return null;
  return unit;
}

const DIGITS = /^\d{1,12}$/;

/**
 * The exact text the server signs for a request, or null when any part is
 * not as these rules write it (so nothing is signed or read):
 * `billing-day:v1|{sub.id}|{customer}|{at}|{on}|{shown}|{ceiling}|{end}|{months}|{price}`.
 */
export function requestSigText(sub: BillingDaySub, meta: Record<string, string>): string | null {
  const id = stripeId(sub.id);
  const customer = customerIdOf(sub);
  const price = stripeId(meta[META_PRICE]);
  if (!id || !customer || !price) return null;
  const parts = [meta[META_AT], meta[META_ON], meta[META_SHOWN], meta[META_CEILING], meta[META_END], meta[META_MONTHS]];
  if (!parts.every((part) => typeof part === "string" && DIGITS.test(part))) return null;
  return ["billing-day:v1", id, customer, ...parts, price].join("|");
}

/**
 * The exact text the server signs for the last change made, or null when
 * any part is not as these rules write it:
 * `billing-day-done:v1|{sub.id}|{customer}|{done}`.
 */
export function doneSigText(sub: BillingDaySub, done: string): string | null {
  const id = stripeId(sub.id);
  const customer = customerIdOf(sub);
  if (!id || !customer || !DIGITS.test(done)) return null;
  return ["billing-day-done:v1", id, customer, done].join("|");
}

const checks = (verify: RequestVerifier, text: string | null, sig: unknown) =>
  text !== null && typeof sig === "string" && /^[0-9a-f]{64}$/.test(sig) && verify(text, sig);

/** The request kept on this subscription, only when the server's signature over it holds. */
function signedMeta(sub: BillingDaySub, verify: RequestVerifier): Record<string, string> | null {
  const meta = sub.metadata;
  if (!meta) return null;
  return checks(verify, requestSigText(sub, meta), meta[META_SIG]) ? meta : null;
}

/**
 * When the last change was made, in seconds. From the metadata: 0 when
 * none was ever recorded (neither the time nor its signature is there); a
 * time or signature that was edited, or one without the other, is
 * tampered. The server's own record (`serverDone`, kept by the route in
 * Redis) wins over a tampered one and over an older signed one; without
 * it, a tampered record is read as a change made just now, and the route
 * tells the creator. Deleting both, or putting back an older signed pair,
 * is caught only by the server record.
 */
export function lastDone(sub: BillingDaySub, nowSeconds: number, verify: RequestVerifier, serverDone?: number | null): number {
  const meta = sub.metadata ?? {};
  const raw = meta[META_DONE];
  const sig = meta[META_DONE_SIG];
  const server = typeof serverDone === "number" && Number.isInteger(serverDone) && serverDone >= 0 ? serverDone : null;
  let signed = 0;
  if (raw || sig) {
    const valid = typeof raw === "string" && checks(verify, doneSigText(sub, raw), sig) && seconds(raw);
    if (!valid) return server || nowSeconds;
    signed = seconds(raw);
  }
  return Math.max(signed, server ?? 0);
}

/**
 * A sweep marker: the declined (or unknown) change's moment, the second its
 * first update was sent, the window its invoices and items are looked for
 * in (from `SWEEP_SKEW_SECONDS` before the first send, for Stripe's clock,
 * to `SWEEP_WINDOW_SECONDS` after the last, never reaching the period's
 * end), the 402's own invoice once found (re-read by id on every sweep),
 * the last invoice before the send (paid for the period, never touched),
 * and the 402's payment: its PaymentIntent id, "none" when the 402 carried
 * none (nothing was charged), or null while not known (a timeout).
 */
export type SweepMarker = {
  on: number;
  sentAt: number;
  from: number;
  until: number;
  invoice: string | null;
  before: string | null;
  pi: string | null;
};

const markerParts = (marker: SweepMarker) => [marker.on, marker.sentAt, marker.from, marker.until, marker.invoice ?? "-", marker.before ?? "-", marker.pi ?? "-"];

/**
 * The exact text the server signs for a sweep marker:
 * `billing-day-sweep:v2|{sub.id}|{customer}|{on}|{sentAt}|{from}|{until}|{invoice or -}|{before or -}|{pi, none or -}`.
 */
export function sweepSigText(sub: BillingDaySub, marker: SweepMarker): string | null {
  const id = stripeId(sub.id);
  const customer = customerIdOf(sub);
  const times = [marker.on, marker.sentAt, marker.from, marker.until];
  if (!id || !customer || !times.every((n) => Number.isInteger(n) && n > 0 && DIGITS.test(String(n)))) return null;
  if ([marker.invoice, marker.before, marker.pi].some((part) => part !== null && !stripeId(part))) return null;
  return ["billing-day-sweep:v2", id, customer, ...markerParts(marker)].join("|");
}

/** Whether any part of a sweep marker is there in the metadata, signed or not. */
const markerPresent = (sub: BillingDaySub) => Boolean(sub.metadata?.[META_SWEEP] || sub.metadata?.[META_SWEEP_SIG]);

/** The sweep marker kept in this subscription's metadata, only when the server's signature over it holds. */
export function sweepMarker(sub: BillingDaySub, verify: RequestVerifier): SweepMarker | null {
  const raw = sub.metadata?.[META_SWEEP];
  const id = "([A-Za-z0-9_]{1,255}|-)";
  const found = typeof raw === "string" ? new RegExp(`^(\\d{1,12})\\.(\\d{1,12})\\.(\\d{1,12})\\.(\\d{1,12})\\.${id}\\.${id}\\.${id}$`).exec(raw) : null;
  if (!found) return null;
  const part = (value: string) => (value === "-" ? null : value);
  const marker = { on: Number(found[1]), sentAt: Number(found[2]), from: Number(found[3]), until: Number(found[4]), invoice: part(found[5]), before: part(found[6]), pi: part(found[7]) };
  return checks(verify, sweepSigText(sub, marker), sub.metadata?.[META_SWEEP_SIG]) ? marker : null;
}

const sameMarker = (a: SweepMarker | null, b: SweepMarker | null) => a !== null && b !== null && markerParts(a).join(".") === markerParts(b).join(".");

/**
 * The marker that holds: the server's own copy (kept by the route in Redis
 * beside the metadata) when it has one, else the signed one in the
 * metadata. The server's wins, so deleting or replaying the metadata never
 * releases the member while an invoice may still be open.
 */
function holdingMarker(sub: BillingDaySub, verify: RequestVerifier, serverMarker?: SweepMarker | null): SweepMarker | null {
  return serverMarker ?? sweepMarker(sub, verify);
}

/**
 * When the route's scheduler should sweep this subscription next, in
 * seconds: `SWEEP_AGAIN_SECONDS` after the first send, then after each
 * sweep (`lastSweptAt`, kept by the route), every `SWEEP_AGAIN_SECONDS`
 * until `SWEEP_MAX_SECONDS`, then every `SWEEP_SLOW_SECONDS`. The server's
 * marker (`serverMarker`) counts when the metadata's is gone. A marker that
 * is in the metadata but not signed, with no server copy, is due at once
 * (so the creator is told), then every `SWEEP_SLOW_SECONDS`; null when no
 * marker is anywhere.
 */
export function nextSweepAt(sub: BillingDaySub, verify: RequestVerifier, lastSweptAt: number | null, serverMarker?: SweepMarker | null): number | null {
  const marker = holdingMarker(sub, verify, serverMarker);
  if (!marker) {
    if (!markerPresent(sub)) return null;
    return lastSweptAt === null ? 0 : lastSweptAt + SWEEP_SLOW_SECONDS;
  }
  const first = marker.sentAt + SWEEP_AGAIN_SECONDS;
  if (lastSweptAt === null || lastSweptAt < first) return first;
  return lastSweptAt + (lastSweptAt >= marker.sentAt + SWEEP_MAX_SECONDS ? SWEEP_SLOW_SECONDS : SWEEP_AGAIN_SECONDS);
}

/**
 * Whether the route's scheduler should sweep this subscription now
 * (`nextSweepAt` has come). Independent of `pendingMove` and `moveDue`,
 * which stop seeing the request once its window has passed.
 */
export function sweepDue(sub: BillingDaySub, nowSeconds: number, verify: RequestVerifier, lastSweptAt: number | null = null, serverMarker?: SweepMarker | null): boolean {
  const next = nextSweepAt(sub, verify, lastSweptAt, serverMarker);
  return next !== null && nowSeconds >= next;
}

/**
 * The route's record of the change's sends, kept in Redis under the
 * subscription lock before every send: the moment, the first send's second
 * (the sweep window starts there), the last send's second, and the
 * idempotency key every send of it uses.
 */
export type SendRecord = { on: number; sentAt: number; lastSentAt: number; key: string };

/** How long after the first send the same update may still be sent again (inside Stripe's 24-hour idempotency). */
export const RESEND_MAX_SECONDS = 23 * 60 * 60;

/**
 * The send record to write before sending the update for `on`: a new one
 * on the first send; on a resend of the same change, the same first second
 * and key, with the last send's second moved on.
 */
export function sendRecordFor(existing: SendRecord | null, subscription: string, on: number, nowSeconds: number): SendRecord {
  if (existing && existing.on === on) return { ...existing, lastSentAt: Math.max(existing.lastSentAt, nowSeconds) };
  return { on, sentAt: nowSeconds, lastSentAt: nowSeconds, key: moveIdempotencyKey(subscription, on) };
}

/**
 * What a send of the update came to: "applied" (Stripe answered 200),
 * "declined" (402), or "unknown" (a timeout, a network error, a 5xx, any
 * other status): Stripe may have made the invoice either way.
 */
export function sendResult(result: { status?: unknown } | null): "applied" | "declined" | "unknown" {
  const status = result?.status;
  if (status === 200) return "applied";
  if (status === 402) return "declined";
  return "unknown";
}

/**
 * Whether the route may send the same update again after an "unknown"
 * result: the same body and key (`moveBody`, `SendRecord.key`), without
 * `mayRun` again, until `RESEND_MAX_SECONDS` after the first send.
 */
export function mayResend(record: SendRecord, nowSeconds: number): boolean {
  return nowSeconds < record.sentAt + RESEND_MAX_SECONDS;
}

/**
 * Whether the change for `on` was made: the last change kept, signed, is
 * that very moment. After an "unknown" send, the route reads the
 * subscription again; if this holds, the change was made: it treats it as
 * a success (checks `latest_invoice` with `overCeiling`) and never tells
 * the member the day did not change.
 */
export function moveApplied(sub: BillingDaySub, on: number, verify: RequestVerifier): boolean {
  const raw = sub.metadata?.[META_DONE];
  return typeof raw === "string" && raw === String(on) && checks(verify, doneSigText(sub, raw), sub.metadata?.[META_DONE_SIG]);
}

/**
 * Whether the route may clear the request (`clearRequestBody`) now: no send
 * of its change was recorded, or the change was made (`moveApplied`), or a
 * marker for that very moment holds (metadata or server). After any send
 * without a confirmed success, the marker must be written first.
 */
export function mayClearRequest(sub: BillingDaySub, verify: RequestVerifier, record: SendRecord | null, serverMarker?: SweepMarker | null): boolean {
  const on = seconds(signedMeta(sub, verify)?.[META_ON]);
  if (!on || !record || record.on !== on) return true;
  if (moveApplied(sub, on, verify)) return true;
  return holdingMarker(sub, verify, serverMarker)?.on === on;
}

/** When a signed change this membership is waiting for runs, in seconds; null when none waits. */
export function pendingMove(sub: BillingDaySub, nowSeconds: number, verify: RequestVerifier): number | null {
  const meta = signedMeta(sub, verify);
  const on = seconds(meta?.[META_ON]);
  return on && nowSeconds < on + MOVE_GRACE_SECONDS ? on : null;
}

/**
 * Whether the change waiting on this membership should run now: from
 * `RUN_SKEW_SECONDS` after its moment (so Stripe's clock has reached
 * `proration_date` too), and not past its window.
 */
export function moveDue(sub: BillingDaySub, nowSeconds: number, verify: RequestVerifier): boolean {
  const on = pendingMove(sub, nowSeconds, verify);
  return on !== null && nowSeconds >= on + RUN_SKEW_SECONDS;
}

/**
 * Whether the billing mode is read and the period is known where that mode
 * keeps it: on the item or, failing that, the subscription in classic mode;
 * on the item in flexible mode, which is accepted only once
 * `flexibleProven` (`FLEXIBLE_MOVE_PROVEN`) is true.
 */
export function periodKnown(sub: BillingDaySub, flexibleProven: boolean = FLEXIBLE_MOVE_PROVEN): boolean {
  const mode = record(sub.billing_mode)?.type;
  const item = sub.items?.data?.[0];
  if (mode === "flexible") return flexibleProven && typeof item?.current_period_end === "number" && typeof item?.current_period_start === "number" && endOf(sub) > 0;
  if (mode === "classic") return endOf(sub) > 0;
  return false;
}

/** Whether the route read the subscription's open and draft invoices and found none. */
const noOpenInvoices = (openInvoices: readonly unknown[] | null) => Array.isArray(openInvoices) && openInvoices.length === 0;

/**
 * Whether the last invoice paid the membership's current price for its
 * period: exactly one line of it that is not a proration, of the item's
 * price id and `periodPrice`. Otherwise (the price changed mid-period, a
 * proration-only invoice) the credit Stripe works out, at today's price in
 * classic mode, may not be what was paid.
 */
function paidAtPrice(sub: BillingDaySub): boolean {
  const list = record(record(sub.latest_invoice)?.lines);
  const lines = list?.data;
  if (!Array.isArray(lines) || list?.has_more === true) return false;
  const price = periodPrice(sub);
  const id = priceIdOf(sub);
  let periods = 0;
  for (const raw of lines) {
    const line = record(raw);
    const proration = record(record(line?.parent)?.subscription_item_details)?.proration;
    if (proration === true) continue;
    if (proration !== false) return false;
    const lineId = record(record(line?.pricing)?.price_details)?.price ?? record(line?.price)?.id;
    if (line?.amount !== price || lineId !== id) return false;
    periods += 1;
  }
  return periods === 1;
}

/** The checks that hold both when a member asks and when the change runs. */
function cannotHold(sub: BillingDaySub, nowSeconds: number, context: MoveContext): MoveRefusal | null {
  // A sweep marker, signed or not, holds until a sweep finds nothing left.
  if (markerPresent(sub) || context.serverMarker) return "sweep";
  if (!periodMonths(sub)) return "interval";
  if (sub.items?.data?.[0]?.price?.recurring?.usage_type !== "licensed") return "interval";
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
  if (periodPrice(sub) === null || !priceIdOf(sub)) return "items";
  const customer = record(sub.customer);
  if (customer?.deleted === true) return "state";
  if (discounted(sub) || nonEmpty(items[0].discounts) || nonEmpty(customer?.discount)) return "discount";
  if (affiliateMonthsLeft(meta, nowSeconds)) return "affiliate";
  if (sub.schedule || sub.pending_update || (sub.collection_method !== undefined && sub.collection_method !== "charge_automatically")) return "managed";
  if (record(sub.latest_invoice)?.status !== "paid" || !noOpenInvoices(context.openInvoices)) return "invoice";
  if (!paidAtPrice(sub)) return "changed";
  if (!customer || customer.balance !== 0) return "balance";
  if (!chargesCard(sub, customer)) return "card";
  if (record(sub.billing_mode)?.type === "flexible" && !FLEXIBLE_MOVE_PROVEN) return "mode";
  if (!periodKnown(sub)) return "state";
  return null;
}

/** Why the member cannot ask to move this membership's day now, or null when they can. */
export function cannotMove(sub: BillingDaySub, nowSeconds: number, context: MoveContext): MoveRefusal | null {
  const held = cannotHold(sub, nowSeconds, context);
  if (held) return held;
  // A signed request not yet cleared waits, even past its window, until the
  // route clears it (`clearRequestBody`).
  if (signedMeta(sub, context.verify) !== null) return "pending";
  const done = lastDone(sub, nowSeconds, context.verify, context.lastDone);
  if (done && nowSeconds < addMonths(done, periodMonths(sub))) return "recent";
  return null;
}

/**
 * Why the change waiting on this membership must not run now, or null when it
 * may. The membership must still be running normally, its signed request
 * due, inside the period it was priced on (the same end, months and price
 * as kept with the request, its moment not before that period started), and
 * still before the payment it brings forward, as Stripe's `proration_date`
 * needs. "none": no signed request; "early": before `on +
 * RUN_SKEW_SECONDS`; "late": past its window or too close to the period's
 * end. The fresh preview is checked after this, in `mayRun`.
 */
export function cannotRun(sub: BillingDaySub, nowSeconds: number, context: MoveContext): MoveRefusal | RunTiming | null {
  const held = cannotHold(sub, nowSeconds, context);
  if (held) return held;
  const on = seconds(signedMeta(sub, context.verify)?.[META_ON]);
  if (!on) return "none";
  if (nowSeconds < on + RUN_SKEW_SECONDS) return "early";
  if (nowSeconds >= on + MOVE_GRACE_SECONDS) return "late";
  const end = endOf(sub);
  const meta = sub.metadata ?? {};
  const start = startOf(sub);
  if (seconds(meta[META_END]) !== end || meta[META_MONTHS] !== String(periodMonths(sub)) || meta[META_PRICE] !== priceIdOf(sub) || !start || on < start) return "changed";
  // Never close to the period's end, where a renewal invoice would fall
  // near those a 402 leaves.
  if (on >= end || nowSeconds + RUN_END_CLEAR_SECONDS >= end) return "late";
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
export function daysOffered(sub: BillingDaySub, timeZone: string, nowSeconds: number, context: MoveContext): { day: number; on: number }[] {
  if (cannotMove(sub, nowSeconds, context)) return [];
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
 * shown, the ceiling, the period it was priced on (end, months, price id),
 * and the server's signature (`sign(requestSigText(...))`). Null when an
 * amount is not a whole number from zero up, the amount shown is above the
 * ceiling, the period, the price or the ids are not known, or the signer
 * cannot sign.
 */
export function requestMeta(sub: BillingDaySub, on: number, shown: number, ceiling: number, nowSeconds: number, sign: RequestSigner): Record<string, string> | null {
  const end = endOf(sub);
  const months = periodMonths(sub);
  const price = priceIdOf(sub);
  if (!wholeAmount(shown) || !wholeAmount(ceiling) || shown > ceiling || !end || !months || !price) return null;
  const meta: Record<string, string> = {
    [META_AT]: String(nowSeconds),
    [META_ON]: String(on),
    [META_SHOWN]: String(shown),
    [META_CEILING]: String(ceiling),
    [META_END]: String(end),
    [META_MONTHS]: String(months),
    [META_PRICE]: price,
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
 * The ceiling: the full new period with its tax. The preview must hold
 * exactly one line that is not a proration (the new period), its amount the
 * membership's own `periodPrice` (so nothing metered or added rides along),
 * with no discount on it; the ceiling is that amount plus the tax added on
 * top of it (a tax included in the price is already in the amount). Null
 * when it cannot be read exactly: no such line or more than one, a line
 * whose proration flag is not a yes or no, an amount that is not the
 * price, a discount, a tax whose behavior is neither, or the older
 * `tax_amounts` form.
 */
export function previewCeiling(invoice: MovePreview, sub: BillingDaySub): number | null {
  const lines = invoice.lines?.data;
  const price = periodPrice(sub);
  if (!Array.isArray(lines) || price === null) return null;
  let ceiling: number | null = null;
  for (const line of lines) {
    const proration = record(line.parent?.subscription_item_details)?.proration;
    if (typeof proration !== "boolean") return null;
    if (proration) continue;
    if (ceiling !== null || line.amount !== price || nonEmpty(line.tax_amounts)) return null;
    if ((line.discount_amounts ?? []).some((d) => d?.amount !== 0)) return null;
    let sum = price;
    for (const t of line.taxes ?? []) {
      if (typeof t?.amount !== "number" || !Number.isInteger(t.amount)) return null;
      if (t.tax_behavior === "exclusive") sum += t.amount;
      else if (t.tax_behavior !== "inclusive") return null;
    }
    ceiling = sum;
  }
  return ceiling !== null && wholeAmount(ceiling) ? ceiling : null;
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
export function previewRefusal(invoice: MovePreview, sub: BillingDaySub): PreviewRefusal | null {
  const lines = invoice.lines?.data;
  if (!Array.isArray(lines) || lines.length === 0 || invoice.lines?.has_more === true) return "extra";
  for (const line of lines) {
    const parent = line.parent;
    if (!parent || (parent.type !== undefined && parent.type !== "subscription_item_details") || !record(parent.subscription_item_details)) return "extra";
  }
  if (invoice.starting_balance !== 0) return "balance";
  const due = invoice.amount_due;
  if (typeof due !== "number" || !Number.isInteger(due) || due < 0) return "amount";
  const ceiling = previewCeiling(invoice, sub);
  if (ceiling === null || !withinCeiling(ceiling, due)) return "amount";
  return null;
}

/** The amount to show: the preview's whole `amount_due`, or null when the preview is refused. */
export function previewAmount(invoice: MovePreview, sub: BillingDaySub): number | null {
  return previewRefusal(invoice, sub) ? null : (invoice.amount_due as number);
}

/**
 * Why the fresh preview made at the moment of the change stops it, or null
 * when the change may be made: the same checks as the first preview, and
 * its `amount_due` not above the ceiling kept with the signed request (the
 * full new period with its tax). It may be above the amount first shown:
 * in flexible mode the credit is worked out from what was actually paid.
 */
export function runPreviewRefusal(sub: BillingDaySub, fresh: MovePreview, verify: RequestVerifier): PreviewRefusal | "above" | null {
  const refused = previewRefusal(fresh, sub);
  if (refused) return refused;
  const ceiling = ceilingOf(sub, verify);
  return ceiling !== null && withinCeiling(ceiling, fresh.amount_due as number) ? null : "above";
}

/**
 * The only door to `moveBody`: why the change waiting on this membership
 * must not be made now, or null when it may. Both `cannotRun` (the
 * membership, its invoices, the moment, the period) and
 * `runPreviewRefusal` (the fresh preview, against the ceiling) must pass,
 * with the same context. The caller makes the fresh preview with
 * `previewMoveBody` just before, under the same subscription lock as the
 * update.
 */
export function mayRun(sub: BillingDaySub, fresh: MovePreview, nowSeconds: number, context: MoveContext): MoveRefusal | PreviewRefusal | RunTiming | "above" | null {
  return cannotRun(sub, nowSeconds, context) ?? runPreviewRefusal(sub, fresh, context.verify);
}

/**
 * An invoice the route found after a 402: from the lists (`sweepQueries`),
 * or the 402's own invoice re-read by id (a 404 passed as
 * `{ id, status: "deleted" }`), as Stripe returns them. For a paid one,
 * `refunded` is its charge's `amount_refunded`, read from Stripe, never
 * from the route's own record; `payments` the PaymentIntent ids of its
 * payments (`/invoice_payments?invoice=...`, every page), not given when
 * not read; and `paid_out_of_band` as Stripe says.
 */
export type FoundInvoice = {
  id?: unknown;
  status?: unknown;
  created?: unknown;
  billing_reason?: unknown;
  subscription?: unknown;
  parent?: unknown;
  amount_paid?: unknown;
  refunded?: unknown;
  payments?: unknown;
  paid_out_of_band?: unknown;
};

/** A pending invoice item the route found after a 402 (`/invoiceitems?customer=...&pending=true`). */
export type FoundItem = { id?: unknown; date?: unknown; subscription?: unknown; parent?: unknown };

/**
 * What to clear after a declined change, and how, in this order:
 *   - `stopAdvance`: drafts, first stopped from advancing (`stopAdvanceBody`);
 *   - `finalize`: then finalized without advancing (`finalizeBody`), since
 *     a subscription's draft cannot be deleted, and voided;
 *   - `void`: open and uncollectible ones, and the finalized drafts (an
 *     uncollectible invoice can still be paid by its link; one that cannot
 *     be voided is marked uncollectible and swept again);
 *   - `refund`: paid ones with exactly one payment, not paid out of band,
 *     refunded in full (`refundBody`, `refundIdempotencyKey`): the member
 *     paid it, by Stripe's link or a retry, for a change that never
 *     happened;
 *   - `deleteItems`: pending invoice items of the subscription, deleted so
 *     they never ride on the next renewal;
 *   - `tell`: what cannot be cleared safely (an invoice or item whose
 *     subscription and payment cannot tie it to this change, a paid one
 *     with several payments or paid out of band): the creator is told, it
 *     is never voided, refunded or deleted blindly, and the marker stays;
 *   - `tellPaid`: unlinked paid invoices that cannot be tied to this change
 *     either way; told like `tell`, but after `SWEEP_MAX_SECONDS`, once the
 *     creator was told, they no longer hold the marker (nothing is left to
 *     collect).
 */
export type InvoicesToClear = {
  stopAdvance: string[];
  finalize: string[];
  void: string[];
  refund: string[];
  deleteItems: string[];
  tell: string[];
  tellPaid: string[];
};

const NOTHING_TO_CLEAR = (): InvoicesToClear => ({ stopAdvance: [], finalize: [], void: [], refund: [], deleteItems: [], tell: [], tellPaid: [] });

/** The statuses every sweep lists. */
export const SWEEP_STATUSES = ["open", "draft", "uncollectible", "paid"] as const;

/**
 * The queries the route lists with on every sweep, over the marker's
 * window: the invoices of each status of `SWEEP_STATUSES`, by the
 * subscription and by the customer (an invoice the update made may not be
 * linked to the subscription), then the customer's pending invoice items
 * (`/invoiceitems`; the 402 may leave its lines there with no invoice). At
 * most 100 a page: the route follows `has_more` to the end, and a sweep it
 * could not read to the end never clears. The 402's own invoice
 * (`SweepMarker.invoice`) is read again by id besides.
 */
export function sweepQueries(subscription: string, customer: string, marker: SweepMarker): { invoices: URLSearchParams[]; items: URLSearchParams } {
  const window = { "created[gte]": String(marker.from), "created[lte]": String(marker.until), limit: "100" };
  const invoices: URLSearchParams[] = [];
  for (const [key, value] of [["subscription", subscription], ["customer", customer]]) {
    for (const status of SWEEP_STATUSES) invoices.push(new URLSearchParams({ [key]: value, status, ...window }));
  }
  return { invoices, items: new URLSearchParams({ customer, pending: "true", ...window }) };
}

/** The subscription an invoice or item says it belongs to: its id, null for none, undefined when not read. */
function subscriptionOf(found: { subscription?: unknown; parent?: unknown }): string | null | undefined {
  const details = record(record(found.parent)?.subscription_details);
  const of = details ? details.subscription : found.subscription;
  if (of === null) return null;
  if (typeof of === "string") return of;
  const id = record(of)?.id;
  return typeof id === "string" ? id : undefined;
}

/** A paid invoice whose charge was refunded in full already. */
const fullyRefunded = (invoice: FoundInvoice) =>
  typeof invoice.amount_paid === "number" && typeof invoice.refunded === "number" && invoice.amount_paid <= invoice.refunded;

/** The payments of an invoice as read: its PaymentIntent ids, or null when not read. */
const paymentsOf = (invoice: FoundInvoice): string[] | null =>
  Array.isArray(invoice.payments) && invoice.payments.every((pi) => typeof pi === "string") ? (invoice.payments as string[]) : null;

/**
 * Everything to clear after the change was declined (402) or its send's
 * result was not known. The 402's own invoice (`marker.invoice`) always,
 * whatever its time or reason. Besides it, invoices and pending items made
 * inside the marker's window that were not made by the creator by hand
 * (`billing_reason` "manual") and are not the last invoice before the send
 * (`marker.before`):
 *   - of this very subscription (read and equal): cleared;
 *   - of another subscription: left alone;
 *   - of none, or not read: once the 402's own invoice is known, left
 *     alone (not this change's). Before that, tied by payment: when the
 *     marker keeps the 402's PaymentIntent, an invoice one of whose
 *     payments is that intent is this change's and is cleared, one whose
 *     payments do not include it is left alone, and one whose payments
 *     were not read is told; when the 402 carried no payment ("none"),
 *     nothing was charged and it is left alone; while the payment is not
 *     known (a timeout), a live one is told (`tellPaid` when paid).
 * A paid invoice refunded in full already needs nothing; one paid out of
 * band or with other than exactly one payment is told, never refunded.
 */
export function invoicesToVoid(found: readonly FoundInvoice[], subscription: string, marker: SweepMarker, items: readonly FoundItem[] = []): InvoicesToClear {
  const out = NOTHING_TO_CLEAR();
  const seen = new Set<string>();
  const inWindow = (time: unknown) => typeof time !== "number" || (time >= marker.from && time <= marker.until);
  const live = (status: unknown) => status === "open" || status === "uncollectible" || status === "draft" || status === "paid";
  for (const invoice of found) {
    const id = stripeId(invoice?.id);
    if (!id || seen.has(id) || !live(invoice.status)) continue;
    if (invoice.status === "paid" && fullyRefunded(invoice)) continue;
    if (id !== marker.invoice) {
      if (id === marker.before || invoice.billing_reason === "manual" || !inWindow(invoice.created)) continue;
      const of = subscriptionOf(invoice);
      if (typeof of === "string" && of !== subscription) continue;
      if (of !== subscription) {
        if (marker.invoice !== null || marker.pi === "none") continue;
        const payments = paymentsOf(invoice);
        if (marker.pi !== null && payments !== null && !payments.includes(marker.pi)) continue;
        if (marker.pi === null || payments === null) {
          (invoice.status === "paid" ? out.tellPaid : out.tell).push(id);
          seen.add(id);
          continue;
        }
      }
    }
    seen.add(id);
    if (invoice.status === "open" || invoice.status === "uncollectible") out.void.push(id);
    else if (invoice.status === "draft") {
      out.stopAdvance.push(id);
      out.finalize.push(id);
      out.void.push(id);
    } else {
      const payments = paymentsOf(invoice);
      if (invoice.paid_out_of_band === true || payments === null || payments.length !== 1) out.tell.push(id);
      else out.refund.push(id);
    }
  }
  for (const item of items) {
    const id = stripeId(item?.id);
    if (!id || seen.has(id) || !inWindow(item.date)) continue;
    const of = subscriptionOf(item);
    if (typeof of === "string" && of !== subscription) continue;
    if (of === subscription) out.deleteItems.push(id);
    else if (marker.invoice === null) out.tell.push(id);
    else continue;
    seen.add(id);
  }
  return out;
}

/** The update that stops a draft invoice from finalizing and being collected on its own. */
export function stopAdvanceBody(): URLSearchParams {
  return new URLSearchParams({ auto_advance: "false" });
}

/** The finalize of a subscription's draft, without advancing it, so it can be voided (it cannot be deleted). */
export function finalizeBody(): URLSearchParams {
  return new URLSearchParams({ auto_advance: "false" });
}

/**
 * A refund of a payment, in full or (after the change) of the `amount`
 * above the ceiling, sent with `refundIdempotencyKey` so a retry never
 * refunds twice.
 */
export function refundBody(paymentIntent: string, amount?: number): URLSearchParams {
  const body = new URLSearchParams({ payment_intent: paymentIntent, "metadata[billing_day]": "refund" });
  if (amount !== undefined) body.set("amount", String(amount));
  return body;
}

/** The idempotency key of a refund for one invoice. */
export function refundIdempotencyKey(invoice: string): string {
  return `billing-day-refund:${invoice}`;
}

/** The marker written to the metadata, signed; the route keeps the same marker in Redis. Null when it cannot be signed. */
export function sweepMarkerBody(sub: BillingDaySub, marker: SweepMarker, sign: RequestSigner): URLSearchParams | null {
  const text = sweepSigText(sub, marker);
  const sig = text === null ? null : sign(text);
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return null;
  return new URLSearchParams({ [`metadata[${META_SWEEP}]`]: markerParts(marker).join("."), [`metadata[${META_SWEEP_SIG}]`]: sig });
}

/**
 * The marker to write after any send without a confirmed success (a 402,
 * a timeout, a network error, a 5xx), before anything else and before the
 * request may be cleared: bound to the request's moment, with the first
 * send's second (`record.sentAt`), the window to sweep (from
 * `SWEEP_SKEW_SECONDS` before the first send to `SWEEP_WINDOW_SECONDS`
 * after the last, short of the period's end), the 402's invoice and
 * payment when already known (`pi`: its id, "none" when the 402 carried
 * none, null when not known), and the last invoice before the send. Null
 * when the request is not signed, the record is not for its moment, the
 * send is before the moment, an id is not as Stripe writes it, or the
 * marker cannot be signed.
 */
export function sweepMarkBody(
  sub: BillingDaySub,
  record: SendRecord,
  sign: RequestSigner,
  verify: RequestVerifier,
  ids: { invoice: string | null; before: string | null; pi: string | null },
): URLSearchParams | null {
  const meta = signedMeta(sub, verify);
  const on = seconds(meta?.[META_ON]);
  const end = seconds(meta?.[META_END]);
  const { sentAt } = record;
  if (!on || !end || record.on !== on || !Number.isInteger(sentAt) || sentAt < on) return null;
  const last = Math.max(sentAt, record.lastSentAt);
  const marker: SweepMarker = { on, sentAt, from: sentAt - SWEEP_SKEW_SECONDS, until: Math.min(last + SWEEP_WINDOW_SECONDS, end - 1), ...ids };
  if (marker.until < sentAt) return null;
  return sweepMarkerBody(sub, marker, sign);
}

/**
 * The holding marker again, signed, with what the route learned since: the
 * 402's own invoice (checked first to be this subscription's and made from
 * `sentAt - SWEEP_SKEW_SECONDS` on) and its payment, so every later sweep
 * reads the invoice by id. Null without a holding marker.
 */
export function sweepMarkInvoiceBody(
  sub: BillingDaySub,
  found: { invoice?: string; pi?: string },
  sign: RequestSigner,
  verify: RequestVerifier,
  serverMarker?: SweepMarker | null,
): URLSearchParams | null {
  const marker = holdingMarker(sub, verify, serverMarker);
  return marker ? sweepMarkerBody(sub, { ...marker, ...found }, sign) : null;
}

/** Options of a sweep: the server's copy of the marker, and whether the creator was told already. */
export type SweepOptions = { serverMarker?: SweepMarker | null; creatorTold?: boolean };

/**
 * What the route does with a sweep, and what to clear (always given, so
 * nothing found is left waiting). Every sweep, every marker write and
 * `clearSweepBody` run under the subscription's lock (`withLock` on
 * `nl:tier:{subscription}:lock`), reading the subscription again inside it.
 *   - "wait": the next sweep is not due yet (`nextSweepAt`); still clear
 *     what was found.
 *   - "clear": a sweep, at least `SWEEP_AGAIN_SECONDS` after the send, read
 *     to the end and with the 402's own invoice re-read by id (when the
 *     marker keeps one), found nothing left that holds; clear the marker
 *     (`clearSweepBody`, with the marker this sweep read) and its server
 *     copy, and the member may ask again.
 *   - "again": something was found (invoices or pending items), or the
 *     lists or the 402's invoice were not read; clear it and sweep again
 *     later, keeping the refusal.
 *   - "tell": something to tell (`clear.tell`, or `clear.tellPaid` while
 *     it holds), still something after `SWEEP_MAX_SECONDS`, or a marker
 *     in the metadata that is not signed with no server copy; keep the
 *     refusal, keep clearing what is found, and tell the creator once.
 * `rewrite` is true when the server's marker holds but the metadata's is
 * gone, unsigned or different: the route writes it back
 * (`sweepMarkerBody`) and tells the creator.
 */
export function sweepAction(
  sub: BillingDaySub,
  nowSeconds: number,
  verify: RequestVerifier,
  found: readonly FoundInvoice[],
  items: readonly FoundItem[],
  readToEnd: boolean,
  options: SweepOptions = {},
): { action: "wait" | "clear" | "again" | "tell"; clear: InvoicesToClear; rewrite: boolean } {
  const server = options.serverMarker ?? null;
  const marker = holdingMarker(sub, verify, server);
  const rewrite = server !== null && !sameMarker(server, sweepMarker(sub, verify));
  const subscription = stripeId(sub.id);
  if (!marker) return { action: markerPresent(sub) ? "tell" : "wait", clear: NOTHING_TO_CLEAR(), rewrite: false };
  if (!subscription) return { action: "tell", clear: NOTHING_TO_CLEAR(), rewrite };
  const clear = invoicesToVoid(found, subscription, marker, items);
  if (nowSeconds < marker.sentAt + SWEEP_AGAIN_SECONDS) return { action: "wait", clear, rewrite };
  const late = nowSeconds >= marker.sentAt + SWEEP_MAX_SECONDS;
  const paidHolds = !(late && options.creatorTold === true);
  const told = clear.tell.length > 0 || (paidHolds && clear.tellPaid.length > 0);
  const acting = clear.stopAdvance.length + clear.finalize.length + clear.void.length + clear.refund.length + clear.deleteItems.length > 0;
  // The 402's own invoice must have been read again (a 404 passed as "deleted" counts: it is closed).
  const ownRead = marker.invoice === null || found.some((invoice) => invoice?.id === marker.invoice);
  if (readToEnd && ownRead && !acting && !told) return { action: "clear", clear, rewrite };
  return { action: told || late ? "tell" : "again", clear, rewrite };
}

/**
 * The update that clears the sweep marker, only after `sweepAction` said
 * "clear", under the lock, with the subscription read again: null unless
 * the marker that holds now is the very one the sweep read (`read`), so a
 * marker written since is never cleared by an older sweep.
 */
export function clearSweepBody(sub: BillingDaySub, verify: RequestVerifier, read: SweepMarker, serverMarker?: SweepMarker | null): URLSearchParams | null {
  if (!sameMarker(holdingMarker(sub, verify, serverMarker), read)) return null;
  const body = new URLSearchParams();
  for (const key of SWEEP_KEYS) body.set(`metadata[${key}]`, "");
  return body;
}

/**
 * What the invoice the change returned took above the ceiling kept with
 * the request, in the smallest unit of the currency (0 when nothing), for
 * the route to refund at once; null when its `amount_paid` cannot be read
 * (the route reads the invoice again). Something added outside the
 * subscription in the seconds between the fresh preview and the update can
 * land on that invoice.
 */
export function overCeiling(invoice: { amount_paid?: unknown } | null, ceiling: number): number | null {
  const paid = invoice?.amount_paid;
  if (typeof paid !== "number" || !Number.isInteger(paid) || paid < 0 || !wholeAmount(ceiling)) return null;
  return Math.max(0, paid - ceiling);
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
 * the change marked done, with its signature (`doneSigText`), in the same
 * update, so both are written only when Stripe makes it. Null when the
 * signer cannot sign.
 */
export function moveBody(sub: BillingDaySub, on: number, sign: RequestSigner): URLSearchParams | null {
  const text = doneSigText(sub, String(on));
  const sig = text === null ? null : sign(text);
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const body = new URLSearchParams({
    "billing_cycle_anchor[type]": "now",
    proration_behavior: "always_invoice",
    proration_date: String(on),
    payment_behavior: "error_if_incomplete",
    off_session: "true",
  });
  for (const key of REQUEST_KEYS) body.set(`metadata[${key}]`, "");
  body.set(`metadata[${META_DONE}]`, String(on));
  body.set(`metadata[${META_DONE_SIG}]`, sig);
  body.append("expand[]", "latest_invoice");
  return body;
}

/**
 * The update that clears a request after its change was declined (402,
 * once the sweep marker is written), was refused at run time or lapsed.
 * Metadata only, and never the sweep marker: the payment day and every
 * past change stay as they were, and while a marker is kept the member is
 * still refused ("sweep"); otherwise they may ask again at once.
 */
export function clearRequestBody(): URLSearchParams {
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
    `On ${on}, you pay one full ${span}, less the paid days you will no longer use.`,
    `Today, Stripe works that out as ${input.amount}.`,
    `It is never more than one full ${span}, ${input.ceiling}. If it would be, nothing changes. Anything charged above it is refunded at once.`,
    input.months === 1
      ? `After that, you pay on the ${ordinal(local.day)} of each month.`
      : `After that, you pay every year on ${month} ${local.day}.`,
    "If that payment fails, your payment day stays the same.",
    `You can change the day once a ${span}.`,
  ];
}

/** Every reason a run may end without moving the day, as the route tells the member. */
export type RunOutcome = MoveRefusal | PreviewRefusal | RunTiming | "above" | "declined" | "stuck";

const REFUSAL_REASON: Record<RunOutcome, string> = {
  declined: "The payment did not go through, so the change was not made.",
  above: "On the day, it would have cost more than one full billing period.",
  early: "The change was not due yet.",
  late: "The change could not run at its time.",
  none: "There was no change waiting.",
  invoice: "Another payment on your membership is still open.",
  sweep: "We are still closing the payment that did not go through.",
  stuck: "We are checking a payment on your account. The creator has been told.",
  changed: "Your membership's price or billing has changed.",
  balance: "Your account has a balance, or we could not read it.",
  extra: "Something else was added to your next bill.",
  amount: "We could not read the amount for the change.",
  mode: "Changing the payment day is not available for this membership yet.",
  pending: "A change is already waiting.",
  recent: "You already changed the day this billing period.",
  interval: "This membership cannot change its payment day.",
  items: "This membership cannot change its payment day.",
  fixed: "This membership cannot change its payment day.",
  plan: "This membership cannot change its payment day.",
  managed: "This membership cannot change its payment day.",
  discount: "This membership has a discount, so its payment day stays as it is.",
  affiliate: "This membership cannot change its payment day right now.",
  trial: "Your free trial is still running.",
  behind: "A payment on your membership is past due.",
  state: "We could not confirm that your membership is active and up to date.",
  paused: "Your membership is paused.",
  ending: "Your membership is set to end.",
  card: "Your membership is not paid by card.",
};

/**
 * The outcomes after which the member may simply choose a day again: only
 * those whose cause does not stay. After a declined payment the sweep
 * marker refuses for a while, so it says when instead.
 */
const MAY_ASK_AGAIN = new Set<RunOutcome>(["above", "early", "late", "none", "amount"]);

/**
 * What the route tells the member after a run that did not move the day,
 * in plain US English: that the day stays, why, and whether they can
 * choose again (the route passes how many days `daysOffered` gives now;
 * with none, it does not say they can). Never names a figure or a date it
 * does not know.
 */
export function refusalWords(outcome: RunOutcome, options: { daysOffered?: number } = {}): string[] {
  const out = ["Your payment day did not change.", REFUSAL_REASON[outcome] ?? REFUSAL_REASON.state];
  // Only when a day is offered now (`daysOffered`); near the period's end none may be until the renewal.
  if (MAY_ASK_AGAIN.has(outcome) && options.daysOffered !== 0) out.push("You can choose a new day again.");
  else if (outcome === "declined") out.push("You can choose a new day once we have closed that payment.");
  return out;
}
