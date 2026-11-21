/**
 * 306 [SY2] unit 2a: one charge on our own Stripe account, as read, turned
 * into what the reserve rule (lib/refund-reserve-rules.ts) counts.
 *
 *   - inside REFUND_DAYS of its payment, a plan charge is counted as the
 *     guarantee gives it (the whole payment, less what was refunded): whether
 *     it is the person's first is a reading across customers this unit does
 *     not make, and the guarantee is never less than what the policy owes;
 *   - later, the policy's own answer: a yearly payment's months not started,
 *     nothing for a monthly renewal;
 *   - the Store assistant's payments are not refunded (app/refunds/page.tsx,
 *     section 5a): only their dispute part is kept;
 *   - a refund made but still pending or waiting for an action is kept;
 *   - a refund list not read whole, a status this code does not know, a plan
 *     with no cycle: unknown, so the whole reserve is unknown;
 *   - a failed charge took nothing and is left out.
 *
 * Synthetic charges only; nothing calls Stripe.
 */
import { REFUND_DAYS } from "@/lib/plan";
import { type PlanRefundCharge, planRefund } from "@/lib/plan-refund-rules";
import { type ReserveRead, reserveChargeOf } from "@/lib/refund-reserve-charge";
import { DISPUTE_DAYS, disputeReserveCents, fullDisputeCents, refundReserve } from "@/lib/refund-reserve-rules";
import { done, is, part } from "./check";

const DAY = 86_400;
const NOW = 1_800_000_000;

const charge = (over: Partial<PlanRefundCharge> = {}): PlanRefundCharge => ({
  currency: "usd",
  succeeded: true,
  amountCents: 6_900,
  invoiceTotalCents: 6_900,
  billingReason: "subscription_create",
  refundedCents: 0,
  taxCents: 0,
  feeCents: 485,
  feeCurrency: "usd",
  paidAtSeconds: NOW - 5 * DAY,
  disputeStatus: null,
  disputedCents: null,
  ...over,
});

const read = (over: Partial<ReserveRead> = {}): ReserveRead => ({
  kind: "plan",
  status: "succeeded",
  cycle: "month",
  monthlyCents: null,
  periodStartSeconds: NOW - 5 * DAY,
  periodEndSeconds: NOW + 25 * DAY,
  refunds: [],
  charge: charge(),
  ...over,
});

part("A plan payment inside the guarantee's days");
{
  const one = reserveChargeOf(read(), NOW);
  is("it is counted", one !== null, true);
  is("at the whole payment", one?.refund, { kind: "guarantee", cents: 6_900 });
  is("what it captured is what a dispute could take", one?.chargedCents, 6_900);
  is("paid when Stripe says", one?.paidAtSeconds, NOW - 5 * DAY);
  is("its period end is kept for the dispute window", one?.periodEndSeconds, NOW + 25 * DAY);
  const renewal = reserveChargeOf(read({ charge: charge({ billingReason: "subscription_cycle" }) }), NOW);
  is("a renewal inside the days is counted at the whole payment too (the guarantee covers it when the first was within 30 days)", renewal?.refund, { kind: "guarantee", cents: 6_900 });
  const part1 = reserveChargeOf(read({ charge: charge({ refundedCents: 2_000 }), refunds: [{ status: "succeeded", amount: 2_000 }] }), NOW);
  is("less what was already refunded", part1?.refund, { kind: "guarantee", cents: 4_900 });
  const lastDay = reserveChargeOf(read({ charge: charge({ paidAtSeconds: NOW - REFUND_DAYS * DAY }) }), NOW);
  is("on the last day it is still the guarantee", lastDay?.refund.kind, "guarantee");
}

part("Never less than the policy owes, whoever's first payment it is");
{
  const cases: ReserveRead[] = [
    read(),
    read({ charge: charge({ billingReason: "subscription_cycle" }) }),
    read({ charge: charge({ billingReason: "subscription_update" }) }),
    read({ cycle: "year", monthlyCents: 6_900, charge: charge({ amountCents: 69_000, invoiceTotalCents: 69_000, feeCents: 4_580 }) }),
    read({ cycle: "year", monthlyCents: 6_900, charge: charge({ amountCents: 69_000, invoiceTotalCents: 69_000, feeCents: 4_580, billingReason: "subscription_cycle", paidAtSeconds: NOW - 20 * DAY }), periodStartSeconds: NOW - 20 * DAY }),
  ];
  for (const [i, r] of cases.entries()) {
    const counted = reserveChargeOf(r, NOW);
    const owed = (first: boolean) => {
      const p = planRefund({ cycle: r.cycle as "month" | "year", firstPayment: first, periodStartSeconds: r.periodStartSeconds, monthlyCents: r.monthlyCents, nowSeconds: NOW, charge: r.charge });
      return p.kind === "guarantee" || p.kind === "unstarted_months" ? p.cents : 0;
    };
    const kept = counted && (counted.refund.kind === "guarantee" || counted.refund.kind === "unstarted_months") ? counted.refund.cents : -1;
    is(`case ${i}: at least what is owed as a first payment`, kept >= owed(true), true);
    is(`case ${i}: at least what is owed as a later payment`, kept >= owed(false), true);
  }
}

part("After the guarantee's days: the policy's own answer");
{
  const later = NOW - (REFUND_DAYS + 1) * DAY;
  const renewal = reserveChargeOf(read({ charge: charge({ billingReason: "subscription_cycle", paidAtSeconds: later }), periodStartSeconds: later, periodEndSeconds: later + 30 * DAY }), NOW);
  is("a monthly payment gives nothing back", renewal?.refund.kind, "none");
  const yearStart = NOW - 100 * DAY;
  const yearly = reserveChargeOf(
    read({ cycle: "year", monthlyCents: 6_900, periodStartSeconds: yearStart, periodEndSeconds: yearStart + 365 * DAY, charge: charge({ amountCents: 69_000, invoiceTotalCents: 69_000, feeCents: 4_580, paidAtSeconds: yearStart }) }),
    NOW,
  );
  is("a yearly payment keeps its months not started", yearly?.refund.kind, "unstarted_months");
  is("as the refund button would give them", yearly?.refund, planRefund({ cycle: "year", firstPayment: false, periodStartSeconds: yearStart, monthlyCents: 6_900, nowSeconds: NOW, charge: charge({ amountCents: 69_000, invoiceTotalCents: 69_000, feeCents: 4_580, paidAtSeconds: yearStart }) }));
}

part("The Store assistant: not refunded, only its dispute part");
{
  const addOn = reserveChargeOf(read({ kind: "not-refunded", cycle: null, charge: charge({ amountCents: 6_900 }) }), NOW);
  is("counted, so a dispute on it is covered", addOn !== null, true);
  is("nothing to give back by the policy (section 5a)", addOn?.refund.kind, "none");
  is("a pending refund on it is still kept", reserveChargeOf(read({ kind: "not-refunded", cycle: null, refunds: [{ status: "pending", amount: 1_000 }] }), NOW)?.pendingRefundCents, 1_000);
}

part("Refunds made but not yet out of the balance");
{
  const pending = reserveChargeOf(read({ charge: charge({ refundedCents: 3_000 }), refunds: [{ status: "pending", amount: 1_000 }, { status: "requires_action", amount: 500 }, { status: "succeeded", amount: 1_500 }] }), NOW);
  is("pending and requires_action are kept", pending?.pendingRefundCents, 1_500);
  is("and the policy no longer owes what was refunded", pending?.refund, { kind: "guarantee", cents: 3_900 });
  const failed = reserveChargeOf(read({ refunds: [{ status: "failed", amount: 1_000 }, { status: "canceled", amount: 200 }] }), NOW);
  is("a failed or canceled refund is not kept", failed?.pendingRefundCents, 0);
}

part("What cannot be read is unknown, never zero");
{
  is("a refund list not read whole", reserveChargeOf(read({ refunds: null }), NOW)?.refund.kind, "unknown");
  is("a refund status this code does not know", reserveChargeOf(read({ refunds: [{ status: "in_review", amount: 100 }] }), NOW)?.refund.kind, "unknown");
  is("a refund amount that is not whole cents", reserveChargeOf(read({ refunds: [{ status: "pending", amount: 1.5 }] }), NOW)?.refund.kind, "unknown");
  is("a plan with no cycle", reserveChargeOf(read({ cycle: null }), NOW)?.refund.kind, "unknown");
  is("a charge still pending", reserveChargeOf(read({ status: "pending" }), NOW)?.refund.kind, "unknown");
  is("a status this code does not know", reserveChargeOf(read({ status: "weird" }), NOW)?.refund.kind, "unknown");
  is("a period that ends before it starts", reserveChargeOf(read({ periodEndSeconds: NOW - 10 * DAY }), NOW)?.refund.kind, "unknown");
  is("a period end that is not a number", reserveChargeOf(read({ periodEndSeconds: Number.NaN }), NOW)?.refund.kind, "unknown");
  const whole = refundReserve([reserveChargeOf(read(), NOW)!, reserveChargeOf(read({ refunds: null }), NOW)!], NOW);
  is("and one unknown charge makes the whole reserve unknown", whole.kind, "unknown");
}

part("What the policy cannot price yet is counted at its ceiling, never left unknown (Claude 3 on #3685, MEDIUM)");
{
  // The whole payment left is the most any refund can give back (lib/plan-refund-rules.ts: never more than was paid).
  const later = NOW - 40 * DAY;
  const switchYear = reserveChargeOf(
    read({ cycle: "year", monthlyCents: 6_900, periodStartSeconds: later, periodEndSeconds: later + 365 * DAY, charge: charge({ billingReason: "subscription_update", amountCents: 60_000, invoiceTotalCents: 60_000, paidAtSeconds: later }) }),
    NOW,
  );
  is("a switch to the yearly plan, after the guarantee's days: the whole payment", switchYear?.refund, { kind: "guarantee", cents: 60_000 });
  const split = reserveChargeOf(read({ charge: charge({ billingReason: "subscription_cycle", amountCents: 60_000, invoiceTotalCents: 69_000 }) }), NOW);
  is("a renewal paid partly by credit, inside the window: the whole payment", split?.refund, { kind: "guarantee", cents: 60_000 });
  const oddReason = reserveChargeOf(read({ charge: charge({ billingReason: "manual", paidAtSeconds: later }), periodStartSeconds: later, periodEndSeconds: later + 30 * DAY }), NOW);
  is("a billing reason the policy does not price: the whole payment", oddReason?.refund, { kind: "guarantee", cents: 6_900 });
  const partRefunded = reserveChargeOf(
    read({ cycle: "year", monthlyCents: 6_900, periodStartSeconds: later, periodEndSeconds: later + 365 * DAY, refunds: [{ status: "succeeded", amount: 10_000 }], charge: charge({ billingReason: "subscription_update", amountCents: 60_000, invoiceTotalCents: 60_000, refundedCents: 10_000, paidAtSeconds: later }) }),
    NOW,
  );
  is("a yearly switch less what was already refunded", partRefunded?.refund, { kind: "guarantee", cents: 50_000 });
  const reserve = refundReserve([switchYear!, split!], NOW);
  is("and the reserve stays known, holding both", [reserve.kind, reserve.kind === "known" ? reserve.byCurrency.usd.refundCents : -1], ["known", 120_000]);
  is("what is unreadable stays unknown", reserveChargeOf(read({ charge: charge({ amountCents: 1.5 }) }), NOW)?.refund.kind, "unknown");
}

part("The refund list must add up to what Stripe says was refunded (Claude 3 on #3685, LEVE)");
{
  is("a list short of amount_refunded is unknown, never a smaller pending sum", reserveChargeOf(read({ charge: charge({ refundedCents: 3_000 }), refunds: [{ status: "succeeded", amount: 1_500 }] }), NOW)?.refund.kind, "unknown");
  is("a list that adds up is read", reserveChargeOf(read({ charge: charge({ refundedCents: 3_000 }), refunds: [{ status: "succeeded", amount: 1_500 }, { status: "pending", amount: 1_500 }] }), NOW)?.refund, { kind: "guarantee", cents: 3_900 });
  is("failed and canceled refunds are not part of amount_refunded", reserveChargeOf(read({ charge: charge({ refundedCents: 0 }), refunds: [{ status: "failed", amount: 1_000 }, { status: "canceled", amount: 200 }] }), NOW)?.refund.kind, "guarantee");
}

part("A failed charge took nothing");
{
  is("it is left out", reserveChargeOf(read({ status: "failed", charge: charge({ succeeded: false, amountCents: 0 }) }), NOW), null);
}

part("Into the reserve");
{
  const old = NOW - (DISPUTE_DAYS + 40) * DAY;
  const charges = [
    reserveChargeOf(read(), NOW)!,
    reserveChargeOf(read({ kind: "not-refunded", cycle: null, charge: charge({ amountCents: 6_900 }) }), NOW)!,
    reserveChargeOf(read({ charge: charge({ billingReason: "subscription_cycle", paidAtSeconds: old }), periodStartSeconds: old, periodEndSeconds: old + 30 * DAY }), NOW)!,
  ];
  const reserve = refundReserve(charges, NOW);
  is("known", reserve.kind, "known");
  if (reserve.kind === "known") {
    const usd = reserve.byCurrency.usd;
    is("the guarantee is kept", usd.refundCents, 6_900);
    const statistical = 2 * disputeReserveCents(6_900);
    is("the dispute part is one whole dispute on the largest charge still disputable", usd.disputeCents, Math.max(statistical, fullDisputeCents(6_900)));
    is("a charge past its dispute window adds nothing", usd.totalCents, 6_900 + usd.disputeCents);
  }
}

done();
