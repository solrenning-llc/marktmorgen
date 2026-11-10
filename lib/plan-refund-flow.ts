/**
 * A plan refund from start to finish (305 [SY1] unit 2b1): the plan is set
 * to stop, the money is given back (lib/plan-refund-write.ts), and the plan
 * is ended at once, as app/refunds/page.tsx says ("A refund closes the paid
 * features of the store it was for … from the day it is made"). The route,
 * the button, its review page and the confirmation email are unit 2b2;
 * nothing but the daily job calls this yet.
 *
 * The order is the safe one:
 *   1. a note is written first (ENDING_KEY, field the store's id): "a refund
 *      was asked at `at` for subscription `s`", so whatever stops this
 *      request half way, the daily job (finishPlanRefunds, from
 *      app/api/cron/closing) finds it and finishes;
 *   2. the subscription is set to stop at the end of its period, so no
 *      renewal can be charged while the refund is made;
 *   3. the refund, once (lib/plan-refund-write.ts);
 *   4. made: the subscription is ended now (DELETE, no proration, no final
 *      invoice), its open invoices voided and its drafts deleted (Stripe
 *      "stops automatic collection" of them on a cancel but they could still
 *      be paid by hand), the store written down as having no plan (which
 *      starts the closing rules of lib/plan-closing-rules.ts), a break taken
 *      back and the add-on set to stop at the end of its paid month as its
 *      policy says (lib/assistant-billing.ts); then the note is removed;
 *   5. refused (nothing was sent to Stripe): the stop set in step 2 is
 *      taken back at once, so a refused refund never costs the creator their
 *      plan. A stop the creator had set themselves before is left as it was;
 *   6. maybe made (the write failed or timed out, the refunds could not be
 *      read, or an earlier request left a note): the note AND the stop stay,
 *      so no renewal can be charged before it is decided; the daily job ends
 *      the plan if the refund turns up, and takes the stop back only once it
 *      concludes none was made (SETTLE_SECONDS after the last try, from a
 *      reply that reads).
 * The plan is ended only on a refund Stripe says succeeded: a pending one
 * (it may still fail and give the money back to the charge) keeps the note
 * and the stop for the daily job. A refund whose answer was lost is found by
 * its metadata (`plan_refund` = the store's id) among the platform's refunds
 * made between the note and SETTLE_SECONDS after its last try. Undecidable
 * (rule 24: a reply that does not read is never "none"): the note and the
 * stop stay and the daily job keeps reading it, so the plan is never ended
 * without a refund that can be seen and the creator is never told "Nothing
 * was refunded" for a refund nobody could read; after GIVE_UP_DAYS each run
 * says the still-held case in the log (finding F1, Codex G and Claude 3).
 *
 * One at a time per store (FLOW_LOCK_SECONDS, lib/redis-lock.ts); the daily
 * job skips a store whose lock is held.
 */
import { BillingError, isBillingConfigured, onPlatform, setCancelAtPeriodEnd } from "@/lib/billing";
import { LOCK_SECONDS, type PlanRefundMade, refundPlanPayment } from "@/lib/plan-refund-write";
import { dropPause } from "@/lib/plan-pause";
import { syncAssistant } from "@/lib/assistant-billing";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor, stringList, UnknownReplyError } from "@/lib/redis-reply";
import { LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import { SUBSCRIPTION_PATTERN, type Store, setSubscription, storeForId, storeRef } from "@/lib/store";
import { EMAIL_PATTERN, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { planRefundLetter, planRefundNotMadeLetter, planRefundPartLetter } from "@/lib/plan-refund-words";
import { ownField, plainObject, readStripePage, StripeListUnreadable, type StripePage } from "@/lib/stripe-list";
import { randomBytes } from "node:crypto";

const AT = "2024-06-20";
/** The notes of plan refunds not finished yet: field a store's id, value a Note. */
export const ENDING_KEY = "nl:plan-refund:ending";
/** The review page's one-time pass: a refund is made only from the page that showed its amount. */
export const reviewKeyOf = (sid: string): string => `nl:plan-refund:${sid}:review`;
/**
 * How long the review page's pass is kept: only so an unused one is cleaned up. It is not a time limit on the
 * person (AX274 2.2.3): the pass carries the amount shown, and the refund is refused only when the policy gives
 * another amount by then, and then the page shows the new one.
 */
export const REVIEW_SECONDS = 7 * 86_400;
/** One store's whole refund at a time. */
export const flowKeyOf = (sid: string): string => `nl:plan-refund:${sid}:flow`;
/** The refund's own lock, plus the stop, the list and the ending (each request ends within 20 seconds). */
export const FLOW_LOCK_SECONDS = LOCK_SECONDS + 160;
/** A refund not found this long after its note was not made: Stripe's answer has long come back by then. */
export const SETTLE_SECONDS = 10 * 60;
/** A note the daily job could not decide (Stripe unread) for this long is said in the log on every run; it is kept, with its stop. */
export const GIVE_UP_DAYS = 7;
/** Pages of the platform's refunds read to find one (newest first, 100 a page, only those since the note). */
export const MAX_REFUND_PAGES = 3;
/** The most notes the daily job looks at in one run. */
export const MAX_NOTES = 50;
/**
 * The store id whose note the daily job looked at last. The next run starts after it (store ids in order, from the
 * start again after the last), so a note kept because its refund does not read never holds back the others: with N
 * notes, each one is looked at within ceil(N / MAX_NOTES) runs that are not cut short.
 */
export const NEXT_KEY = "nl:plan-refund:next";
/** The place goes by itself when the job has not moved it for this long (no note left to look at). */
const NEXT_SECONDS = 30 * 86_400;
/** Before the note: the refund's own `created` may be a few seconds before ours. */
const CLOCK_SLACK = 300;
const LIVE = ["active", "trialing", "past_due", "unpaid", "paused"];
const ENDED = ["canceled", "incomplete_expired"];
const REFUND_ID = /^re_[A-Za-z0-9]{6,128}$/;
const OBJECT_ID = /^[a-z]{2,4}_[A-Za-z0-9]{6,128}$/;

/**
 * A refund asked for and not finished: subscription, when it was first asked and last tried (seconds), whether we
 * set the stop. While a note stands, the stop stays: a refund may still turn up, and no renewal may be charged
 * before it is decided.
 */
export type Note = { s: string; at: number; t: number; m: 0 | 1; p?: NotedPart[] };
/** A charge the refund was about to give back, and how much (written before any money moves). */
export type NotedPart = { c: string; a: number };

export type PlanRefundFlow =
  /** Given back; `ended` false: the plan is ended by the daily job. `earlier`: given back by an earlier request. */
  | { ok: true; cents: number; currency: string; refundId: string; status: "succeeded" | "pending"; ended: boolean; earlier: boolean }
  /** Nothing given back. `stopLeft`: the stop set for it could not be taken back yet (the daily job does it). */
  | { ok: false; reason: Exclude<PlanRefundMade, { ok: true }>["reason"] | "no_plan" | "stop_failed" | "partial"; stopLeft: boolean };

type Row = Record<string, unknown>;
const rows = (page: Row): Row[] => (Array.isArray(page.data) ? (page.data as unknown[]).filter((r): r is Row => Boolean(r) && typeof r === "object") : []);
/**
 * A refund's amount as Stripe sends it: whole cents above zero, or null. Rule 24: an amount missing, as text, zero,
 * fractional or negative does not read, so a refund of ours carrying one is unknown, never a refund of $0 and never
 * "nothing given back" (which would take the stop back and tell the creator nothing was refunded).
 */
const refundCents = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);
/** A refund's currency as Stripe sends it: three lowercase letters, or null (never assumed to be US dollars). */
const refundCurrency = (value: unknown): string | null => (typeof value === "string" && /^[a-z]{3}$/.test(value) ? value : null);
/** Our refund given back or on its way (not failed or canceled): the ones whose amounts say what was given. */
const counts = (status: unknown): boolean => status === "succeeded" || status === "pending" || status === "requires_action";
/** Every status Stripe gives a refund (the Refund object in Stripe's API reference; the set lib/refunds.ts reads). */
const REFUND_STATES = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);
/**
 * A refund row that reads (rule 24): its status one Stripe gives, its metadata an object (or null: none). A row that
 * does not read proves nothing: it may be ours, so a list holding one never says "none" or "partial".
 */
const refundLegible = (row: Row): boolean => {
  const status = ownField(row, "status");
  const metadata = ownField(row, "metadata");
  return typeof status === "string" && REFUND_STATES.has(status) && (metadata === null || plainObject(metadata));
};
/** Whether a readable refund row says it is this store's plan refund (`metadata.plan_refund`). */
const oursFor = (row: Row, sid: string): boolean => {
  const metadata = ownField(row, "metadata");
  return plainObject(metadata) && ownField(metadata, "plan_refund") === sid;
};
/**
 * One page of refunds read exactly (lib/stripe-list.ts), or null when it is not a list at all. Stripe names every
 * list reply `"object": "list"`; a reply named anything else, or not named, is not that list, however empty its
 * `data` looks, so it never reads as "no refund" (Codex G on #3190, 6726655568).
 */
function refundPage(listed: unknown): StripePage | null {
  if (!plainObject(listed) || ownField(listed, "object") !== "list") return null;
  try {
    return readStripePage(listed, refundLegible);
  } catch (error) {
    if (error instanceof StripeListUnreadable) return null;
    throw error;
  }
}

function readNote(raw: unknown): Note | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Note>;
    if (typeof v.s !== "string" || !SUBSCRIPTION_PATTERN.test(v.s) || typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at <= 0) return null;
    const t = typeof v.t === "number" && Number.isSafeInteger(v.t) && v.t >= v.at ? v.t : v.at;
    const p = Array.isArray(v.p) && v.p.length && v.p.every((x) => x && typeof x.c === "string" && /^(ch|py)_[A-Za-z0-9]{6,128}$/.test(x.c) && Number.isSafeInteger(x.a) && x.a > 0) ? v.p : undefined;
    return { s: v.s, at: v.at, t, m: v.m === 1 ? 1 : 0, ...(p ? { p } : {}) };
  } catch {
    return null;
  }
}
const noteOf = async (sid: string): Promise<Note | null> => readNote((await redisPipeline([["HGET", ENDING_KEY, sid]]))[0]);
const writeNote = (sid: string, note: Note) => redisPipeline([["HSET", ENDING_KEY, sid, JSON.stringify(note)]]);
const dropNote = (sid: string) => redisPipeline([["HDEL", ENDING_KEY, sid]]);

/** The subscription as Stripe has it now, or null when it cannot be read. */
async function subscriptionOf(id: string): Promise<Row | null> {
  try {
    const sub = await onPlatform("GET", `/subscriptions/${encodeURIComponent(id)}`, undefined, { version: AT });
    return sub.id === id && typeof sub.status === "string" ? sub : null;
  } catch (error) {
    // Gone at Stripe: nothing live to stop or end.
    if (error instanceof BillingError && error.status === 404) return { id, status: "canceled" };
    return null;
  }
}
const stopSet = (sub: Row) => sub.cancel_at_period_end === true || (typeof sub.cancel_at === "number" && sub.cancel_at > 0);

/** Takes back the stop we set, when it is still there. True when nothing of ours is left. */
async function takeBackStop(id: string): Promise<boolean> {
  try {
    const sub = await subscriptionOf(id);
    if (!sub) return false;
    if (!LIVE.includes(String(sub.status)) || sub.cancel_at_period_end !== true) return true;
    await setCancelAtPeriodEnd(id, false);
    return true;
  } catch (error) {
    console.error("taking back a plan's stop after a refund that was not made failed", error);
    return false;
  }
}

/** `cents` and `currency` are what was given back, as read exactly: a found refund never carries a guessed amount. */
type Found = { kind: "found"; refund: Row; cents: number; currency: string; settled: boolean } | { kind: "partial" } | { kind: "none" } | { kind: "unknown" };

/**
 * What became of the charges a note says were about to be given back, read from each charge's own refunds (ours:
 * `metadata.plan_refund` = the store's id): all given ("found", settled), all given or on their way ("found", not
 * settled), some given and some not ("partial": never ended on, never taken back, until it is whole), none, or not
 * readable, which includes one of ours given back or on its way whose amount or currency does not read.
 */
/**
 * The charges to judge a refund by: an earlier request's and this one's. A charge in both keeps the larger amount,
 * which is what our refunds on it must add up to (a charge already partly refunded by us is read again as owing
 * only the rest). Never fewer charges than before, so a refund of part is never read as the whole.
 */
export function mergeParts(before: NotedPart[] | undefined, now: NotedPart[]): NotedPart[] {
  const merged = new Map<string, number>();
  for (const part of [...(before ?? []), ...now]) merged.set(part.c, Math.max(merged.get(part.c) ?? 0, part.a));
  return [...merged].map(([c, a]) => ({ c, a }));
}

export async function partsOutcome(sid: string, parts: NotedPart[]): Promise<Found> {
  let succeededAll = true;
  let coveredAll = true;
  let anyOurs = false;
  let unreadable = false;
  let first: Row | null = null;
  let total = 0;
  for (const part of parts) {
    let listed: Row;
    try {
      listed = await onPlatform("GET", `/refunds?${new URLSearchParams({ charge: part.c, limit: "100" })}`, undefined, { version: AT });
    } catch (error) {
      console.error("reading a plan payment's refunds failed", error);
      return { kind: "unknown" };
    }
    const page = refundPage(listed);
    // A list in another shape, or one with more than one page (a charge has a few refunds), is not decided.
    if (!page || page.hasMore) return { kind: "unknown" };
    // A row that does not read may be ours: it keeps a "none" or a "partial" from being said (below).
    if (page.unreadable > 0) unreadable = true;
    // Rule 30: a charge's list holds that charge's refunds only; a row of another charge is not this one's to count.
    if (page.rows.some((r) => ownField(r, "charge") !== part.c)) return { kind: "unknown" };
    // Ours, but with an id that is not a refund's: not decided, never left out as not ours.
    if (page.rows.some((r) => oursFor(r, sid) && !REFUND_ID.test(r.id))) return { kind: "unknown" };
    const ours = page.rows.filter((r) => oursFor(r, sid));
    // One of ours whose amount or currency does not read: not decided, never counted as nothing given (rule 24).
    if (ours.some((r) => counts(r.status) && (refundCents(r.amount) === null || refundCurrency(r.currency) === null))) return { kind: "unknown" };
    const sum = (ok: (status: unknown) => boolean) => ours.filter((r) => ok(r.status)).reduce((n, r) => n + (refundCents(r.amount) ?? 0), 0);
    const given = sum((x) => x === "succeeded");
    const coming = sum((x) => x === "pending" || x === "requires_action");
    if (given + coming > 0) anyOurs = true;
    if (given < part.a) succeededAll = false;
    if (given + coming < part.a) coveredAll = false;
    first ??= ours.find((r) => counts(r.status)) ?? null;
    total += part.a;
  }
  if (unreadable && (!anyOurs || !coveredAll)) return { kind: "unknown" };
  if (!anyOurs) return { kind: "none" };
  if (!coveredAll || !first) return { kind: "partial" };
  const currency = refundCurrency(first.currency);
  if (currency === null) return { kind: "unknown" };
  return { kind: "found", refund: { ...first, amount: total, status: succeededAll ? "succeeded" : "pending" }, cents: total, currency, settled: succeededAll };
}
/**
 * Our refund for this store made between `at` and `until` (seconds), found by its metadata among the platform's
 * refunds: `settled` when Stripe says it succeeded; one still pending or waiting for an action is found but not
 * settled (it may yet fail and give the money back to the charge), so the plan is not ended on it.
 */
export async function findPlanRefund(sid: string, at: number, until: number): Promise<Found> {
  let after = "";
  let unreadable = false;
  for (let page = 0; page < MAX_REFUND_PAGES; page += 1) {
    let listed: Row;
    try {
      const query = new URLSearchParams({ "created[gte]": String(at - CLOCK_SLACK), "created[lte]": String(until + CLOCK_SLACK), limit: "100" });
      if (after) query.set("starting_after", after);
      listed = await onPlatform("GET", `/refunds?${query}`, undefined, { version: AT });
    } catch (error) {
      console.error("reading the platform's refunds failed", error);
      return { kind: "unknown" };
    }
    const page = refundPage(listed);
    if (!page) return { kind: "unknown" };
    if (page.unreadable > 0 || page.rows.some((r) => oursFor(r, sid) && !REFUND_ID.test(r.id))) unreadable = true;
    const ours = page.rows.find((r) => oursFor(r, sid) && REFUND_ID.test(r.id) && counts(r.status));
    if (ours) {
      // Ours, but its amount or currency does not read: not decided (rule 24), never ended on with a letter of $0.
      const cents = refundCents(ours.amount);
      const currency = refundCurrency(ours.currency);
      if (cents === null || currency === null) return { kind: "unknown" };
      return { kind: "found", refund: ours, cents, currency, settled: ours.status === "succeeded" };
    }
    // "None" only from a list read to its end with every row readable (lib/stripe-list.ts).
    if (!page.hasMore) return unreadable ? { kind: "unknown" } : { kind: "none" };
    if (!page.lastId) return { kind: "unknown" };
    after = page.lastId;
  }
  // More refunds since the note than we read: not decided, never "none".
  return { kind: "unknown" };
}

/**
 * Ends the plan now and writes the store down as having none. True once all of it is done; false leaves the note
 * for the daily job. Safe to repeat: a second DELETE is refused and Stripe is asked instead.
 */
export async function endPlanNow(store: Store, id: string): Promise<boolean> {
  try {
    let sub: Row | null = null;
    try {
      sub = await onPlatform("DELETE", `/subscriptions/${encodeURIComponent(id)}`, undefined, { version: AT });
    } catch (error) {
      if (!(error instanceof BillingError)) throw error;
    }
    if (!sub || sub.id !== id || !ENDED.includes(String(sub.status))) sub = await subscriptionOf(id);
    if (!sub || !ENDED.includes(String(sub.status))) return false;
    for (const status of ["open", "draft"] as const) {
      const listed = await onPlatform("GET", `/invoices?${new URLSearchParams({ subscription: id, status, limit: "10" })}`, undefined, { version: AT });
      if (listed.has_more !== false) return false;
      for (const invoice of rows(listed)) {
        const invoiceId = typeof invoice.id === "string" ? invoice.id : "";
        if (!OBJECT_ID.test(invoiceId) || invoice.status !== status) continue;
        if (status === "open") await onPlatform("POST", `/invoices/${encodeURIComponent(invoiceId)}/void`, new URLSearchParams(), { version: AT, idempotencyKey: `plan-refund-void:${invoiceId}` });
        else await onPlatform("DELETE", `/invoices/${encodeURIComponent(invoiceId)}`, undefined, { version: AT });
      }
    }
    // Only the subscription this store still names: a plan started since is not this one's to end.
    const fresh = (await storeForId(store.sid)) ?? store;
    if (fresh.subscriptionId === id && fresh.subscriptionActive) {
      const saved = await setSubscription(storeRef(fresh), { active: false, period: null });
      if (!saved || saved.subscriptionActive) return false;
    }
    await dropPause(fresh).catch((error) => console.error("dropping a break after a refund failed", error));
    const now = (await storeForId(store.sid)) ?? fresh;
    if (now.assistantPlan?.active) {
      // The add-on is set to stop at the end of its paid month (its own policy); not confirmed means not done yet.
      const synced = await syncAssistant(now);
      if (synced.assistantPlan?.active && !synced.assistantPlan.cancelsAtEnd) return false;
    }
    return true;
  } catch (error) {
    console.error("ending a refunded plan failed", error);
    return false;
  }
}

/** A new one-time pass for the review page that shows `cents`, replacing any earlier one. */
export async function issueReview(sid: string, cents: number): Promise<string> {
  const token = randomBytes(18).toString("base64url");
  await redisPipeline([["SET", reviewKeyOf(sid), `${token}:${cents}`, "EX", REVIEW_SECONDS]]);
  return token;
}
/** Takes the pass once: the amount it was issued for, only for the token the page issued and not yet used; else null. */
export async function takeReview(sid: string, token: string): Promise<number | null> {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
  const [kept] = await redisPipeline([["GETDEL", reviewKeyOf(sid)]]);
  const m = typeof kept === "string" ? /^([A-Za-z0-9_-]{20,40}):(\d{1,12})$/.exec(kept) : null;
  return m && m[1] === token ? Number(m[2]) : null;
}

/** One email to the store's own address, from the company's sending, under an idempotency key. Not sent only logs. */
async function mail(store: Store, letter: { subject: string; text: string }, key: string): Promise<void> {
  const to = normaliseEmail(store.email);
  if (!EMAIL_PATTERN.test(to) || !isSenderConfigured()) {
    console.error(`plan-refund: store ${store.sid}'s email was not sent (no address or no sender)`);
    return;
  }
  const sent = await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to, replyTo: SUPPORT_EMAIL, subject: letter.subject, text: letter.text, idempotencyKey: key }).catch((error) => {
    console.error("sending a plan refund email failed", error);
    return false;
  });
  if (!sent) console.error(`plan-refund: store ${store.sid}'s email was not sent`);
}

/** The confirmation, once the plan has ended; keyed by the refund, so a retry never sends it twice. */
async function tell(store: Store, r: { cents: number; currency: string; refundId: string; status: "succeeded" | "pending" }): Promise<void> {
  await mail(store, planRefundLetter({ store: store.name || store.handle, cents: r.cents, currency: r.currency, pending: r.status === "pending", assistant: Boolean(store.assistantPlan?.active) }), `plan-refund-told:${r.refundId}`);
}

const refundOf = (found: Extract<Found, { kind: "found" }>, earlier: boolean, ended: boolean): PlanRefundFlow => ({
  ok: true,
  cents: found.cents,
  currency: found.currency,
  refundId: String(found.refund.id),
  status: found.refund.status === "succeeded" ? "succeeded" : "pending",
  ended,
  earlier,
});

/** The creator asked for their plan refund: the whole of it, in the safe order above. */
export async function refundAndEndPlan(store: Store, nowSeconds = Math.floor(Date.now() / 1000), expectCents?: number): Promise<PlanRefundFlow> {
  if (!isRedisConfigured()) return { ok: false, reason: "no_lock", stopLeft: false };
  const id = store.subscriptionId ?? "";
  if (!isBillingConfigured() || !SUBSCRIPTION_PATTERN.test(id)) return { ok: false, reason: "no_plan", stopLeft: false };
  let held;
  try {
    held = await takeLock(flowKeyOf(store.sid), FLOW_LOCK_SECONDS, 0);
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy", stopLeft: false };
    throw error;
  }
  try {
    const sub = await subscriptionOf(id);
    if (!sub) return { ok: false, reason: "failed", stopLeft: false };
    const before = await noteOf(store.sid);
    const weStop = LIVE.includes(String(sub.status)) && !stopSet(sub);
    // A note for another subscription is an old one: this request's replaces it.
    const kept = before && before.s === id ? before : null;
    // The charges an earlier request was refunding stay in the note, so a refund of one of them is never taken
    // for the whole: this request may stop before it reads what is owed (independent review, 31/10/2026).
    let note: Note = { s: id, at: kept?.at ?? nowSeconds, t: nowSeconds, m: kept?.m === 1 || weStop ? 1 : 0, ...(kept?.p ? { p: kept.p } : {}) };
    await writeNote(store.sid, note);

    // Nothing given back now. `maybe`: a refund may still turn up (a lost answer, an earlier request), so the note
    // and the stop both stay, and only the daily job takes the stop back once it concludes none was made. Otherwise
    // our stop is taken back at once and the note goes.
    const notMade = async (reason: Exclude<PlanRefundFlow, { ok: true }>["reason"], maybe: boolean): Promise<PlanRefundFlow> => {
      if (!maybe) {
        if (note.m === 1 && (await takeBackStop(id))) note = { ...note, m: 0 };
        if (note.m === 0) {
          await dropNote(store.sid);
          return { ok: false, reason, stopLeft: false };
        }
      }
      await writeNote(store.sid, note);
      return { ok: false, reason, stopLeft: note.m === 1 };
    };
    // Ends the plan only on a refund Stripe says succeeded; a pending one leaves the note (and the stop) for the daily job.
    const finish = async (settled: boolean): Promise<boolean> => {
      if (!settled) return false;
      const ended = await endPlanNow(store, id);
      if (ended) await dropNote(store.sid);
      return ended;
    };

    if (weStop) {
      try {
        await setCancelAtPeriodEnd(id, true);
      } catch (error) {
        console.error("setting a plan to stop before its refund failed", error);
        return notMade("stop_failed", Boolean(kept));
      }
    }
    const made = await refundPlanPayment(store, nowSeconds, expectCents, async (parts) => {
      note = { ...note, p: mergeParts(note.p, parts.map((part) => ({ c: part.chargeId, a: part.cents }))) };
      await writeNote(store.sid, note);
    });
    if (made.ok) {
      const ended = await finish(made.status === "succeeded");
      if (ended) await tell(store, made);
      return { ok: true, cents: made.cents, currency: made.currency, refundId: made.refundId, status: made.status, ended, earlier: false };
    }
    // Not made now: one made before (an earlier request, or this one whose answer was lost) is looked for.
    const found = note.p ? await partsOutcome(store.sid, note.p) : await findPlanRefund(store.sid, note.at, nowSeconds);
    if (found.kind === "found") {
      const result = refundOf(found, made.reason !== "failed", await finish(found.settled));
      if (result.ok && result.ended) await tell(store, result);
      return result;
    }
    // "failed" may hide a refund Stripe makes after we stopped waiting, and an earlier note one we have not seen.
    // Part of it given back (some charges refunded, some not): said as such, the note and the stop kept.
    if (found.kind === "partial") return notMade("partial", true);
    return notMade(made.reason, made.reason === "failed" || found.kind === "unknown" || Boolean(kept));
  } finally {
    await releaseLock(held);
  }
}

/**
 * The daily job's part (app/api/cron/closing): each note left by a request that did not finish is decided. Its
 * refund found: the plan is ended. Not found SETTLE_SECONDS after the note: none was made, and a stop we set is
 * taken back. Not decidable: kept and tried again tomorrow, said in the log after GIVE_UP_DAYS. One failure never
 * stops the rest. At most MAX_NOTES a run, starting after the store looked at last (NEXT_KEY), so notes kept undecided
 * never take the turn of the ones after them.
 */
export async function finishPlanRefunds(deadline: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ ended: number; dropped: number; left: number }> {
  const counts = { ended: 0, dropped: 0, left: 0 };
  if (!isRedisConfigured() || !isBillingConfigured()) return counts;
  // Rule 24: the notes and the job's place, each read exactly. One that does not read is unknown: nothing is decided
  // on a guess (the caller logs it and the next run tries again), never "no notes" or "start from the top".
  const replies = repliesFor(await redisPipeline([["HGETALL", ENDING_KEY], ["GET", NEXT_KEY]]), 2);
  if (!replies) throw new UnknownReplyError("the plan refund notes and the daily job's place");
  const flat = stringList(replies[0]);
  if (!flat || flat.length % 2 !== 0) throw new UnknownReplyError(`HGETALL ${ENDING_KEY}`);
  const last = replies[1];
  if (last !== null && typeof last !== "string") throw new UnknownReplyError(`GET ${NEXT_KEY}`);
  const all: [string, string][] = [];
  for (let i = 0; i < flat.length; i += 2) all.push([flat[i], flat[i + 1]]);
  // Fair turns: store ids in order, starting after the one looked at last, so every note has its turn however many
  // stay undecided (finding of Claude 5, 6732230896, and Codex G, G102-Q). Unread notes are never let go to make room.
  all.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const after = last === null ? 0 : all.findIndex(([sid]) => sid > last);
  const start = after < 0 ? 0 : after;
  const fields: [string, string][] = [];
  for (let j = 0; j < Math.min(MAX_NOTES, all.length); j += 1) fields.push(all[(start + j) % all.length]);
  counts.left = all.length - fields.length;
  let passed: string | null = null;
  for (const [sid, value] of fields) {
    if (Date.now() >= deadline) {
      counts.left += 1;
      continue;
    }
    passed = sid;
    let held;
    try {
      held = await takeLock(flowKeyOf(sid), FLOW_LOCK_SECONDS, 0);
    } catch {
      // A request is finishing it now, or the lock cannot be read: tomorrow.
      counts.left += 1;
      continue;
    }
    try {
      const note = readNote(value);
      const store = note ? await storeForId(sid) : null;
      if (!note || !store) {
        if (!note) console.error(`plan-refund: an unreadable note for store ${sid} is dropped`);
        await dropNote(sid);
        counts.dropped += 1;
        continue;
      }
      const found = note.p ? await partsOutcome(sid, note.p) : await findPlanRefund(sid, note.at, note.t + SETTLE_SECONDS);
      if (found.kind === "found") {
        // Still pending: looked at again tomorrow, the stop kept, so nothing renews meanwhile.
        if (found.settled && (await endPlanNow(store, note.s))) {
          await dropNote(sid);
          const result = refundOf(found, false, true);
          if (result.ok) await tell(store, result);
          counts.ended += 1;
        } else counts.left += 1;
        continue;
      }
      if (found.kind === "partial") {
        // Some given back and some not: never ended on part of a refund, and the stop stays (no renewal). The rest is
        // given when the creator asks again; after GIVE_UP_DAYS the note goes and the creator is told to ask support.
        if (nowSeconds - note.at <= GIVE_UP_DAYS * 86_400) {
          counts.left += 1;
          continue;
        }
        await dropNote(sid);
        await mail(store, planRefundPartLetter({ store: store.name || store.handle }), `plan-refund-part:${sid}:${note.at}`);
        counts.dropped += 1;
        continue;
      }
      if (found.kind === "unknown" || nowSeconds - note.t < SETTLE_SECONDS) {
        // Rule 24 (finding F1): an outcome that was not read is never "none", however long it lasts. The note and the
        // stop stay (no renewal is charged, the plan is never ended without a refund we can see, the studio keeps
        // saying it is being settled) and the creator is never emailed "Nothing was refunded" for it.
        if (found.kind === "unknown" && nowSeconds - note.at > GIVE_UP_DAYS * 86_400) {
          console.error(`plan-refund: the refund asked for store ${sid} is still undecided after ${GIVE_UP_DAYS} days; still held with its stop, read again tomorrow`);
        }
        counts.left += 1;
        continue;
      }
      // None was made: our stop goes, the plan goes on as it was.
      if (note.m === 1 && !(await takeBackStop(note.s))) {
        if (nowSeconds - note.at <= GIVE_UP_DAYS * 86_400) {
          counts.left += 1;
          continue;
        }
        console.error(`plan-refund: the stop set for store ${sid}'s refund could not be taken back in ${GIVE_UP_DAYS} days; its note is dropped`);
      }
      await dropNote(sid);
      // Read and none was made: the creator saw "nothing was refunded" or "we check every day", so it reaches them by email.
      await mail(store, planRefundNotMadeLetter({ store: store.name || store.handle }), `plan-refund-none:${sid}:${note.at}`);
      counts.dropped += 1;
    } catch (error) {
      console.error(`plan-refund: the note for store ${sid} is not decided yet; tried again tomorrow`, error);
      counts.left += 1;
    } finally {
      await releaseLock(held);
    }
  }
  // The place moves only past the notes whose turn came (not those the deadline left), so none loses its turn. Not
  // written: the next run looks at the same notes again, which delays the others by a run and decides nothing wrong.
  if (passed !== null) {
    try {
      const [set] = await redisPipeline([["SET", NEXT_KEY, passed, "EX", NEXT_SECONDS]]);
      if (set !== "OK") console.error("plan-refund: the daily job's place was not confirmed written; the next run may look at the same notes again");
    } catch (error) {
      console.error("plan-refund: the daily job's place could not be written; the next run may look at the same notes again", error);
    }
  }
  return counts;
}
