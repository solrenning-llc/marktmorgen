/**
 * The reserve the platform's Stripe balance keeps for plan refunds and
 * disputes (306 [SY2] unit 1, lib/refund-reserve-rules.ts). Pure.
 *
 * What fails here: a reserve under what the published policy would give
 * back now; a dispute reserve missing for a charge still disputable, or kept
 * past its window; anything unknown turned into a number; a payout that
 * leaves the balance under the reserve; sales opened below it.
 */
import { done, is, part } from "./check";
import { DISPUTE_DAYS, disputeReserveCents, fullDisputeCents, payoutAbove, refundReserve, reserveCovered, type ReserveCharge } from "@/lib/refund-reserve-rules";
import { DISPUTE_COUNTER_FEE_CENTS, DISPUTE_FEE_CENTS } from "@/lib/receiving-costs";

const DAY = 86_400;
const NOW = Date.UTC(2026, 11, 2) / 1000;
/** One whole dispute on a $69 charge: the charge and both fees, read from lib/receiving-costs.ts. */
const D = 6_900 + DISPUTE_FEE_CENTS + DISPUTE_COUNTER_FEE_CENTS;
const month = (o: Partial<ReserveCharge> = {}): ReserveCharge => ({ currency: "usd", chargedCents: 6_900, paidAtSeconds: NOW - 3 * DAY, periodEndSeconds: NOW + 27 * DAY, refund: { kind: "guarantee", cents: 6_900 }, pendingRefundCents: 0, ...o });

part("What the policy would give back now, and the disputes");
is("a dispute reserve is 1% of the charge and both fees, rounded up", [disputeReserveCents(6_900), disputeReserveCents(1)], [99, 31]);
const one = refundReserve([month()], NOW);
is("a first payment inside the guarantee: all of it, and one whole dispute on it", one, { kind: "known", byCurrency: { usd: { refundCents: 6_900, pendingCents: 0, disputeCents: D, totalCents: 6_900 + D } } });
const yearly = month({ chargedCents: 69_000, periodEndSeconds: NOW + 300 * DAY, refund: { kind: "unstarted_months", cents: 47_000, monthsKept: 3 } });
const renewal = month({ refund: { kind: "none", reason: "renewal" } });
const both = refundReserve([yearly, renewal], NOW);
is("a yearly plan's months not started; the dispute part is one whole dispute on the largest charge", both.kind === "known" && both.byCurrency.usd, { refundCents: 47_000, pendingCents: 0, disputeCents: fullDisputeCents(69_000), totalCents: 47_000 + fullDisputeCents(69_000) });

part("The dispute window");
const old = (end: number) => refundReserve([month({ paidAtSeconds: NOW - 400 * DAY, periodEndSeconds: end, refund: { kind: "none", reason: "outside_window" } })], NOW);
is("past 120 days after its period ended: nothing kept", old(NOW - (DISPUTE_DAYS + 1) * DAY), { kind: "known", byCurrency: { usd: { refundCents: 0, pendingCents: 0, disputeCents: 0, totalCents: 0 } } });
is("a period that ended less than 120 days ago: still kept", old(NOW - (DISPUTE_DAYS - 1) * DAY).kind === "known" && (old(NOW - (DISPUTE_DAYS - 1) * DAY) as { byCurrency: Record<string, { disputeCents: number }> }).byCurrency.usd.disputeCents, D);

part("Review findings");
// A refund made for insufficient balance stays pending: Stripe already counts it in amount_refunded, so the rule owes nothing more,
// but its money has not left the balance yet.
const waiting = refundReserve([month({ refund: { kind: "none", reason: "already_refunded" }, pendingRefundCents: 6_900 })], NOW);
is("a pending refund's money stays in the reserve", waiting.kind === "known" && waiting.byCurrency.usd, { refundCents: 0, pendingCents: 6_900, disputeCents: D, totalCents: 6_900 + D });
is("and is not paid out", payoutAbove(6_900 + D, waiting, "usd"), 0);
const partly = refundReserve([month({ refund: { kind: "guarantee", cents: 4_900 }, pendingRefundCents: 2_000 })], NOW);
is("part refunded and pending, the rest owed: both kept", partly.kind === "known" && partly.byCurrency.usd.totalCents, 4_900 + 2_000 + D);
is("more pending and owed than was charged: unknown", refundReserve([month({ pendingRefundCents: 1 })], NOW).kind, "unknown");
const disputedOpen = refundReserve([month({ refund: { kind: "none", reason: "dispute_open" } })], NOW);
is("an open dispute: nothing owed by the policy, its dispute reserve kept", disputedOpen.kind === "known" && disputedOpen.byCurrency.usd, { refundCents: 0, pendingCents: 0, disputeCents: D, totalCents: D });
const exactly = refundReserve([month({ paidAtSeconds: NOW - 400 * DAY, periodEndSeconds: NOW - DISPUTE_DAYS * DAY, refund: { kind: "none", reason: "outside_window" } })], NOW);
is("on the 120th day the window is still open", exactly.kind === "known" && exactly.byCurrency.usd.disputeCents, D);

part("The owner's decision of 31/10/2026 15h41: the larger of the statistical sum and one whole dispute");
is("one whole dispute is the charge and both fees", fullDisputeCents(6_900), D);
const few = refundReserve([month({ refund: { kind: "none", reason: "renewal" } }), month({ chargedCents: 44_900, refund: { kind: "none", reason: "renewal" } })], NOW);
is("few charges: one whole dispute on the largest still disputable", few.kind === "known" && few.byCurrency.usd.disputeCents, fullDisputeCents(44_900));
const many = refundReserve(Array.from({ length: 200 }, () => month({ refund: { kind: "none", reason: "renewal" } })), NOW);
is("many charges: the statistical sum, once it is larger", many.kind === "known" && many.byCurrency.usd.disputeCents, 200 * disputeReserveCents(6_900));
const outOfWindow = refundReserve([month({ refund: { kind: "none", reason: "renewal" } }), month({ chargedCents: 99_900, paidAtSeconds: NOW - 400 * DAY, periodEndSeconds: NOW - (DISPUTE_DAYS + 1) * DAY, refund: { kind: "none", reason: "outside_window" } })], NOW);
is("the largest charge counts only while it can still be disputed", outOfWindow.kind === "known" && outOfWindow.byCurrency.usd.disputeCents, D);
const atEdge = refundReserve([month({ chargedCents: 99_900, paidAtSeconds: NOW - 400 * DAY, periodEndSeconds: NOW - DISPUTE_DAYS * DAY, refund: { kind: "none", reason: "outside_window" } })], NOW);
is("on the 120th day the largest charge still counts", atEdge.kind === "known" && atEdge.byCurrency.usd.disputeCents, fullDisputeCents(99_900));

part("Unknown is never a number");
is("a refund the rule cannot decide", refundReserve([month(), month({ refund: { kind: "unknown", reason: "split_payment" } })], NOW), { kind: "unknown", reason: "refund_unknown", index: 1 });
is("an amount that is not whole cents", refundReserve([month({ chargedCents: 69.5 })], NOW), { kind: "unknown", reason: "unreadable", index: 0 });
is("a refund larger than the charge", refundReserve([month({ refund: { kind: "guarantee", cents: 7_000 } })], NOW), { kind: "unknown", reason: "unreadable", index: 0 });
is("another currency than the fees'", refundReserve([month({ currency: "eur" })], NOW), { kind: "unknown", reason: "currency", index: 0 });
is("no charges: nothing to keep", refundReserve([], NOW), { kind: "known", byCurrency: {} });

part("Payouts and sales");
is("only what is above the reserve is paid out", payoutAbove(20_000, one, "usd"), 20_000 - 6_900 - D);
is("a balance under the reserve: nothing paid out", payoutAbove(5_000, one, "usd"), 0);
is("an unknown reserve: no payout at all", payoutAbove(1_000_000, { kind: "unknown", reason: "currency", index: 0 }, "usd"), null);
is("an unread balance: no payout", payoutAbove(null, one, "usd"), null);
is("sales open only when the balance covers the reserve", [reserveCovered({ usd: 6_900 + D }, one), reserveCovered({ usd: 6_899 + D }, one)], [true, false]);
is("sales closed when the balance or the reserve is unknown", [reserveCovered(null, one), reserveCovered({ usd: 1e9 }, { kind: "unknown", reason: "unreadable", index: 0 }), reserveCovered({}, one)], [false, false, false]);
done();
