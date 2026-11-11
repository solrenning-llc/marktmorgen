/**
 * 220 [HL1], unit 3b: the four self-referral signals for Marktmorgen's own
 * affiliate programme, from facts already read. Pure and off.
 *
 *   - the same person: the customer's and the affiliate's inbox, however it is
 *     written (lib/affiliates.ts canonicalEmail: case, "+" tags, Gmail dots);
 *   - the same card: the payment card's fingerprint among the affiliate's own;
 *   - the same device: the affiliate signed in on the browser that paid;
 *   - the same address: the payout address equal to the customer's inbox, or
 *     the billing address equal to the affiliate's own.
 * A fact not read is null, and its signal is null (unknown), never false.
 */
import { referralMatch } from "@/lib/own-affiliate-match";
import { done, is, part } from "./check";

const facts = {
  affiliateEmail: "Ana.Silva@gmail.com",
  customerEmail: "maker@example.com",
  affiliatePayoutEmail: "ana.pay@example.com",
  affiliateCardFingerprints: ["fp_aff1"] as string[] | null,
  paymentCardFingerprint: "fp_buyer" as string | null,
  affiliateSignedInOnPayingBrowser: false as boolean | null,
  affiliateBillingAddress: "1 Main St, Springfield, US" as string | null,
  customerBillingAddress: "9 Oak Ave, Portland, US" as string | null,
};
const clean = { samePerson: false, sameCard: false, sameDevice: false, sameAddress: false };

part("A real referral: four answers, all no");
is("different people", referralMatch(facts), clean);

part("The same person, however the inbox is written");
is("the same Gmail with dots and a tag", referralMatch({ ...facts, customerEmail: "anasilva+deals@googlemail.com" }).samePerson, true);
is("an empty or malformed customer inbox is unknown", referralMatch({ ...facts, customerEmail: "" }).samePerson, null);

part("The same card");
is("a fingerprint the affiliate also paid with", referralMatch({ ...facts, paymentCardFingerprint: "fp_aff1" }).sameCard, true);
is("the payment's card not read: unknown", referralMatch({ ...facts, paymentCardFingerprint: null }).sameCard, null);
is("the affiliate's cards not read: unknown", referralMatch({ ...facts, affiliateCardFingerprints: null }).sameCard, null);

part("The same device");
is("signed in on the browser that paid", referralMatch({ ...facts, affiliateSignedInOnPayingBrowser: true }).sameDevice, true);
is("not known: unknown", referralMatch({ ...facts, affiliateSignedInOnPayingBrowser: null }).sameDevice, null);

part("The same address");
is("paid out to the customer's own inbox", referralMatch({ ...facts, affiliatePayoutEmail: "MAKER@example.com" }).sameAddress, true);
is("the same billing address, spacing and case aside", referralMatch({ ...facts, customerBillingAddress: " 1 main st,  springfield, us " }).sameAddress, true);
is("a billing address not read: unknown", referralMatch({ ...facts, customerBillingAddress: null }).sameAddress, null);

done();
