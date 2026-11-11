/**
 * The four self-referral signals for Marktmorgen's own affiliate programme
 * (220 [HL1]), from facts the caller has already read. It reads nothing.
 * Off with the programme (lib/own-affiliate-rules.ts OWN_AFFILIATES_ON).
 *
 * The same person is the same inbox however it is written, by the rule the
 * creators' affiliates already use (lib/affiliates.ts canonicalEmail). A fact
 * that was not read is null, and its signal is null: unknown, never "not the
 * same", so ownCommission answers unknown rather than owed.
 */
import { EMAIL_PATTERN } from "@/lib/auth";
import { canonicalEmail } from "@/lib/affiliates";
import type { ReferralMatch } from "@/lib/own-affiliate-rules";

export type ReferralFacts = {
  affiliateEmail: string;
  customerEmail: string;
  /** Where the affiliate is paid (a PayPal or Wise inbox). */
  affiliatePayoutEmail: string;
  /** The card fingerprints the affiliate has paid with; null when not read. */
  affiliateCardFingerprints: string[] | null;
  /** The fingerprint of the card that paid; null when not read. */
  paymentCardFingerprint: string | null;
  /** Whether the affiliate was signed in on the browser that paid; null when not known. */
  affiliateSignedInOnPayingBrowser: boolean | null;
  affiliateBillingAddress: string | null;
  customerBillingAddress: string | null;
};

const inbox = (raw: string): string | null => {
  const email = canonicalEmail(typeof raw === "string" ? raw : "");
  return EMAIL_PATTERN.test(email) ? email : null;
};
const place = (raw: string | null): string | null => {
  if (typeof raw !== "string") return null;
  const tidy = raw.toLowerCase().replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim();
  return tidy || null;
};

export function referralMatch(facts: ReferralFacts): ReferralMatch {
  const affiliate = inbox(facts.affiliateEmail);
  const customer = inbox(facts.customerEmail);
  const payout = inbox(facts.affiliatePayoutEmail);
  const samePerson = affiliate && customer ? affiliate === customer : null;

  const cards = facts.affiliateCardFingerprints;
  const card = facts.paymentCardFingerprint;
  const sameCard = Array.isArray(cards) && typeof card === "string" && card ? cards.includes(card) : null;

  const sameDevice = typeof facts.affiliateSignedInOnPayingBrowser === "boolean" ? facts.affiliateSignedInOnPayingBrowser : null;

  const paidToCustomer = payout && customer ? payout === customer : null;
  const affiliatePlace = place(facts.affiliateBillingAddress);
  const customerPlace = place(facts.customerBillingAddress);
  const samePlace = affiliatePlace && customerPlace ? affiliatePlace === customerPlace : null;
  // Either one proven is enough; "no" needs both answered.
  const sameAddress = paidToCustomer === true || samePlace === true ? true : paidToCustomer === false && samePlace === false ? false : null;

  return { samePerson, sameCard, sameDevice, sameAddress };
}
