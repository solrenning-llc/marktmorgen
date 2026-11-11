/**
 * The creator's queue of orders made to order (761 [STN8], unit 1,
 * lib/made-to-order-rules.ts). Pure rules only; nothing is shown, sent or
 * kept yet. Checked: the production time the creator promises (whole days,
 * in range, anything else refused); the date promised from the payment; the
 * three stages, moved forward only, skipping allowed, never back; a kept
 * record read whole or not at all (rule 24); late only while not delivered;
 * the refund offer only as a signal for the creator, never a refund; the
 * queue's order by what is due first; the counts in words, never by color.
 */
import {
  MAX_PRODUCTION_DAYS,
  MIN_PRODUCTION_DAYS,
  STAGE_LABELS,
  type MadeOrder,
  daysLeft,
  deliveredLate,
  isLate,
  moveStage,
  parseMadeOrder,
  parseProductionDays,
  promisedBy,
  queueCounts,
  refundOffered,
  sortQueue,
  startOrder,
} from "@/lib/made-to-order-rules";
import { done, is, part } from "./check";

const DAY = 86_400;
const PAID = 1_800_000_000;

part("The production time the creator promises");
is("whole days", parseProductionDays(7), 7);
is("typed as text in the editor", parseProductionDays(" 14 "), 14);
is("the shortest", parseProductionDays(MIN_PRODUCTION_DAYS), 1);
is("the longest", parseProductionDays(MAX_PRODUCTION_DAYS), MAX_PRODUCTION_DAYS);
is("0 is refused: made to order takes time", parseProductionDays(0), null);
is("past the longest is refused, never cut", parseProductionDays(MAX_PRODUCTION_DAYS + 1), null);
is("a fraction is refused", parseProductionDays(1.5), null);
is("words are refused", parseProductionDays("a week"), null);
is("not set is refused, never read as a default", parseProductionDays(undefined), null);

part("A new order and the date promised");
const order = startOrder({ paidAt: PAID, days: 10 });
is("a paid order starts as received, at the payment", order, { paidAt: PAID, days: 10, steps: [{ stage: "received", at: PAID }] });
is("no order from a bad production time", startOrder({ paidAt: PAID, days: 0 }), null);
is("no order from a bad payment time", startOrder({ paidAt: 0, days: 10 }), null);
is("promised the payment plus the days", order ? promisedBy(order) : null, PAID + 10 * DAY);

part("Moving an order forward");
const making = order ? moveStage(order, "in_production", PAID + DAY) : null;
is("received to in production", making?.ok ? making.order.steps.map((s) => s.stage) : null, ["received", "in_production"]);
const made = making?.ok ? moveStage(making.order, "delivered", PAID + 5 * DAY) : null;
is("in production to delivered", made?.ok ? made.order.steps.map((s) => s.stage) : null, ["received", "in_production", "delivered"]);
const skipped = order ? moveStage(order, "delivered", PAID + 2 * DAY) : null;
is("received straight to delivered: a quick job skips a stage", skipped?.ok ? skipped.order.steps.map((s) => s.stage) : null, ["received", "delivered"]);
is("never back from delivered", made?.ok ? moveStage(made.order, "in_production", PAID + 6 * DAY) : null, { ok: false, reason: "backward" });
is("never back from in production", making?.ok ? moveStage(making.order, "received", PAID + 2 * DAY) : null, { ok: false, reason: "backward" });
is("the same stage again changes nothing", making?.ok ? moveStage(making.order, "in_production", PAID + 2 * DAY) : null, { ok: false, reason: "same" });
is("a time before the last change is refused", making?.ok ? moveStage(making.order, "delivered", PAID) : null, { ok: false, reason: "time" });
is("a stage that is not one is refused", order ? moveStage(order, "shipped" as never, PAID + DAY) : null, { ok: false, reason: "stage" });
is("moving never changes the order it was given", order?.steps.length, 1);

part("A kept order: read whole or not at all");
const kept = made?.ok ? made.order : null;
is("the order as written reads back the same", parseMadeOrder(JSON.parse(JSON.stringify(kept))), kept);
is("missing is not an order", parseMadeOrder(null), null);
is("no steps", parseMadeOrder({ paidAt: PAID, days: 10, steps: [] }), null);
// Claude 3 on #3627: only what startOrder writes reads back.
is("production days kept as text are not what this module writes", [parseMadeOrder({ paidAt: PAID, days: " 5 ", steps: [{ stage: "received", at: PAID }] }), parseMadeOrder({ paidAt: PAID, days: "5", steps: [{ stage: "received", at: PAID }] })], [null, null]);
is("a payment time in milliseconds is not a time in seconds: never an order that is never late", parseMadeOrder({ paidAt: PAID * 1000, days: 5, steps: [{ stage: "received", at: PAID * 1000 }] }), null);
is("a step time in milliseconds either", parseMadeOrder({ paidAt: PAID, days: 5, steps: [{ stage: "received", at: PAID }, { stage: "in_production", at: PAID * 1000 }] }), null);
is("and startOrder refuses one", startOrder({ paidAt: PAID * 1000, days: 5 }), null);
is("not starting as received", parseMadeOrder({ paidAt: PAID, days: 10, steps: [{ stage: "in_production", at: PAID }] }), null);
is("a step going back", parseMadeOrder({ paidAt: PAID, days: 10, steps: [{ stage: "received", at: PAID }, { stage: "delivered", at: PAID + DAY }, { stage: "in_production", at: PAID + 2 * DAY }] }), null);
is("a step before the payment", parseMadeOrder({ paidAt: PAID, days: 10, steps: [{ stage: "received", at: PAID - 1 }] }), null);
is("steps out of time order", parseMadeOrder({ paidAt: PAID, days: 10, steps: [{ stage: "received", at: PAID }, { stage: "in_production", at: PAID + 2 * DAY }, { stage: "delivered", at: PAID + DAY }] }), null);
is("a production time out of range", parseMadeOrder({ paidAt: PAID, days: MAX_PRODUCTION_DAYS + 1, steps: [{ stage: "received", at: PAID }] }), null);
is("an unknown stage", parseMadeOrder({ paidAt: PAID, days: 10, steps: [{ stage: "received", at: PAID }, { stage: "lost", at: PAID + 1 }] }), null);

part("Late, days left and the refund offer");
const open = making?.ok ? making.order : null;
const due = PAID + 10 * DAY;
is("on the promised second it is not late yet", open ? isLate(open, due) : null, false);
is("one second after it is late", open ? isLate(open, due + 1) : null, true);
is("a delivered order is never late, even long after", kept ? isLate(kept, due + 100 * DAY) : null, false);
is("days left, counted up", open ? daysLeft(open, due - DAY - 1) : null, 2);
is("days left on the last day", open ? daysLeft(open, due - 1) : null, 1);
is("on the promised second: 0 days left", open ? daysLeft(open, due) : null, 0);
is("a second late is a day late, counted up", open ? daysLeft(open, due + 1) : null, -1);
is("days late show as negative, counted up", open ? daysLeft(open, due + DAY + 1) : null, -2);
is("no days left once delivered", kept ? daysLeft(kept, PAID) : null, null);
is("delivered on time", kept ? deliveredLate(kept) : null, false);
const lateDelivery = open ? moveStage(open, "delivered", due + 1) : null;
is("delivered after the date promised", lateDelivery?.ok ? deliveredLate(lateDelivery.order) : null, true);
is("not delivered yet: not delivered late", open ? deliveredLate(open) : null, false);
is("a refund is offered only once it is late and not delivered", open ? [refundOffered(open, due), refundOffered(open, due + 1)] : null, [false, true]);
is("never offered once delivered", lateDelivery?.ok ? refundOffered(lateDelivery.order, due + 2 * DAY) : null, false);

part("The queue: what is due first, delivered last");
const make = (paidAt: number, days: number, stages: [MadeOrder["steps"][number]["stage"], number][] = []) => {
  let o = startOrder({ paidAt, days });
  for (const [stage, at] of stages) {
    const moved = o ? moveStage(o, stage, at) : null;
    o = moved?.ok ? moved.order : null;
  }
  if (!o) throw new Error("bad synthetic order");
  return o;
};
const NOW = PAID + 20 * DAY;
const late = make(PAID, 5); // due PAID + 5d: late
const soon = make(PAID + 15 * DAY, 7, [["in_production", PAID + 16 * DAY]]); // due PAID + 22d
const later = make(PAID + 18 * DAY, 30); // due PAID + 48d
const doneOld = make(PAID, 3, [["delivered", PAID + 2 * DAY]]);
const doneNew = make(PAID + DAY, 3, [["delivered", PAID + 3 * DAY]]);
const queue = sortQueue([doneOld, later, doneNew, soon, late]);
is("late first, then by the date promised, then delivered, newest first", queue.map((o) => o.paidAt), [late.paidAt, soon.paidAt, later.paidAt, doneNew.paidAt, doneOld.paidAt]);
is("sorting keeps the list it was given", [doneOld, later].map((o) => o.paidAt), [doneOld.paidAt, later.paidAt]);
is("counts by stage, with late apart", queueCounts([doneOld, later, doneNew, soon, late], NOW), { received: 2, in_production: 1, delivered: 2, late: 1 });

part("Stages in words, never by color alone");
is("each stage has its words", STAGE_LABELS, { received: "Received", in_production: "In production", delivered: "Delivered" });

done();
