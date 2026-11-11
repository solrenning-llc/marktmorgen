/**
 * Marktmorgen's own affiliate programme (220 [HL1]): when a commission is owed
 * on one plan payment. Pure: it reads nothing, writes nothing, pays nothing.
 *
 * It is off. No percentage is in force: docs/marktmorgen-affiliates.md is a
 * proposal, and the cost of paying an affiliate abroad is still unknown, so
 * the owner decides the rate, and whether there is a programme at all.
 *
 * The rules (queue item 220):
 *   - owed only after the payment succeeded and its REFUND_DAYS of money-back
 *     have passed; until then it waits;
 *   - on a refund only what the customer kept earns; on any dispute nothing;
 *   - what was paid out and is no longer owed is taken back;
 *   - never on a self-referral (the same person, card, device or address);
 *     an unknown answer to any of them is unknown, never "not the same";
 *   - unreadable input is unknown: never zero and never owed (rule 24).
 */
import { REFUND_DAYS } from "@/lib/plan";

/** Off until the owner decides a rate and turns the programme on. */
export const OWN_AFFILIATES_ON = false;

const DAY_SECONDS = 86_400;

/** Each answer is true (the same), false (checked, not the same) or null (could not be told). */
export type ReferralMatch = {
  samePerson: boolean | null;
  sameCard: boolean | null;
  sameDevice: boolean | null;
  sameAddress: boolean | null;
};

export type OwnCommissionInput = {
  programmeOn: boolean;
  /** The share of the price, in basis points; null while no rate is set. */
  rateBps: number | null;
  succeeded: boolean;
  /** The plan's price on this payment, without the buyer's tax on top. */
  amountCents: number;
  refundedCents: number;
  /** Any dispute on this payment, open or closed. */
  disputed: boolean;
  paidAtSeconds: number;
  nowSeconds: number;
  /** What was already paid to the affiliate for this payment. */
  paidOutCents: number;
  referral: ReferralMatch;
};

export type OwnCommission =
  | { kind: "owed"; owedCents: number; balanceCents: number }
  | { kind: "wait"; untilSeconds: number }
  | { kind: "take_back"; takeBackCents: number }
  | { kind: "none"; reason: "off" | "no_rate" | "not_paid" | "refunded" | "disputed" | "self_referral" }
  | { kind: "unknown"; reason: "unreadable" | "referral_unknown" };

const wholeCents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** What one plan payment owes its affiliate now. */
export function ownCommission(input: OwnCommissionInput): OwnCommission {
  if (!input.programmeOn) return { kind: "none", reason: "off" };
  if (input.rateBps === null) return { kind: "none", reason: "no_rate" };
  if (!Number.isSafeInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10_000 ||
      !wholeCents(input.amountCents) || !wholeCents(input.refundedCents) || input.refundedCents > input.amountCents ||
      !wholeCents(input.paidOutCents) || !Number.isFinite(input.paidAtSeconds) || !Number.isFinite(input.nowSeconds)) {
    return { kind: "unknown", reason: "unreadable" };
  }
  // Whatever stops the commission also takes back what was paid out for it.
  const stop = (reason: "not_paid" | "refunded" | "disputed" | "self_referral"): OwnCommission =>
    input.paidOutCents > 0 ? { kind: "take_back", takeBackCents: input.paidOutCents } : { kind: "none", reason };

  if (!input.succeeded) return stop("not_paid");
  const answers = [input.referral.samePerson, input.referral.sameCard, input.referral.sameDevice, input.referral.sameAddress];
  if (answers.some((answer) => answer === true)) return stop("self_referral");
  if (answers.some((answer) => answer !== false)) return { kind: "unknown", reason: "referral_unknown" };
  if (input.disputed) return stop("disputed");
  const kept = input.amountCents - input.refundedCents;
  if (kept <= 0) return stop("refunded");

  const owedCents = Math.floor((kept * input.rateBps) / 10_000);
  if (input.paidOutCents > owedCents) return { kind: "take_back", takeBackCents: input.paidOutCents - owedCents };
  const windowEnds = input.paidAtSeconds + REFUND_DAYS * DAY_SECONDS;
  if (input.nowSeconds <= windowEnds) return { kind: "wait", untilSeconds: windowEnds };
  return { kind: "owed", owedCents, balanceCents: owedCents - input.paidOutCents };
}
