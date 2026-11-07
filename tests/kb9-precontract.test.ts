/**
 * The EU withdrawal function's pre-contract information (queue item 588
 * [KB9], unit 2, added 6 November 2026; Directive 2011/83/EU art. 6(1)(h)
 * and Annex I instruction 3 as amended by Directive (EU) 2023/2673, read in
 * docs/kb9-eu-withdrawal-2026-11-06.md, "Proposed units", item 2).
 *
 * The buyer is told, before and after the contract, where the online
 * withdrawal function is ("information about the existence and placement of
 * the withdrawal function referred to in Article 11a"). Checked:
 *
 *   - the membership box's sentence, in every buyer language, names the
 *     function by its own label (lib/buyer-words/withdrawal.ts, withdrawLink)
 *     and says it is on the buyer's list of purchases; the digital box does
 *     not, because its own yes closes the function at payment for everything
 *     but a pre-order; the sentence is quoted back in the email, so
 *     its version (EU_WITHDRAWAL_CONSENT_VERSION) moves past "2026-10-30.2"
 *     with the words, as lib/digital-consent.ts requires;
 *   - the order confirmation email (lib/purchase-email.ts, confirmationFor,
 *     called here with synthetic data) of an order still inside its
 *     withdrawal period carries the label in the store's language beside a
 *     link to the store's /orders list or /orders/withdraw page; one with no
 *     right left (digital content whose buyer gave the art. 16(m) yes, already
 *     handed over) carries neither.
 *
 * Synthetic store and orders only; no email is sent and Stripe is never
 * reached (any call is answered 404).
 *
 * The second check (the confirmation email) waits in
 * tests/kb9-precontract-email.pending.ts, unit 2b's RED: it reads
 * lib/purchase-email.ts, built in its own unit. This file holds the first.
 */
import { DIGITAL_CONSENT_WORDS } from "@/lib/buyer-words/digital-consent";
import { WITHDRAWAL_WORDS, withdrawalWords } from "@/lib/buyer-words/withdrawal";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import { consentEmailLines } from "@/lib/digital-consent-email";
import { WITHDRAW_FROM_CONTRACT, withdrawalWindow } from "@/lib/withdrawal-rules";
import { done, is, part } from "./check";

const LANGUAGES = ["en", "es", "fr", "de", "it", "nl", "pt"] as const;

function main(): void {
  part("The box says where the withdrawal function is (art. 6(1)(h), Annex I instruction 3)");
  is("the label in English is the law's own words", WITHDRAWAL_WORDS.en.withdrawLink, WITHDRAW_FROM_CONTRACT);
  // Changed assertion, noted (Claude 5's MEDIUM on #2953): the digital box no longer names the function. Its own "yes"
  // closes the function at payment for everything that is not a pre-order (lib/withdrawal-rules.ts, withdrawalWindow),
  // so for the typical buyer the sentence pointed at something already shut. The membership box still names it.
  is(
    "membership: every language's sentence names the function by its label, in that language",
    LANGUAGES.map((lang) => [lang, DIGITAL_CONSENT_WORDS[lang].box.membership.includes(withdrawalWords(lang).withdrawLink)]),
    LANGUAGES.map((lang) => [lang, true]),
  );
  is(
    "digital: no language's sentence names a function that its own yes closes at payment",
    LANGUAGES.map((lang) => [lang, DIGITAL_CONSENT_WORDS[lang].box.digital.includes(withdrawalWords(lang).withdrawLink)]),
    LANGUAGES.map((lang) => [lang, false]),
  );
  // Claude 5's proof on #2953, kept: a digital "yes" that is not a pre-order leaves no function open, at payment or after.
  {
    const PAID = 1_800_000_000;
    const facts = { kind: "sale", paidAt: PAID, member: false, givenByStore: false, consent: { version: EU_WITHDRAWAL_CONSENT_VERSION, at: PAID - 30, kind: "digital" } } as Parameters<typeof withdrawalWindow>[0];
    is("a digital yes, not a pre-order: the function is closed at payment and a minute later", [withdrawalWindow(facts, PAID).open, withdrawalWindow(facts, PAID + 60).open], [false, false]);
  }
  // Where it is: the buyer's list of purchases, in each language's word for it.
  const listWord: Record<(typeof LANGUAGES)[number], RegExp> = {
    en: /purchases/i,
    es: /compras/i,
    fr: /achats/i,
    de: /Käufe|Bestellungen/i,
    it: /acquisti/i,
    nl: /aankopen|bestellingen/i,
    pt: /compras|encomendas/i,
  };
  is(
    "and the membership box says it is on the buyer's list of purchases",
    LANGUAGES.map((lang) => [lang, listWord[lang].test(DIGITAL_CONSENT_WORDS[lang].box.membership)]),
    LANGUAGES.map((lang) => [lang, true]),
  );
  is("the sentence changed, so its version moved past the one buyers saw before", EU_WITHDRAWAL_CONSENT_VERSION !== "2026-10-30.2", true);

  part("An order kept with the words before still quotes those words");
  const quoted = (dc: string) => consentEmailLines({ language: "en", currency: "usd" }, { dc }).join("\n");
  const before = quoted("yes:2026-10-30.2:d:1790000000");
  is(
    "2026-10-30.2: the sentence that buyer checked, with its version, and not today's",
    [before.includes("“Start my access before the 14-day cancellation period ends, as soon as it is available. I understand that once access starts, I lose my right to cancel.” (wording 2026-10-30.2)"), before.includes(WITHDRAWAL_WORDS.en.withdrawLink)],
    [true, false],
  );
  const today = quoted(`yes:${EU_WITHDRAWAL_CONSENT_VERSION}:m:1790000000`);
  is("today's version: today's sentence, with the label", [today.includes(`“${DIGITAL_CONSENT_WORDS.en.box.membership}” (wording ${EU_WITHDRAWAL_CONSENT_VERSION})`), today.includes(WITHDRAWAL_WORDS.en.withdrawLink)], [true, true]);

  done();
}

main();
