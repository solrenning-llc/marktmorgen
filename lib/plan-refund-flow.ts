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
 *      concludes none was made (SETTLE_SECONDS after the last try).
 * The plan is ended only on a refund Stripe says succeeded: a pending one
 * (it may still fail and give the money back to the charge) keeps the note
 * and the stop for the daily job. A refund whose answer was lost is found by
 * its metadata (`plan_refund` = the store's id) among the platform's refunds
 * made between the note and SETTLE_SECONDS after its last try. Undecidable
 * for GIVE_UP_DAYS: the stop is taken back and the plan goes on as it was,
 * never ended without a refund that can be seen.
 *
 * One at a time per store (FLOW_LOCK_SECONDS, lib/redis-lock.ts); the daily
 * job skips a store whose lock is held.
 */
import { BillingError, isBillingConfigured, onPlatform, setCancelAtPeriodEnd } from "@/lib/billing";
import { LOCK_SECONDS, type PlanRefundMade, refundPlanPayment } from "@/lib/plan-refund-write";
import { dropPause } from "@/lib/plan-pause";
import { syncAssistant } from "@/lib/assistant-billing";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import { SUBSCRIPTION_PATTERN, type Store, setSubscription, storeForId, storeRef } from "@/lib/store";
import { EMAIL_PATTERN, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { planRefundLetter, planRefundNotMadeLetter, planRefundPartLetter } from "@/lib/plan-refund-words";
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
/** A note the daily job could not decide (Stripe unread) for this long is dropped, said in the log. */
export const GIVE_UP_DAYS = 7;
/** Pages of the platform's refunds read to find one (newest first, 100 a page, only those since the note). */
export const MAX_REFUND_PAGES = 3;
/** The most notes the daily job looks at in one run. */
export const MAX_NOTES = 50;
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

type Found = { kind: "found"; refund: Row; settled: boolean } | { kind: "partial" } | { kind: "none" } | { kind: "unknown" };

/**
 * What became of the charges a note says were about to be given back, read from each charge's own refunds (ours:
 * `metadata.plan_refund` = the store's id): all given ("found", settled), all given or on their way ("found", not
 * settled), some given and some not ("partial": never ended on, never taken back, until it is whole), none, or not
 * readable.
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
    if (listed.has_more !== false) return { kind: "unknown" };
    const ours = rows(listed).filter((r) => (r.metadata as Row | null | undefined)?.plan_refund === sid && typeof r.id === "string" && REFUND_ID.test(r.id));
    const sum = (ok: (status: unknown) => boolean) => ours.filter((r) => ok(r.status)).reduce((n, r) => n + (Number(r.amount) || 0), 0);
    const given = sum((x) => x === "succeeded");
    const coming = sum((x) => x === "pending" || x === "requires_action");
    if (given + coming > 0) anyOurs = true;
    if (given < part.a) succeededAll = false;
    if (given + coming < part.a) coveredAll = false;
    first ??= ours.find((r) => r.status === "succeeded" || r.status === "pending" || r.status === "requires_action") ?? null;
    total += part.a;
  }
  if (!anyOurs) return { kind: "none" };
  if (!coveredAll || !first) return { kind: "partial" };
  return { kind: "found", refund: { ...first, amount: total, status: succeededAll ? "succeeded" : "pending" }, settled: succeededAll };
}
/**
 * Our refund for this store made between `at` and `until` (seconds), found by its metadata among the platform's
 * refunds: `settled` when Stripe says it succeeded; one still pending or waiting for an action is found but not
 * settled (it may yet fail and give the money back to the charge), so the plan is not ended on it.
 */
export async function findPlanRefund(sid: string, at: number, until: number): Promise<Found> {
  let after = "";
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
    const data = rows(listed);
    const ours = data.find((r) => (r.metadata as Row | null | undefined)?.plan_refund === sid && typeof r.id === "string" && REFUND_ID.test(r.id) &&
      (r.status === "succeeded" || r.status === "pending" || r.status === "requires_action"));
    if (ours) return { kind: "found", refund: ours, settled: ours.status === "succeeded" };
    if (listed.has_more !== true) return listed.has_more === false ? { kind: "none" } : { kind: "unknown" };
    const last = data[data.length - 1];
    if (!last || typeof last.id !== "string") return { kind: "unknown" };
    after = last.id;
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

const refundOf = (r: Row, earlier: boolean, ended: boolean): PlanRefundFlow => ({
  ok: true,
  cents: Number(r.amount) || 0,
  currency: typeof r.currency === "string" ? r.currency : "usd",
  refundId: String(r.id),
  status: r.status === "succeeded" ? "succeeded" : "pending",
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
      const result = refundOf(found.refund, made.reason !== "failed", await finish(found.settled));
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
 * taken back. Not decidable: tried again tomorrow, for GIVE_UP_DAYS. One failure never stops the rest.
 */
export async function finishPlanRefunds(deadline: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ ended: number; dropped: number; left: number }> {
  const counts = { ended: 0, dropped: 0, left: 0 };
  if (!isRedisConfigured() || !isBillingConfigured()) return counts;
  const [raw] = await redisPipeline([["HGETALL", ENDING_KEY]]);
  const flat = Array.isArray(raw) ? (raw as unknown[]) : [];
  const fields: [string, unknown][] = [];
  for (let i = 0; i + 1 < flat.length && fields.length < MAX_NOTES; i += 2) fields.push([String(flat[i]), flat[i + 1]]);
  counts.left = Math.max(0, flat.length / 2 - fields.length);
  for (const [sid, value] of fields) {
    if (Date.now() >= deadline) {
      counts.left += 1;
      continue;
    }
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
          const result = refundOf(found.refund, false, true);
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
        if (nowSeconds - note.at <= GIVE_UP_DAYS * 86_400) {
          counts.left += 1;
          continue;
        }
        // Undecidable for GIVE_UP_DAYS: the plan goes on as it was, never ended without a refund we can see.
        console.error(`plan-refund: the refund asked for store ${sid} could not be decided in ${GIVE_UP_DAYS} days; its stop is taken back and its note dropped`);
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
      // The creator saw "nothing was refunded" or "we check within a day": the outcome reaches them by email.
      await mail(store, planRefundNotMadeLetter({ store: store.name || store.handle, undecided: found.kind === "unknown" }), `plan-refund-none:${sid}:${note.at}`);
      counts.dropped += 1;
    } catch (error) {
      console.error(`plan-refund: the note for store ${sid} is not decided yet; tried again tomorrow`, error);
      counts.left += 1;
    } finally {
      await releaseLock(held);
    }
  }
  return counts;
}
