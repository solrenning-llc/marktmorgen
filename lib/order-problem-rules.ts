/**
 * "Report a problem with this order" (567 [GD1] (a), unit 1): the rules, pure.
 *
 * A buyer picks one of four reasons the owner listed (I did not get it; it is
 * not what was described; I cannot open it; something else), may add a note
 * in their own words, and names the order it is about. The case goes to the
 * creator's inbox (lib/inbox.ts, a later unit) with seven days to answer.
 * What happens when the seven days pass, and how unanswered cases count
 * against a store, are later units with their own rules.
 *
 * Nothing here reads, writes, sends or calls anything. A note that is too
 * long is refused, never cut, so the creator always reads the buyer's whole
 * words. An unknown time is unknown: it gives no due date and is never taken
 * as late or as on time.
 */
import { messageText } from "@/lib/inbox-rules";

export const ORDER_PROBLEM_REASONS = ["not_received", "not_as_described", "cannot_access", "other"] as const;
export type OrderProblemReason = (typeof ORDER_PROBLEM_REASONS)[number];

/** How many days the creator has to answer a case. */
export const ORDER_PROBLEM_REPLY_DAYS = 7;
/** The longest note a buyer may add, in characters. */
export const ORDER_PROBLEM_NOTE_MAX = 1_000;
/** "Something else" says nothing by itself: it needs at least this many characters of the buyer's own words. */
export const ORDER_PROBLEM_NOTE_MIN_OTHER = 10;

/**
 * The orders a buyer's list shows (lib/buyer-orders.ts, Purchase.reference):
 * a checkout, a one-click payment after it, or an order the creator brought
 * over from another platform (lib/imported-purchases.ts, IMPORTED_REFERENCE).
 */
export const ORDER_REFERENCE = /^(?:cs_(?:test|live)_[A-Za-z0-9]{10,200}|pi_[A-Za-z0-9]{10,200}|imp_[0-9a-f]{24})$/;

export type OrderProblem = { reason: OrderProblemReason; note: string; reference: string };

export type ReadProblem = { ok: true; problem: OrderProblem } | { ok: false; field: "reason" | "note" | "order" };

const DAY_MS = 86_400_000;
const REASON_SET: ReadonlySet<string> = new Set(ORDER_PROBLEM_REASONS);

/** The creator's words for each reason, in the studio's language (English). */
export const REASON_FOR_CREATOR: Record<OrderProblemReason, string> = {
  not_received: "I did not get it",
  not_as_described: "It is not what was described",
  cannot_access: "I cannot open it",
  other: "Something else",
};

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** What a buyer sent, checked field by field; the first field that is wrong is named. */
export function readOrderProblem(raw: unknown): ReadProblem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, field: "reason" };
  const value = raw as Record<string, unknown>;
  const reason = own(value, "reason") ? value.reason : undefined;
  if (typeof reason !== "string" || !REASON_SET.has(reason)) return { ok: false, field: "reason" };
  const rawNote = own(value, "note") ? value.note : undefined;
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string") return { ok: false, field: "note" };
  // Measured before cleaning, so a long note is refused rather than cut short.
  if (typeof rawNote === "string" && rawNote.length > ORDER_PROBLEM_NOTE_MAX) return { ok: false, field: "note" };
  const note = messageText(rawNote ?? "", ORDER_PROBLEM_NOTE_MAX);
  if (reason === "other" && note.length < ORDER_PROBLEM_NOTE_MIN_OTHER) return { ok: false, field: "note" };
  const order = own(value, "order") ? value.order : undefined;
  if (typeof order !== "string" || !ORDER_REFERENCE.test(order)) return { ok: false, field: "order" };
  return { ok: true, problem: { reason: reason as OrderProblemReason, note, reference: order } };
}

const knownMs = (ms: number) => Number.isFinite(ms) && ms >= 0 && ms < 8.64e15;

/** When the creator's answer is due, in milliseconds; null when the report's time is not known. */
export function replyDueAt(reportedAtMs: number): number | null {
  if (!knownMs(reportedAtMs)) return null;
  const due = reportedAtMs + ORDER_PROBLEM_REPLY_DAYS * DAY_MS;
  return knownMs(due) ? due : null;
}

/** Whether the answer is late; null when either time is not known. */
export function replyLate(dueAtMs: number, nowMs: number): boolean | null {
  if (!knownMs(dueAtMs) || !knownMs(nowMs)) return null;
  return nowMs >= dueAtMs;
}

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The case as the creator reads it in the inbox: the reason, the product,
 * when it was paid, the order, the buyer's words and when the answer is
 * due. What is not known is said as unknown. "" when the report's time is not
 * known, so no case is filed without a due date.
 */
export function caseText(problem: OrderProblem, purchase: { title: string; paidAt: number }, reportedAtMs: number): string {
  const due = replyDueAt(reportedAtMs);
  if (due === null) return "";
  const title = oneLine(typeof purchase.title === "string" ? purchase.title : "");
  const paidMs = Number.isFinite(purchase.paidAt) && purchase.paidAt > 0 ? purchase.paidAt * 1000 : NaN;
  const lines = [
    `Problem with an order: ${REASON_FOR_CREATOR[problem.reason]}.`,
    `Product: ${title || "unknown"}`,
    `Paid on: ${knownMs(paidMs) ? day(paidMs) : "unknown"}`,
    `Order: ${problem.reference}`,
    "",
  ];
  if (problem.note) lines.push(problem.note, "");
  lines.push(`Please answer by ${day(due)} (UTC). If you do not, the buyer is shown your contact details and your refund policy.`);
  return lines.join("\n");
}
