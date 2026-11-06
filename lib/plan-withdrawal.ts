/**
 * The EU withdrawal function for a creator's own Marktmorgen plan (588 [KB9]
 * unit 3; Directive 2011/83/EU art. 11a, read in
 * docs/kb9-eu-withdrawal-2026-11-06.md). By the owner's decision a creator who
 * buys a plan is a consumer, and Marktmorgen is the trader: a plan is a
 * service, so the period is 14 days from its payment (lib/withdrawal-rules.ts,
 * withdrawalWindow: a sale, a membership).
 *
 * The payment's time and the refund come from the existing plan refund
 * (lib/plan-refund.ts readPlanRefund, lib/plan-refund-flow.ts
 * refundAndEndPlan); nothing here decides an amount. The function is offered:
 *   - under the money-back guarantee (kind "guarantee"), from the first payment
 *     it gives back, for 14 days (inside the guarantee's REFUND_DAYS, 30);
 *   - while the reading is unknown (Stripe not read), with no end: never hidden
 *     on a guess. A statement then is recorded and support is told.
 * Any other reading (refunded already, outside the window, a renewal, the
 * guarantee used before, months of a yearly plan, a trial with no payment) is
 * not offered: the existing flow gives no automatic full refund there, and a
 * refund it does not give is not invented here.
 *
 * On "Confirm withdrawal": the statement is recorded once per store and
 * subscription (PLAN_WITHDRAW_KEEP_DAYS), the receipt (art. 11a(4)) is
 * emailed from the company at most PLAN_WITHDRAW_ACK_SENDS times in all (a
 * statement made again after it did not go sends it again, with the first
 * statement's time), and, once per record, the full refund is asked of
 * refundAndEndPlan exactly as the refund route asks it, at the amount the
 * guarantee gives now. When it is not a guarantee, or the flow does not
 * refund, support is emailed once to handle it.
 *
 * Kept, under planWithdrawKey (the store's id and the subscription), a hash: the first
 * statement's time ("at", ms), receipts tried ("tries"), whether one went
 * ("sent") and whether the refund was taken in hand ("r"). The name and the
 * email are not kept: they travel in the receipt. Every read is exact
 * (CX-123): a reply that does not read is an error, never "not withdrawn".
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { EMAIL_PATTERN } from "@/lib/auth";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { PLAN_NAMES } from "@/lib/plan";
import { type PlanRefundReading, readPlanRefund } from "@/lib/plan-refund";
import { refundAndEndPlan } from "@/lib/plan-refund-flow";
import { PLAN_ACK_WORDS, supportNote } from "@/lib/plan-withdrawal-words";
import { type Store } from "@/lib/store";
import { type WithdrawalStatement, type WithdrawalWindow, acknowledgement, submittedInTime, withdrawalWindow } from "@/lib/withdrawal-rules";

/** How long the record of a plan withdrawal is kept, in days. */
export const PLAN_WITHDRAW_KEEP_DAYS = 400;
/** The most times one withdrawal's receipt is tried, in all. */
export const PLAN_WITHDRAW_ACK_SENDS = 3;

/** The record of a withdrawal from one store's plan subscription. */
export const planWithdrawKey = (sid: string, subscriptionId: string) => `nl:plan-withdraw:${sid}:${subscriptionId}`;

/** What the plan refund reading says about the withdrawal period now (see the file's comment). */
export function planWithdrawWindow(reading: PlanRefundReading | null, nowSeconds = Math.floor(Date.now() / 1000)): WithdrawalWindow {
  const facts = (paidAt: number) => withdrawalWindow({ kind: "sale", paidAt, member: true, givenByStore: false, consent: null }, nowSeconds);
  if (!reading || reading.refund.kind === "unknown") return facts(0);
  if (reading.refund.kind !== "guarantee" || !("parts" in reading) || !reading.parts.length) return { open: false, why: "not-here" };
  return facts(Math.min(...reading.parts.map((part) => part.paidAtSeconds)));
}

/** One plan withdrawal's record: the first statement (ms), receipts tried, whether one went, whether its refund was taken in hand. */
export type PlanWithdrawRecord = { at: number | null; tries: number; sent: boolean; refund: boolean };

async function readRecord(key: string): Promise<PlanWithdrawRecord> {
  const replies = repliesFor(await redisPipeline([["HMGET", key, "at", "tries", "sent", "r"]]), 1);
  const fields = replies?.[0];
  if (!Array.isArray(fields) || fields.length !== 4) throw new Error("a plan withdrawal record does not read");
  const [rawAt, rawTries, rawSent, rawRefund] = fields as unknown[];
  if (rawAt === null) {
    if (rawTries !== null || rawSent !== null || rawRefund !== null) throw new Error("a plan withdrawal record does not read");
    return { at: null, tries: 0, sent: false, refund: false };
  }
  const at = typeof rawAt === "string" && /^\d{1,16}$/.test(rawAt) ? Number(rawAt) : Number.NaN;
  const tries = rawTries === null ? 0 : typeof rawTries === "string" && /^\d{1,6}$/.test(rawTries) ? Number(rawTries) : Number.NaN;
  if (!Number.isSafeInteger(at) || at <= 0 || !Number.isSafeInteger(tries) || (rawSent !== null && rawSent !== "1") || (rawRefund !== null && rawRefund !== "1")) {
    throw new Error("a plan withdrawal record does not read");
  }
  return { at, tries, sent: rawSent === "1", refund: rawRefund === "1" };
}

/** This store's plan withdrawal record; throws when it cannot be read (never "not withdrawn" on a guess). */
export async function planWithdrawal(store: Pick<Store, "sid" | "subscriptionId">): Promise<PlanWithdrawRecord> {
  if (!store.sid || !store.subscriptionId || !isRedisConfigured()) throw new Error("plan withdrawals cannot be read");
  return readRecord(planWithdrawKey(store.sid, store.subscriptionId));
}

/**
 * What a statement did:
 *   - first taken in hand: "refunded" (given back and the plan ended),
 *     "ending" (given back or on its way, the plan ended by the daily job),
 *     "handled" (support was told to handle the refund);
 *   - made again: "resent" (the receipt went this time), "unsent" (it did not
 *     go again), "already" (it went before, or was tried the most times);
 *   - "closed": not inside the period; "error": nothing could be read or
 *     written as it must be.
 */
export type PlanWithdrawOutcome = "refunded" | "ending" | "handled" | "resent" | "unsent" | "already" | "closed" | "error";

const unknownReading: PlanRefundReading = { refund: { kind: "unknown", reason: "stripe_unread" } };

/** Records a creator's withdrawal from their plan, sends its receipt and asks the existing flow for the full refund. */
export async function withdrawFromPlan(store: Store, statement: WithdrawalStatement, nowMs = Date.now()): Promise<PlanWithdrawOutcome> {
  const sub = store.subscriptionId ?? "";
  if (!store.sid || !sub || statement.reference !== sub || !isRedisConfigured()) return "error";
  const key = planWithdrawKey(store.sid, sub);
  const nowSeconds = Math.floor(nowMs / 1000);
  let record: PlanWithdrawRecord;
  try {
    record = await readRecord(key);
  } catch {
    return "error";
  }
  let reading: PlanRefundReading | null = null;
  const readOnce = async (): Promise<PlanRefundReading> => (reading ??= await readPlanRefund(store, nowSeconds).catch(() => unknownReading));

  if (record.at === null) {
    // A first statement: in time only if submitted inside the period (art. 11a(5)). One recorded before keeps its time.
    if (!submittedInTime(planWithdrawWindow(await readOnce(), nowSeconds), nowSeconds)) return "closed";
    const written = repliesFor(await redisPipeline([["HSETNX", key, "at", String(nowMs)], ["EXPIRE", key, PLAN_WITHDRAW_KEEP_DAYS * 86_400]]), 2);
    const made = written ? countOf(written[0]) : null;
    if (made === null || made > 1 || countOf(written?.[1]) !== 1) return "error";
    if (made === 1) record = { at: nowMs, tries: 0, sent: false, refund: false };
    else {
      try {
        record = await readRecord(key);
      } catch {
        return "error";
      }
      if (record.at === null) return "error";
    }
  }
  const at = record.at as number;
  const ack = acknowledgement(statement, `${PLAN_NAMES[store.tier] ?? "Marktmorgen"} for ${store.name || store.handle}`, "Marktmorgen", at, PLAN_ACK_WORDS);

  // The receipt: each try counted before it is made, so none is ever tried past the ceiling.
  let receipt: "sent" | "unsent" | "before" = "before";
  if (!record.sent && record.tries < PLAN_WITHDRAW_ACK_SENDS) {
    const counted = repliesFor(await redisPipeline([["HINCRBY", key, "tries", 1]]), 1);
    const tries = counted ? countOf(counted[0]) : null;
    if (tries === null || tries < 1) return "error";
    if (tries <= PLAN_WITHDRAW_ACK_SENDS) {
      const sent = await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: statement.email, replyTo: SUPPORT_EMAIL, subject: ack.subject, text: ack.text }).catch(() => false);
      receipt = sent ? "sent" : "unsent";
      if (sent) {
        const marked = repliesFor(await redisPipeline([["HSET", key, "sent", "1"]]).catch(() => null), 1);
        if (!marked || countOf(marked[0]) === null) console.error("a plan withdrawal's receipt went but could not be marked sent");
      }
    }
  }
  const again = receipt === "sent" ? "resent" : receipt === "unsent" ? "unsent" : "already";
  if (record.refund) return again;

  // The refund, taken in hand once per record: only the request that claims it asks for it.
  const claimed = repliesFor(await redisPipeline([["HSETNX", key, "r", "1"]]).catch(() => null), 1);
  const claim = claimed ? countOf(claimed[0]) : null;
  if (claim === 0) return again;
  const tell = async (why: string): Promise<PlanWithdrawOutcome> => {
    const note = supportNote({ store: store.name || store.handle, sid: store.sid, subscription: sub, when: ack.when, email: statement.email, why });
    const told = EMAIL_PATTERN.test(SUPPORT_EMAIL)
      ? await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: SUPPORT_EMAIL, subject: note.subject, text: note.text, idempotencyKey: `plan-withdraw-support:${store.sid}:${sub}` }).catch(() => false)
      : false;
    if (!told) console.error(`plan-withdraw: support was not told about store ${store.sid}'s withdrawal (${why})`);
    return "handled";
  };
  // Whether another request took it cannot be read: support is told (the same key, so never twice in a day), never a second refund.
  if (claim !== 1) return tell("the refund claim did not read");
  const now = await readOnce();
  if (now.refund.kind !== "guarantee" || !("parts" in now)) return tell(`the refund reading is ${now.refund.kind} (${"reason" in now.refund ? now.refund.reason : "no reason"})`);
  try {
    const flow = await refundAndEndPlan(store, nowSeconds, now.refund.cents);
    if (flow.ok) return flow.ended ? "refunded" : "ending";
    return tell(`the refund flow answered ${flow.reason}${flow.stopLeft ? " (its note and stop are left for the daily job)" : ""}`);
  } catch (error) {
    console.error("plan-withdraw: the refund flow failed part way", error);
    return tell("the refund flow failed part way (a note left before any money moved is finished by the daily job)");
  }
}
