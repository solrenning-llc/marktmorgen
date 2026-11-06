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
 *   - the checkout box's sentence, in every buyer language and for both kinds
 *     (digital, membership), names the function by its own label
 *     (lib/buyer-words/withdrawal.ts, withdrawLink) and says it is on the
 *     buyer's list of purchases; the sentence is quoted back in the email, so
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
import { WITHDRAW_FROM_CONTRACT } from "@/lib/withdrawal-rules";
import { done, is, part } from "./check";

const LANGUAGES = ["en", "es", "fr", "de", "it", "nl", "pt"] as const;

function main(): void {
  part("The box says where the withdrawal function is (art. 6(1)(h), Annex I instruction 3)");
  is("the label in English is the law's own words", WITHDRAWAL_WORDS.en.withdrawLink, WITHDRAW_FROM_CONTRACT);
  for (const kind of ["digital", "membership"] as const) {
    is(
      `${kind}: every language's sentence names the function by its label, in that language`,
      LANGUAGES.map((lang) => [lang, DIGITAL_CONSENT_WORDS[lang].box[kind].includes(withdrawalWords(lang).withdrawLink)]),
      LANGUAGES.map((lang) => [lang, true]),
    );
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
    "and says it is on the buyer's list of purchases",
    LANGUAGES.map((lang) => [lang, (["digital", "membership"] as const).every((kind) => listWord[lang].test(DIGITAL_CONSENT_WORDS[lang].box[kind]))]),
    LANGUAGES.map((lang) => [lang, true]),
  );
  is("the sentence changed, so its version moved past the one buyers saw before", EU_WITHDRAWAL_CONSENT_VERSION !== "2026-10-30.2", true);

  done();
}

main();
