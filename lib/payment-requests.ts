/**
 * Payment requests, on the wire: the email that brings one and its
 * reminders, the checkout it is paid through, and what Stripe says became
 * of the payment (lib/payment-request-rules.ts says what one is).
 *
 * The checkout is the same one every sale here is paid through
 * (lib/store-checkout.ts, lib/store-tip-checkout.ts): one Stripe Checkout
 * on the creator's own account, with
 *
 *   - the plan's share of the sale as an application fee (lib/platform-share.ts,
 *     applyShare), settled and given back on refunds and lost disputes by the
 *     daily job like any sale's (lib/share-settle.ts);
 *   - the month's order figure and the data its order leaves, admitted
 *     before Stripe's page opens (lib/order-admission.ts), its confirmation
 *     counted as one order (lib/orders.ts, through lib/purchase-email.ts);
 *   - sales tax and Stripe's own invoice where the creator switched them on
 *     (lib/tax.ts), and only payment methods that settle at once
 *     (lib/instant-pay.ts), in the currency shown;
 *   - and the five-minute job's pass over the day's checkouts, so a buyer
 *     who closed the tab while Stripe was sending them back is still
 *     confirmed (lib/checkout-sweep.ts).
 *
 * Every email here is one of the store's own emails for the month
 * (lib/store-allowance-rules.ts, "email"), taken before it goes: a request
 * or a reminder that does not fit is not sent, and the creator is told why.
 * The receipt is the order's own email.
 */
import { ADMITTED_FIELD, OrdersPausedError, admitOrders } from "@/lib/order-admission";
import { applyShare } from "@/lib/platform-share";
import { applyTax, applyTaxDocuments, refusedTaxDocuments, withoutTaxDocuments } from "@/lib/tax";
import { inTheCurrencyShown, isSettled, onlyInstantMethods } from "@/lib/instant-pay";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { LANGUAGES } from "@/lib/store-language";
import { isHouseStore } from "@/lib/house-store";
import { canSell } from "@/lib/store-checkout";
import { sendEmail } from "@/lib/email";
import { fromStore, storeBase } from "@/lib/purchase-email";
import { speechFor } from "@/lib/buyer-words";
import { requestWords } from "@/lib/buyer-words/requests";
import { type Store, saleHandles, storeForId, storeIdGone } from "@/lib/store";
import { type CheckedRequest, type OutsideMethod, type PaymentRequest, statusOf, nextReminderAt, canSendAgain } from "@/lib/payment-request-rules";
import { changeRequest, delayReminder, dropReminder, dueReminders, holdForCheckout, letGo, markPaid, reminderRequestOf, requestOf, requestRecordKey } from "@/lib/payment-request-store";
import { forgetRefundCheck, keepRefundCheck, keptRefundCheck, REFUND_CHECK_SECONDS } from "@/lib/payment-request-refund-cache";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { essentialLimitState } from "@/lib/request-guard";
import { countStudio } from "@/lib/studio-route";

/** A reminder that could not go is tried again a day later, never sooner. */
const RETRY_MS = 86_400_000;

/** What the creator's list of sales calls one, in the studio's English. */
export const REQUEST_TITLE = "Payment request";
const DISPLAY_NAME = "branding_settings[display_name]";
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
/** A checkout already opened for a request is offered again, rather than a second beside it, while it is this young. */
const REUSE_SECONDS = 23 * 3_600;
/** Stripe keeps a checkout open from 30 minutes to a day. */
const MIN_OPEN_SECONDS = 31 * 60;

/** Where a request is opened and paid: the store's own address or domain, /pay/<id>. */
export function requestLink(store: Store, request: Pick<PaymentRequest, "id">): string {
  return `${storeBase(store)}/pay/${request.id}`;
}

/** Whether this store can send requests and take their payments right now: a till that works, and not the demo's. */
export function requestsOpen(store: Store): boolean {
  return canSell(store) && !isHouseStore(store);
}

/**
 * Emails a request, or a reminder of it, to the person it is for, from the
 * store's name, with replies going to the creator. Taken from the store's
 * emails for the month before it goes. Writes down when it went, or why it
 * did not, and when the next reminder is due.
 */
export async function sendRequestEmail(store: Store, request: PaymentRequest, now = Date.now()): Promise<{ sent: boolean; request: PaymentRequest }> {
  const reminder = request.sent.length > 0;
  const said = speechFor(store.language, request.currency);
  const w = requestWords(store.language);
  const total = said.money(request.total);
  const lines = request.lines.map((line) => `- ${line.text}${line.quantity > 1 ? ` × ${line.quantity}` : ""}: ${said.money(line.cents * line.quantity)}`);
  const text = [
    w.greeting(request.name),
    "",
    reminder ? w.reminderLead(store.name, said.date(request.sent[0])) : w.emailLead(store.name),
    "",
    ...lines,
    "",
    w.emailTotal(total),
    ...(request.dueDate ? [w.due(said.date(Date.parse(`${request.dueDate}T12:00:00Z`)))] : []),
    ...(request.note ? ["", `${w.note}:`, request.note] : []),
    "",
    w.emailLink,
    requestLink(store, request),
    "",
    w.secure(store.name),
    ...(store.tax.enabled ? [w.tax] : []),
    w.until(said.date(request.expiresAt)),
    "",
    w.emailIgnore,
    w.replyReaches(store.name),
    "",
    w.footer(store.name),
  ].join("\n");
  const sent = await sendEmail({
    meter: { by: "store", store, kind: "email" },
    from: fromStore(store),
    to: request.email,
    replyTo: store.email,
    subject: (reminder ? w.reminderSubject(store.name, total) : w.subject(store.name, total)).slice(0, 180),
    text,
    idempotencyKey: `nimbus-payreq:${request.id}:${request.sent.length}`,
  }).catch(() => false);
  // Written onto the record as it is now, not as it was read before the email
  // went: a payment made while it was being sent stays paid (MM-SA-02).
  const failed = "Not sent: your store's emails for this month may be used, or email could not be sent just now. You can send it again from here.";
  const done = await changeRequest(store, request.id, (current) => ({ next: sent ? { ...current, sent: [...current.sent, now], failed: "" } : { ...current, failed }, answer: null }), now);
  return { sent, request: done?.request ?? request };
}

/**
 * Sends one more email about a request by hand, within the same counts as
 * the reminders that go by themselves (lib/payment-request-rules.ts, canSendAgain).
 */
export async function remindNow(store: Store, id: string, now = Date.now()): Promise<{ ok: true; request: PaymentRequest; sent: boolean } | { ok: false; why: string }> {
  const request = await requestOf(store, id);
  if (!request) return { ok: false, why: "That request is gone. Reload the page." };
  const may = canSendAgain(request, now);
  if (!may.ok) return may;
  const done = await sendRequestEmail(store, request, now);
  return { ok: true, request: done.request, sent: done.sent };
}

/**
 * Whether a reminder's store or request is confirmed gone (CX-123 rule 24): the store's id key or the request's
 * record answered EXISTS with exactly 0. Any other answer, a cut-short reply or a failed read is unknown: false.
 */
async function reminderGone(sid: string, id: string): Promise<boolean> {
  try {
    if (await storeIdGone(sid)) return true;
    if (!isRedisConfigured()) return false;
    const reply = repliesFor(await redisPipeline([["EXISTS", requestRecordKey(id)]]), 1);
    return reply !== null && countOf(reply[0]) === 0;
  } catch {
    return false;
  }
}

/**
 * The daily job's part: every reminder now due is sent, once, to a request
 * still open, of a store that can still take its payment. Bounded by the
 * deadline and a batch at a time; a reminder whose store or request is
 * confirmed gone is dropped, one that could not be read just now is put off a
 * day, and the next one, if any, waits its day.
 */
export async function sendDueReminders(deadline: number, now = Date.now()): Promise<{ sent: number; skipped: number }> {
  const counts = { sent: 0, skipped: 0 };
  for (let round = 0; round < 10 && Date.now() < deadline; round += 1) {
    const due = await dueReminders(now, 50);
    if (!due.length) break;
    for (const { sid, id } of due) {
      if (Date.now() >= deadline) return counts;
      // Rule 24: a read that fails (a Redis timeout) is an unknown answer, never
      // "gone". The reminder stays on the list, moved later so this run does not
      // loop on it, and is tried again; only a confirmed null drops it. The request's record is read exactly
      // (reminderRequestOf): one in an unknown shape is put off the same way, never dropped for good.
      let store: Store | null;
      let request: PaymentRequest | null;
      try {
        store = await storeForId(sid);
        request = store ? await reminderRequestOf(store, id) : null;
      } catch (error) {
        console.error(`payment request reminder ${sid}|${id}: store or request could not be read; tried again later`, error);
        await delayReminder(sid, id, now + RETRY_MS);
        counts.skipped += 1;
        continue;
      }
      if (!store || !request) {
        // A null read is not "gone" by itself: an off-shape reply (not a string, cut short, not a request) also
        // reads as null. Only an exact EXISTS of 0 on the store's id key or the request's record drops it.
        if (await reminderGone(sid, id)) await dropReminder(sid, id);
        else {
          console.error(`payment request reminder ${sid}|${id}: store or request read as missing but not confirmed gone; tried again later`);
          await delayReminder(sid, id, now + RETRY_MS);
        }
        counts.skipped += 1;
        continue;
      }
      const next = nextReminderAt(request, now);
      if (next === null || next > now) {
        // Closed, expired or not yet due: written back as it is now, which takes it off the list or puts it at its day.
        await changeRequest(store!, id, (current) => ({ next: current, answer: null }), now).catch(() => null);
        counts.skipped += 1;
        continue;
      }
      // A store that cannot take the payment right now sends nothing asking for it; tried again tomorrow.
      if (!requestsOpen(store)) {
        await delayReminder(sid, id, now + RETRY_MS);
        counts.skipped += 1;
        continue;
      }
      const done = await sendRequestEmail(store, request, now);
      if (done.sent) counts.sent += 1;
      else {
        // Not sent (the store's emails for the month are used, or email failed): tried again tomorrow, never sooner.
        await delayReminder(sid, id, now + RETRY_MS);
        counts.skipped += 1;
      }
    }
  }
  return counts;
}

/** Why a payment page could not be opened, in the buyer's notice's words (lib/buyer-words/requests.ts, notices). */
export type CheckoutRefusal = "closed" | "paused" | "error" | "busy" | "gone";

/**
 * Opens the payment for one request and returns where to send the buyer:
 * the checkout already opened for it in the last day, while Stripe still
 * holds it open, or a new one, never two side by side.
 */
export async function openRequestCheckout(store: Store, id: string, origin: string, now = Date.now()): Promise<{ ok: true; url: string } | { ok: false; reason: CheckoutRefusal; error?: unknown }> {
  if (!requestsOpen(store) || !store.stripeAccountId) return { ok: false, reason: "closed" };
  const request = await requestOf(store, id);
  if (!request || statusOf(request, now) !== "open") return { ok: false, reason: "gone" };
  const held = await holdForCheckout(request.id);
  if (!held) return { ok: false, reason: "busy" };
  try {
    // The checkout opened before, while Stripe keeps it open: the same page again.
    if (SESSION_ID.test(request.session) && now - request.sessionAt < REUSE_SECONDS * 1000) {
      const known = (await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(request.session)}`).catch((error: unknown) => {
        // A checkout Stripe no longer has is no checkout: a new one is opened.
        if (error instanceof StripeError && error.status === 404) return {};
        throw error;
      })) as Record<string, unknown>;
      if (known.status === "open" && typeof known.url === "string" && known.url) return { ok: true, url: known.url };
      if (isSettled(known)) {
        await markPaid(store, request.id, known, now);
        return { ok: false, reason: "gone" };
      }
    }
    const opened = await createRequestCheckout(store, request, origin, now);
    // Kept only on a request still open: one paid or canceled while Stripe
    // was opening this checkout keeps what it became, and the checkout just
    // opened is closed again so nobody can pay it twice (MM-SA-02).
    const kept = await changeRequest(store, request.id, (current) => (statusOf(current, now) === "open" ? { next: { ...current, session: opened.id, sessionAt: now }, answer: true } : { next: null, answer: false }), now);
    if (!kept?.answer) {
      await onAccount("POST", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(opened.id)}/expire`, new URLSearchParams()).catch((error: unknown) => console.error("closing a checkout opened for a request that was paid meanwhile failed", error));
      return { ok: false, reason: "gone" };
    }
    return { ok: true, url: opened.url };
  } catch (error) {
    if (error instanceof OrdersPausedError) return { ok: false, reason: error.reason === "paused" ? "paused" : "error" };
    return { ok: false, reason: "error", error };
  } finally {
    await letGo(held);
  }
}

/** The checkout itself, on the creator's account. Exported for the tests. */
export async function createRequestCheckout(store: Store, request: PaymentRequest, origin: string, now = Date.now()): Promise<{ url: string; id: string }> {
  if (!store.stripeAccountId) throw new Error("This store takes no payments");
  const w = requestWords(store.language);
  const body = new URLSearchParams({
    mode: "payment",
    locale: LANGUAGES[store.language].stripe,
    customer_email: request.email,
    "metadata[store]": store.handle,
    "metadata[kind]": "request",
    "metadata[request]": request.id,
    "metadata[title]": `${REQUEST_TITLE}: ${request.lines[0]?.text ?? ""}${request.lines.length > 1 ? ` and ${request.lines.length - 1} more` : ""}`.slice(0, 450),
    "payment_intent_data[metadata][store]": store.handle,
    "payment_intent_data[metadata][kind]": "request",
    "payment_intent_data[metadata][request]": request.id,
    "payment_intent_data[description]": `${w.pageTitle}, ${store.name}`.slice(0, 500),
    success_url: `${origin}/@${store.handle}/pay/${request.id}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/@${store.handle}/pay/${request.id}`,
  });
  request.lines.forEach((line, i) => {
    body.set(`line_items[${i}][quantity]`, String(line.quantity));
    body.set(`line_items[${i}][price_data][currency]`, request.currency);
    body.set(`line_items[${i}][price_data][unit_amount]`, String(line.cents));
    body.set(`line_items[${i}][price_data][product_data][name]`, line.text.slice(0, 250));
  });
  // Never open past the request's own last moment, nor for less than Stripe allows.
  const closes = Math.floor(Math.min(request.expiresAt, now + 24 * 3_600_000 - 60_000) / 1000);
  body.set("expires_at", String(Math.max(closes, Math.floor(now / 1000) + MIN_OPEN_SECONDS)));
  onlyInstantMethods(body);
  inTheCurrencyShown(body);
  // Sales tax and the business buyer's documents, where the creator switched them on, as on any sale (lib/tax.ts).
  applyTax(store, body);
  applyTaxDocuments(store, body, false);
  // The share of the sale, where the plan has one: nothing can come off a request's lines, so the least paid is its total.
  applyShare(body, store, { recurring: false, least: request.total }, now / 1000);
  // One order of the month, admitted before Stripe's page opens (lib/order-admission.ts).
  const admitted = await admitOrders(store, 1, now, 1);
  if (!admitted.ok) throw new OrdersPausedError(admitted.reason);
  if (admitted.hour !== null) body.set(`metadata[${ADMITTED_FIELD}]`, String(admitted.hour));

  let named = isHouseStore(store);
  if (named) body.set(DISPLAY_NAME, store.name);
  let documents = store.tax.ids || store.tax.invoices;
  let session: Record<string, unknown> | null = null;
  while (session === null) {
    try {
      session = await onAccount("POST", store.stripeAccountId, "/checkout/sessions", body);
    } catch (error) {
      if (named && error instanceof StripeError && error.status === 400) {
        body.delete(DISPLAY_NAME);
        named = false;
        continue;
      }
      if (documents && refusedTaxDocuments(error)) {
        withoutTaxDocuments(body);
        documents = false;
        continue;
      }
      throw error;
    }
  }
  if (typeof session.url !== "string" || !session.url || typeof session.id !== "string") throw new Error("Stripe did not return a checkout URL");
  return { url: session.url, id: session.id };
}

/**
 * What the page a buyer comes back to needs: the request as it now is,
 * written as paid first when Stripe says this checkout of its own settled.
 * Its confirmation (the receipt, the order counted) is lib/purchase-email.ts's.
 */
export async function settleFromReturn(store: Store, request: PaymentRequest, sessionId: string, now = Date.now()): Promise<PaymentRequest> {
  if (!store.stripeAccountId || !SESSION_ID.test(sessionId) || request.state !== "open") return request;
  try {
    const session = (await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(sessionId)}`)) as Record<string, unknown>;
    const meta = (session.metadata ?? {}) as Record<string, string>;
    if (meta.kind !== "request" || meta.request !== request.id || !saleHandles(store).has(meta.store ?? "") || !isSettled(session)) return request;
    return (await markPaid(store, request.id, session, now))?.request ?? request;
  } catch (error) {
    if (!(error instanceof StripeError && error.status === 404)) console.error("reading a payment request's checkout failed", error);
    return request;
  }
}

/** A payment on the creator's Stripe that its refunds can be looked up by. */
const PAYMENT_INTENT = /^pi_[A-Za-z0-9]{8,255}$/;
/** Pages of refunds (100 each) one studio reading asks Stripe for, at most. */
const REFUND_PAGES = 3;
/** Every status Stripe gives a refund (the same list as lib/refunds.ts): any other is a row in another shape. */
const REFUND_STATUSES = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);
/** A refund still under way: not yet given back, but it may be, so its payment is not checked. */
const REFUND_UNDER_WAY = new Set(["pending", "requires_action"]);

/** One refund row in Stripe's shape, or null for a row in any other (a status Stripe does not list, an empty payment id, an amount that is not a whole number). */
function refundRow(item: unknown): { id: string; intent: string | null; status: string; amount: number } | null {
  const row = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
  const id = row && typeof row.id === "string" && row.id ? row.id : "";
  const intent = row?.payment_intent;
  if (!row || !id || (intent !== null && (typeof intent !== "string" || !intent)) || typeof row.status !== "string" || !REFUND_STATUSES.has(row.status) || !Number.isSafeInteger(row.amount) || (row.amount as number) < 0) return null;
  return { id, intent: intent as string | null, status: row.status, amount: row.amount as number };
}

/**
 * The account's succeeded refunds since `since`, summed per payment, and
 * whether every one was read (rule 24): a list still marked has_more after
 * the last page read (`capped` too), a page or a row in another shape (a
 * status Stripe does not list, an empty payment id), or the same refund
 * twice leaves `complete` false. What was read is still counted, once each:
 * it is a floor of what was refunded, never the total. `underWay` names the
 * payments with a refund still pending or waiting on an action: not
 * counted, and not checked. Throws when Stripe cannot be read.
 */
async function readRefunds(account: string, since: number): Promise<{ back: Map<string, number>; complete: boolean; capped: boolean; underWay: Set<string> }> {
  const back = new Map<string, number>();
  const underWay = new Set<string>();
  const seen = new Set<string>();
  let complete = true;
  let after = "";
  for (let page = 0; ; page += 1) {
    if (page === REFUND_PAGES) return { back, complete: false, capped: true, underWay };
    const listed = await onAccount("GET", account, `/refunds?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
    if (!Array.isArray(listed.data) || typeof listed.has_more !== "boolean") return { back, complete: false, capped: false, underWay };
    for (const item of listed.data as unknown[]) {
      const row = refundRow(item);
      if (!row || seen.has(row.id)) {
        complete = false;
        continue;
      }
      seen.add(row.id);
      if (row.intent === null) continue;
      if (row.status === "succeeded") back.set(row.intent, (back.get(row.intent) ?? 0) + row.amount);
      else if (REFUND_UNDER_WAY.has(row.status)) underWay.add(row.intent);
    }
    if (!listed.has_more) return { back, complete, capped: false, underWay };
    const last = (listed.data as unknown[]).at(-1) as Record<string, unknown> | null | undefined;
    if (!last || typeof last !== "object" || typeof last.id !== "string" || !last.id) return { back, complete: false, capped: false, underWay };
    after = last.id;
  }
}

/** Only a request paid through its checkout has refunds on Stripe; one refunded in full has nothing more to learn. */
const onStripe = (r: PaymentRequest) => r.state === "paid" && !r.outside;

/**
 * A request as the studio shows it: checked when it has nothing on Stripe to
 * read or `read` says its refunds were all read. Without a payment to look up
 * or a Stripe account, every reading is the same: no reload is promised and
 * nothing can be read on its own.
 */
function checkedOf(store: Store, r: PaymentRequest, read: boolean, retry = false, onDemand = false): CheckedRequest {
  const refundsChecked = !onStripe(r) || (read && PAYMENT_INTENT.test(r.payment));
  const lookable = !refundsChecked && PAYMENT_INTENT.test(r.payment) && !!store.stripeAccountId;
  return { ...r, refundsChecked, refundsRetry: lookable && retry, refundsOnDemand: lookable && onDemand };
}

/**
 * Writes refunds read on Stripe into the request, only ever upward (a refund
 * read is a refund), in full making it "refunded". The request as it now
 * stands, or null when what was read could not be written.
 */
async function raiseRefunded(store: Store, r: PaymentRequest, refunded: number, now: number): Promise<PaymentRequest | null> {
  if (refunded <= r.refunded) return r;
  const done = await changeRequest(store, r.id, (current) =>
    current.payment === r.payment && refunded > current.refunded
      ? { next: { ...current, refunded, state: refunded >= (current.amountPaid || current.total) ? "refunded" : current.state }, answer: null }
      : { next: null, answer: null },
  now).catch(() => null);
  return done ? done.request : null;
}

/**
 * Brings the studio's list up to date with refunds made on the creator's
 * Stripe (from its dashboard or anywhere else): one read of the account's
 * refunds since the oldest paid request shown, at most three pages. A
 * request refunded in full is "refunded"; in part, it says how much.
 *
 * Each request comes back with `refundsChecked`: false for one paid on
 * Stripe whose refunds were not all read (more than the pages read, a reply
 * in another shape, Stripe not answering, no Stripe account or no payment
 * to look up, or a whole list giving back less than the record holds), so
 * the studio never shows it as surely not refunded. `refundsRetry` says
 * whether reading again may change that; `refundsOnDemand`, whether the
 * list was cut at its pages, so that one payment can be read on its own when
 * the creator asks (checkRequestRefunds). The list itself never reads a
 * payment on its own. What was read is still written, only ever upward: a
 * refund read is a refund.
 */
export async function refreshRefunds(store: Store, requests: PaymentRequest[], now = Date.now()): Promise<CheckedRequest[]> {
  const paid = requests.filter((r) => onStripe(r) && PAYMENT_INTENT.test(r.payment));
  if (!paid.length || !store.stripeAccountId) return requests.map((r) => checkedOf(store, r, false));
  const since = Math.floor(Math.min(...paid.map((r) => r.paidAt)) / 1000) - 60;
  let read: Awaited<ReturnType<typeof readRefunds>>;
  try {
    read = await readRefunds(store.stripeAccountId, since);
  } catch (error) {
    console.error("reading a store's refunds for payment requests failed", error);
    return requests.map((r) => checkedOf(store, r, false, true));
  }
  if (!read.complete) console.error("a store's refunds for payment requests were not all read; shown as not checked", { pages: REFUND_PAGES, capped: read.capped });
  const changed = new Map<string, PaymentRequest>();
  const unsaved = new Set<string>();
  for (const r of paid) {
    const latest = await raiseRefunded(store, r, read.back.get(r.payment) ?? 0, now);
    if (latest) changed.set(r.id, latest);
    // What was read could not be written: what is shown is older than Stripe, so not checked.
    else unsaved.add(r.id);
  }
  return requests.map((r) => {
    const latest = changed.get(r.id) ?? r;
    // Stripe's whole list gives back less than the record holds (a refund since failed): what is shown is not what
    // Stripe says, so not checked, and a reload reads the same list. Nothing is lowered here.
    const short = read.complete && (read.back.get(latest.payment) ?? 0) < latest.refunded;
    // A refund still under way may yet give the money back, and a write that failed may not fail again: not checked,
    // and reading again may change that. A list not read in full reads the same next time.
    const passing = unsaved.has(r.id) || read.underWay.has(r.payment);
    return checkedOf(store, latest, read.complete && !short && !passing, read.complete && !short && passing, read.capped);
  });
}

/**
 * Checks of one payment's refunds (checkRequestRefunds) a store may ask
 * Stripe for in a minute, counted by the essential limiter under the scope
 * "payreq-refunds" (it fails closed; tests/plan-cost-registry.ts, SCOPES).
 * A creator presses one at a time: ten in a minute is more than a person
 * opens, and far below Stripe's read limit (100 a second in live mode). A
 * check the kept reading answers asks Stripe nothing and is not counted.
 */
export const REFUND_CHECKS_PER_MINUTE = 10;
/**
 * Studio requests one check takes before Stripe is asked, besides the
 * route's own: its one GET of up to a hundred refunds waited on for its
 * whole timeout (STRIPE_TIMEOUT_MS) at 2 GB. tests/plan-cost-registry.test.ts
 * holds them at the fewest that cover it (REFUND_CHECK_READ).
 */
export const REFUND_CHECK_UNITS = 3;

export { forgetRefundCheck, REFUND_CHECK_SECONDS };

/**
 * Why one request's check left it not checked: "" when it is checked;
 * "limit" past the store's checks for the minute; "unavailable" that count
 * or the kept reading could not be read; "used" past the studio's requests;
 * "stripe" Stripe could not be read; "more" more than one page of refunds
 * on that payment; "shape" a reply or a row in another shape; "under_way" a
 * refund still under way; "unsaved" what was read could not be written; "short"
 * Stripe gives back less than the record holds; "none" no Stripe account or
 * no payment to look up.
 */
export type RefundCheckWhy = "" | "limit" | "unavailable" | "used" | "stripe" | "more" | "shape" | "under_way" | "unsaved" | "short" | "none";

/**
 * One request's refunds, read on their own when the creator opens it in the
 * studio (coordinator's decision C1-20261108-0315-C4-30): for a request the
 * list could not check because the account has more refunds than its pages
 * read. One GET /v1/refunds?payment_intent=... on the creator's account,
 * only after the store's check for the minute (REFUND_CHECKS_PER_MINUTE) and
 * REFUND_CHECK_UNITS studio requests are taken; a whole reading is kept
 * REFUND_CHECK_SECONDS per payment (lib/payment-request-refund-cache.ts), so
 * opening it again asks Stripe nothing, and a refund the store's Stripe
 * events show forgets it (lib/webhooks.ts). Every other answer is not
 * checked, never 0 refunded (rule 24): a failed read, a list with more,
 * a reply or a row in another shape, a refund under way, the cap or the
 * studio's figure reached. What was read is written, only ever upward.
 * Null when the request is not one of this store's.
 */
export async function checkRequestRefunds(store: Store, id: string, now = Date.now()): Promise<{ request: CheckedRequest; why: RefundCheckWhy } | null> {
  const r = await requestOf(store, id);
  if (!r) return null;
  const not = (why: RefundCheckWhy, request: PaymentRequest = r, retry = true) => ({ request: checkedOf(store, request, false, retry, true), why });
  if (!onStripe(r)) return { request: checkedOf(store, r, true), why: "" };
  if (!PAYMENT_INTENT.test(r.payment) || !store.stripeAccountId || !store.sid) return { request: checkedOf(store, r, false), why: "none" };
  let refunded: number | null;
  try {
    refunded = await keptRefundCheck(store.sid, r.payment);
  } catch (error) {
    console.error("a payment request's kept refund check could not be read; not checked", error);
    return not("unavailable");
  }
  if (refunded === null) {
    const room = await essentialLimitState("payreq-refunds", store.sid, REFUND_CHECKS_PER_MINUTE, 60);
    // Past the cap, or a count that could not be read: Stripe is not asked (fails closed).
    if (room !== "within") return not(room === "exceeded" ? "limit" : "unavailable");
    const taken = await countStudio(store, null, REFUND_CHECK_UNITS).catch(() => ({ ok: false as const }));
    if (!taken.ok) return not("used", r, false);
    let listed: Record<string, unknown>;
    try {
      listed = await onAccount("GET", store.stripeAccountId, `/refunds?payment_intent=${encodeURIComponent(r.payment)}&limit=100`);
    } catch (error) {
      console.error("reading one payment request's refunds failed", error);
      return not("stripe");
    }
    if (!Array.isArray(listed.data) || typeof listed.has_more !== "boolean") return not("shape", r, false);
    // More than a page on one payment reads the same next time: not checked, and no reload promised.
    if (listed.has_more) return not("more", r, false);
    let sum = 0;
    let underWay = false;
    const seen = new Set<string>();
    for (const item of listed.data as unknown[]) {
      const row = refundRow(item);
      // A row of another payment in this payment's own list, or the same refund twice, is a list in another shape.
      if (!row || row.intent !== r.payment || seen.has(row.id)) return not("shape", r, false);
      seen.add(row.id);
      if (row.status === "succeeded") sum += row.amount;
      else if (REFUND_UNDER_WAY.has(row.status)) underWay = true;
    }
    if (!Number.isSafeInteger(sum)) return not("shape", r, false);
    if (underWay) {
      const latest = await raiseRefunded(store, r, sum, now);
      return not("under_way", latest ?? r);
    }
    refunded = sum;
    // Kept only once whole; a reading that could not be kept is still Stripe's answer, only asked again next time.
    await keepRefundCheck(store.sid, r.payment, refunded).catch((error) => console.error("a payment request's refund check could not be kept", error));
  }
  const latest = await raiseRefunded(store, r, refunded, now);
  if (!latest) return not("unsaved");
  // Stripe gives back less than the record holds (a refund since failed): never lowered, and not checked.
  if (refunded < latest.refunded) return not("short", latest, false);
  return { request: checkedOf(store, latest, true), why: "" };
}

/** Why a request could not be marked as paid outside Stripe. */
export type OutsideRefusal = "gone" | "busy" | "paid_online" | "processing" | "error";

/** Stripe keeps a checkout open a day at most: one opened longer ago than this cannot be paid any more. */
const CHECKOUT_LIFE_MS = 25 * 3_600 * 1000;

/**
 * Marks an open request as paid outside Stripe, in cash, by transfer or
 * otherwise (639 [GL7](30)), on the day the creator says. Nothing is charged
 * and nothing is released by it: a request is lines of the creator's own
 * words, and its page becomes the receipt.
 *
 * Never two payments for one request: under the same hold as opening its
 * checkout, the checkout already opened for it on the creator's Stripe is read
 * first. Paid there, it is written down as paid online and the mark is
 * refused; still being paid, it is refused; open, it is closed on Stripe
 * before anything is marked, and if it cannot be closed nothing is marked.
 */
export async function markPaidOutside(
  store: Store,
  id: string,
  mark: { method: OutsideMethod; note: string; paidAt: number },
  now = Date.now(),
): Promise<{ ok: true; request: PaymentRequest } | { ok: false; reason: OutsideRefusal }> {
  const request = await requestOf(store, id);
  if (!request || request.state !== "open") return { ok: false, reason: "gone" };
  const held = await holdForCheckout(request.id);
  if (!held) return { ok: false, reason: "busy" };
  try {
    if (SESSION_ID.test(request.session) && now - request.sessionAt < CHECKOUT_LIFE_MS) {
      if (!store.stripeAccountId) return { ok: false, reason: "error" };
      const known = (await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(request.session)}`).catch((error: unknown) => {
        if (error instanceof StripeError && error.status === 404) return {};
        throw error;
      })) as Record<string, unknown>;
      if (isSettled(known)) {
        await markPaid(store, request.id, known, now);
        return { ok: false, reason: "paid_online" };
      }
      if (known.status === "complete") return { ok: false, reason: "processing" };
      if (known.status === "open") {
        const closed = (await onAccount("POST", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(request.session)}/expire`, new URLSearchParams())) as Record<string, unknown>;
        if (closed.status !== "expired") return { ok: false, reason: "error" };
      }
    }
    const done = await changeRequest(
      store,
      request.id,
      (current) =>
        current.state !== "open"
          ? { next: null, answer: false }
          : {
              next: { ...current, state: "paid", paidAt: Math.min(now, mark.paidAt), amountPaid: current.total, payment: "", failed: "", closedAt: now, outside: { method: mark.method, note: mark.note } },
              answer: true,
            },
      now,
    );
    return done?.answer ? { ok: true, request: done.request } : { ok: false, reason: "gone" };
  } catch (error) {
    console.error("marking a payment request paid outside Stripe failed", error);
    return { ok: false, reason: "error" };
  } finally {
    await letGo(held);
  }
}
