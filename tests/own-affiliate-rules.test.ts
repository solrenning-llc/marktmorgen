/**
 * 220 [HL1], unit 3: when Marktmorgen's own affiliate programme owes a
 * commission on one plan payment. Pure rules, wired to nothing, and off:
 * no percentage is in force (docs/marktmorgen-affiliates.md is a proposal).
 *
 * The item's rules, held here:
 *   - owed only after the payment succeeded and its 30 days of refund
 *     (REFUND_DAYS) have passed; before that, it waits;
 *   - on a refund, only what the customer kept earns; on any dispute, nothing;
 *   - what was already paid out and is no longer owed is taken back;
 *   - never on a self-referral: the same person, card, device or address;
 *     an unknown answer to any of those is unknown, never "not the same";
 *   - off while the programme is off or no rate is set; unreadable input is
 *     unknown, never zero and never owed.
 */
import { REFUND_DAYS } from "@/lib/plan";
import { OWN_AFFILIATES_ON, ownCommission, type OwnCommissionInput } from "@/lib/own-affiliate-rules";
import { done, is, part } from "./check";

const DAY = 86_400;
const PAID = 1_800_000_000;
const AFTER = PAID + REFUND_DAYS * DAY + 1;
const clean = { samePerson: false, sameCard: false, sameDevice: false, sameAddress: false };
const base: OwnCommissionInput = {
  programmeOn: true,
  rateBps: 1_000,
  succeeded: true,
  amountCents: 6_900,
  refundedCents: 0,
  disputed: false,
  paidAtSeconds: PAID,
  nowSeconds: AFTER,
  paidOutCents: 0,
  referral: clean,
};
const at = (change: Partial<OwnCommissionInput>) => ownCommission({ ...base, ...change });

part("Off until the owner decides");
is("the programme is off in code", OWN_AFFILIATES_ON, false);
is("programme off: nothing owed", at({ programmeOn: false }), { kind: "none", reason: "off" });
is("no rate set: nothing owed", at({ rateBps: null }), { kind: "none", reason: "no_rate" });

part("Owed only after payment and the refund window");
is("a payment that did not succeed earns nothing", at({ succeeded: false }), { kind: "none", reason: "not_paid" });
is("inside the 30 days, it waits until they pass", at({ nowSeconds: PAID + 5 * DAY }), { kind: "wait", untilSeconds: PAID + REFUND_DAYS * DAY });
is("on the last second of the window it still waits", at({ nowSeconds: PAID + REFUND_DAYS * DAY }).kind, "wait");
is("after them, the share of the price, rounded down", at({}), { kind: "owed", owedCents: 690, balanceCents: 690 });

part("Refunds and disputes");
is("a part refunded: only what was kept earns", at({ refundedCents: 2_900 }), { kind: "owed", owedCents: 400, balanceCents: 400 });
is("refunded in full: nothing", at({ refundedCents: 6_900 }), { kind: "none", reason: "refunded" });
is("any dispute: nothing", at({ disputed: true }), { kind: "none", reason: "disputed" });
is("refunded after being paid out: the difference is taken back", at({ refundedCents: 6_900, paidOutCents: 690 }), { kind: "take_back", takeBackCents: 690 });
is("disputed after being paid out: taken back", at({ disputed: true, paidOutCents: 690 }), { kind: "take_back", takeBackCents: 690 });
is("a part refunded after being paid out: only the difference", at({ refundedCents: 2_900, paidOutCents: 690 }), { kind: "take_back", takeBackCents: 290 });
is("already paid in full: nothing more", at({ paidOutCents: 690 }), { kind: "owed", owedCents: 690, balanceCents: 0 });

part("Never on a self-referral");
for (const key of ["samePerson", "sameCard", "sameDevice", "sameAddress"] as const) {
  is(`${key}: nothing`, at({ referral: { ...clean, [key]: true } }), { kind: "none", reason: "self_referral" });
  is(`${key} unknown: unknown, never owed`, at({ referral: { ...clean, [key]: null } }), { kind: "unknown", reason: "referral_unknown" });
}
is("a self-referral already paid out is taken back", at({ referral: { ...clean, sameCard: true }, paidOutCents: 690 }), { kind: "take_back", takeBackCents: 690 });

part("Unknown is never zero and never owed");
for (const [name, change] of [
  ["an amount that is not a whole number of cents", { amountCents: 69.5 }],
  ["a negative refund", { refundedCents: -1 }],
  ["a refund above the amount", { refundedCents: 7_000 }],
  ["a rate above 100%", { rateBps: 10_001 }],
  ["a negative rate", { rateBps: -1 }],
  ["a time that is not a number", { nowSeconds: Number.NaN }],
  ["a payout that is not a whole number", { paidOutCents: 1.5 }],
] as [string, Partial<OwnCommissionInput>][]) {
  is(`${name}: unknown`, at(change), { kind: "unknown", reason: "unreadable" });
}

done();
