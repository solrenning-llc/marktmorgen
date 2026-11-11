/**
 * The creator's queue of orders made to order: 761 [STN8], unit 1 (owner's
 * Stan research, 9 November 2026). Pure and browser-safe: the rules only.
 * Nothing here is shown, sent or kept yet; the studio's queue, the buyer's
 * notice at each change (counted in the store's emails, reserved before the
 * send) and the refund offer use these in later units.
 *
 * A made-to-order product promises a production time in whole days
 * (MIN_PRODUCTION_DAYS to MAX_PRODUCTION_DAYS), shown before paying (518
 * [PF6]). From the payment, the order is due on the payment's second plus
 * those days. It moves through three stages, in words:
 *
 *   received → in production → delivered
 *
 *   - Forward only. A quick job may go from received straight to delivered;
 *     nothing goes back, because the buyer is told of each change and a
 *     notice cannot be taken back.
 *   - Late means past the date promised and not delivered. A delivered order
 *     is never late afterwards; whether it was delivered late is kept apart.
 *   - Once late, a refund is offered to the creator as a choice. This module
 *     only says so: the refund itself is always made on the creator's own
 *     Stripe account, with their confirmation, never by Marktmorgen and
 *     never on its own.
 *   - Unknown is never fine (rule 24): a kept order with any part this module
 *     would not write reads as null, never as a received order.
 */

export const MIN_PRODUCTION_DAYS = 1;
export const MAX_PRODUCTION_DAYS = 90;
const DAY_SECONDS = 86_400;

export type OrderStage = "received" | "in_production" | "delivered";

/** The stages in their order. */
export const STAGES: readonly OrderStage[] = ["received", "in_production", "delivered"];

/** Each stage in the studio's words, so a stage is always said, never shown by color alone. */
export const STAGE_LABELS: Record<OrderStage, string> = { received: "Received", in_production: "In production", delivered: "Delivered" };

export type OrderStep = { stage: OrderStage; at: number };

/** One order made to order: when it was paid, the days promised, and each stage it reached, in order. */
export type MadeOrder = { paidAt: number; days: number; steps: OrderStep[] };

/**
 * A time in seconds since 1970, below 10^11 (the year 5138): a time in
 * milliseconds (about 1.8 * 10^12 today) is not one, so a seconds and
 * milliseconds slip never reads as an order that is never late (Claude 3 on #3627).
 */
const MAX_SECONDS = 100_000_000_000;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value < MAX_SECONDS;
const isStage = (value: unknown): value is OrderStage => typeof value === "string" && (STAGES as readonly string[]).includes(value);

/**
 * The production time the creator promises, in whole days, or null. Not set,
 * 0, a fraction, words or past the longest are refused, never cut or given
 * a default: the buyer is told this date before paying.
 */
export function parseProductionDays(raw: unknown): number | null {
  const n = typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw.trim()) : raw;
  if (typeof n !== "number" || !Number.isInteger(n)) return null;
  return n >= MIN_PRODUCTION_DAYS && n <= MAX_PRODUCTION_DAYS ? n : null;
}

/** A paid order, received at its payment; null when the time or the days are not valid. */
export function startOrder(input: { paidAt: number; days: number }): MadeOrder | null {
  if (!isTime(input.paidAt) || parseProductionDays(input.days) === null) return null;
  return { paidAt: input.paidAt, days: input.days, steps: [{ stage: "received", at: input.paidAt }] };
}

/** The second the order is due: the payment plus the days promised. */
export function promisedBy(order: MadeOrder): number {
  return order.paidAt + order.days * DAY_SECONDS;
}

/** The stage the order is at now: its last step. */
export function stageOf(order: MadeOrder): OrderStage {
  return order.steps[order.steps.length - 1].stage;
}

/** When the order was delivered, or null while it is not. */
function deliveredAt(order: MadeOrder): number | null {
  const step = order.steps.find((s) => s.stage === "delivered");
  return step ? step.at : null;
}

/**
 * A kept order, whole or null: it starts as received no earlier than its
 * payment, each next step is a later stage at the same time or after, and
 * its production time is in range.
 */
export function parseMadeOrder(raw: unknown): MadeOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const { paidAt, days, steps } = raw as Record<string, unknown>;
  // Kept as startOrder writes it: the days as a number, never the creator's typed text.
  if (!isTime(paidAt) || typeof days !== "number" || parseProductionDays(days) === null || !Array.isArray(steps) || !steps.length) return null;
  const kept: OrderStep[] = [];
  for (const entry of steps) {
    if (!entry || typeof entry !== "object") return null;
    const { stage, at } = entry as Record<string, unknown>;
    if (!isStage(stage) || !isTime(at)) return null;
    const last = kept[kept.length - 1];
    if (!last ? stage !== "received" || at < paidAt : STAGES.indexOf(stage) <= STAGES.indexOf(last.stage) || at < last.at) return null;
    kept.push({ stage, at });
  }
  return { paidAt, days, steps: kept };
}

export type StageMove = { ok: true; order: MadeOrder } | { ok: false; reason: "same" | "backward" | "time" | "stage" };

/**
 * Moves an order to a later stage at `now`, as a new order; the one given is
 * left as it was. Refused: a stage that is not one, the stage it is at, an
 * earlier one, or a time before its last change.
 */
export function moveStage(order: MadeOrder, next: OrderStage, now: number): StageMove {
  if (!isStage(next)) return { ok: false, reason: "stage" };
  const current = stageOf(order);
  if (next === current) return { ok: false, reason: "same" };
  if (STAGES.indexOf(next) < STAGES.indexOf(current)) return { ok: false, reason: "backward" };
  if (!isTime(now) || now < order.steps[order.steps.length - 1].at) return { ok: false, reason: "time" };
  return { ok: true, order: { ...order, steps: [...order.steps, { stage: next, at: now }] } };
}

/** Past the date promised and not delivered. On the promised second itself it is not late yet. */
export function isLate(order: MadeOrder, now: number): boolean {
  return stageOf(order) !== "delivered" && now > promisedBy(order);
}

/** Whether it was delivered after the date promised; false while not delivered. */
export function deliveredLate(order: MadeOrder): boolean {
  const at = deliveredAt(order);
  return at !== null && at > promisedBy(order);
}

/**
 * Whole days until the date promised, counted up (a part of a day is a day),
 * negative when late, also counted up; null once delivered.
 */
export function daysLeft(order: MadeOrder, now: number): number | null {
  if (stageOf(order) === "delivered") return null;
  const remaining = promisedBy(order) - now;
  return remaining >= 0 ? Math.ceil(remaining / DAY_SECONDS) : -Math.ceil(-remaining / DAY_SECONDS);
}

/** Whether the creator is offered to refund: only while late and not delivered. The offer only; never a refund. */
export function refundOffered(order: MadeOrder, now: number): boolean {
  return isLate(order, now);
}

/**
 * The queue in the order the creator works it: orders not delivered first,
 * by the date promised (so the late ones lead), then by payment; delivered
 * ones after, the most recently delivered first. Returns a new list.
 */
export function sortQueue(orders: readonly MadeOrder[]): MadeOrder[] {
  return [...orders].sort((a, b) => {
    const da = deliveredAt(a);
    const db = deliveredAt(b);
    if (da === null && db === null) return promisedBy(a) - promisedBy(b) || a.paidAt - b.paidAt;
    if (da === null) return -1;
    if (db === null) return 1;
    return db - da || b.paidAt - a.paidAt;
  });
}

/** How many orders are at each stage, and how many of those not delivered are late. */
export function queueCounts(orders: readonly MadeOrder[], now: number): Record<OrderStage | "late", number> {
  const counts: Record<OrderStage | "late", number> = { received: 0, in_production: 0, delivered: 0, late: 0 };
  for (const order of orders) {
    counts[stageOf(order)] += 1;
    if (isLate(order, now)) counts.late += 1;
  }
  return counts;
}
