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
 *     not, and keeps exactly its published 2026-10-30.2 words (Claude 5's
 *     second review of #2953); the sentence is quoted back in the email, so
 *     its version (EU_WITHDRAWAL_CONSENT_VERSION) moves past "2026-10-30.2"
 *     with the words, as lib/digital-consent.ts requires;
 *   - one plain conditional line (checkoutWhere, components/withdrawal-where.tsx),
 *     outside both sentences, says where the function is: drawn by every
 *     consent box and, where there is none (a shipped item, a cart of shipped
 *     items only), in its place in the checkout form;
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
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DIGITAL_CONSENT_WORDS } from "@/lib/buyer-words/digital-consent";
import { WITHDRAWAL_WORDS, withdrawalWords } from "@/lib/buyer-words/withdrawal";
import { type ConsentKind, EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
import * as consentEmail from "@/lib/digital-consent-email";
import { consentEmailLines } from "@/lib/digital-consent-email";
import { WITHDRAW_FROM_CONTRACT, withdrawalWindow } from "@/lib/withdrawal-rules";
import { DigitalConsentBox } from "@/components/digital-consent-box";
import { BuyBox } from "@/components/store-product";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setProductShipping, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const LANGUAGES = ["en", "es", "fr", "de", "it", "nl", "pt"] as const;

async function main(): Promise<void> {
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
  // Claude 5's proof on #2953, kept: a digital "yes" that is not a pre-order, with its confirmation known sent (art.
  // 16(m)(iii), #2827), leaves no function open, at payment or after.
  {
    const PAID = 1_800_000_000;
    const facts = { kind: "sale", paidAt: PAID, member: false, givenByStore: false, consent: { version: EU_WITHDRAWAL_CONSENT_VERSION, at: PAID - 30, kind: "digital" }, confirmed: true } as Parameters<typeof withdrawalWindow>[0];
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

  part("The digital box keeps the words buyers saw on 2026-10-30.2 (Claude 5's second MEDIUM on #2953)");
  // The art. 16(m) sentence is what ends the right; the shortened one lost "as soon as it is available" (the pre-order),
  // used "damit erlischt" against § 356 BGB's "mit Beginn", and left "nesse momento" / "dan" / "alors" ambiguous.
  const published = (consentEmail as unknown as { BOX_2026_10_30_2?: Partial<Record<(typeof LANGUAGES)[number], Record<ConsentKind, string>>> }).BOX_2026_10_30_2;
  is(
    "every language's digital sentence is exactly the published 2026-10-30.2 one",
    LANGUAGES.map((lang) => [lang, DIGITAL_CONSENT_WORDS[lang].box.digital === published?.[lang]?.digital]),
    LANGUAGES.map((lang) => [lang, true]),
  );
  is(
    "and an order kept with 2026-10-30.2 quotes, in every language, the same digital sentence the box shows today",
    LANGUAGES.map((lang) => [lang, consentEmailLines({ language: lang, currency: "usd" }, { dc: "yes:2026-10-30.2:d:1790000000" }).join("\n").includes(DIGITAL_CONSENT_WORDS[lang].box.digital)]),
    LANGUAGES.map((lang) => [lang, true]),
  );
  is("French: the box's quotation marks are guillemets, as in the rest of the French words", [/[“”]/.test(DIGITAL_CONSENT_WORDS.fr.box.digital), /[“”]/.test(DIGITAL_CONSENT_WORDS.fr.box.membership), DIGITAL_CONSENT_WORDS.fr.box.membership.includes(`« ${WITHDRAWAL_WORDS.fr.withdrawLink} »`)], [false, false, true]);

  part("The checkout says where the withdrawal function is, outside the box's sentence (Claude 5's first MEDIUM on #2953)");
  // Art. 6(1)(h): before the contract, for every purchase that has the function here (a pre-order, a digital order whose
  // confirmation is not known sent, a membership, a shipped item). One plain line, conditional, so it never promises the
  // right to a buyer whose yes closes it at payment; outside the marked sentence, so not in its 220 characters, its
  // version or its fingerprint.
  const LINE: Record<(typeof LANGUAGES)[number], string> = {
    en: "You can withdraw online with ‘Withdraw from contract here’ on your purchases page, while you have that right.",
    es: "Puedes desistir en línea con “Desistir del contrato aquí” en tus compras, mientras tengas ese derecho.",
    fr: "Vous pouvez vous rétracter en ligne avec « Se rétracter du contrat ici » dans vos achats, tant que vous disposez de ce droit.",
    de: "Sie können online mit ‚Vertrag hier widerrufen‘ unter Ihren Käufen widerrufen, solange Ihnen dieses Recht zusteht.",
    it: "Puoi recedere online con “Recedi dal contratto qui” nei tuoi acquisti, finché hai questo diritto.",
    nl: "Je kunt online herroepen met ‘Overeenkomst hier herroepen’ bij je aankopen, zolang je dat recht hebt.",
    pt: "Pode desistir do contrato online com “Desistir do contrato aqui” nas suas compras, enquanto tiver esse direito.",
  };
  const whereOf = (lang: (typeof LANGUAGES)[number]) => (withdrawalWords(lang) as unknown as { checkoutWhere?: string }).checkoutWhere;
  is("the line, in every language, is the withdrawal words' own", LANGUAGES.map((lang) => [lang, whereOf(lang)]), LANGUAGES.map((lang) => [lang, LINE[lang]]));
  is(
    "it names the function by the label its purchases page shows, in that language (in English, the law's own words)",
    [LINE.en.includes(`‘${WITHDRAW_FROM_CONTRACT}’`), ...LANGUAGES.map((lang) => LINE[lang].includes(withdrawalWords(lang).withdrawLink))],
    [true, ...LANGUAGES.map(() => true)],
  );
  is("and says where: the buyer's list of purchases", LANGUAGES.map((lang) => [lang, listWord[lang].test(LINE[lang])]), LANGUAGES.map((lang) => [lang, true]));
  is(
    "it is not in either marked sentence, in any language",
    LANGUAGES.map((lang) => [lang, DIGITAL_CONSENT_WORDS[lang].box.digital.includes(LINE[lang]), DIGITAL_CONSENT_WORDS[lang].box.membership.includes(LINE[lang])]),
    LANGUAGES.map((lang) => [lang, false, false]),
  );
  const KINDS: ConsentKind[] = ["digital", "membership"];
  const labelOf = (html: string) => html.slice(html.indexOf("<label"), html.indexOf("</label>") + "</label>".length);
  const boxes = LANGUAGES.flatMap((lang) => KINDS.map((kind) => [lang, kind, renderToStaticMarkup(createElement(DigitalConsentBox, { id: `dc-${lang}-${kind}`, lang, kind }))] as const));
  is(
    "every box (digital and membership, every language) draws the line once, outside its label",
    boxes.map(([lang, kind, html]) => [lang, kind, html.split(LINE[lang]).length - 1, labelOf(html).includes(LINE[lang])]),
    boxes.map(([lang, kind]) => [lang, kind, 1, false]),
  );

  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_kb9_precontract_only";
  const OWNER = "kb9where@example.com";
  await claimHandle(OWNER, "kb9where", "Where Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestKb9Where01", true);
  await setSubscription(OWNER, { customerId: "cus_Kb9Where001", subscriptionId: "sub_Kb9Where001", active: true, period: paidPeriod() });
  const mug = await addProduct(OWNER, "Clay mug", "", "30", null);
  const pack = await addProduct(OWNER, "Recipe pack", "", "27", null);
  if (!mug.ok || !pack.ok) throw new Error("no products");
  const shippedSet = await setProductShipping(OWNER, mug.product.id, { cents: 600, region: "eu", countries: [], note: "" });
  await setProductLink(OWNER, pack.product.id, "https://example.com/pack");
  const shop = (await storeForEmail(OWNER))!;
  const shipped = (await readListing(shop, mug.product.id))!;
  const digital = (await readListing(shop, pack.product.id))!;
  is("a shipped product is set up", [shippedSet.ok, Boolean(shipped.shipping)], [true, true]);
  const buyBox = (lang: (typeof LANGUAGES)[number], product: typeof shipped) =>
    renderToStaticMarkup(createElement(BuyBox, { store: { ...shop, language: lang as typeof shop.language }, product, related: [], remaining: null, writes: false, selling: true }));
  const formOf = (html: string) => html.slice(html.indexOf("data-checkout"), html.indexOf("</form>"));
  is(
    "a shipped item's buy box (no box to check) draws the line once, in its checkout form, in every language",
    LANGUAGES.map((lang) => {
      const html = buyBox(lang, shipped);
      return [lang, html.includes('data-digital-consent=""'), html.split(LINE[lang]).length - 1, formOf(html).includes(LINE[lang])];
    }),
    LANGUAGES.map((lang) => [lang, false, 1, true]),
  );
  is(
    "a digital product's buy box draws it once too, with its box, never twice",
    LANGUAGES.map((lang) => {
      const html = buyBox(lang, digital);
      return [lang, html.includes('data-digital-consent=""'), html.split(LINE[lang]).length - 1];
    }),
    LANGUAGES.map((lang) => [lang, true, 1]),
  );
  const product = readFileSync("components/store-product.tsx", "utf8");
  is(
    "the gift, the group and the pre-order draw it where they draw no box (a shipped product), as the buy box does",
    ["dc-gift-", "dc-group-", "dc-pre-", "dc-${place}"].map((id) => new RegExp(`<DigitalConsentBox id=\\{\`${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\/> : <WithdrawalWhere lang=`).test(product)),
    [true, true, true, true],
  );
  is(
    "a cart of shipped products only draws it where a cart with something digital draws the box",
    /\{digital \? <DigitalConsentBox id=\{`dc-cart-\$\{handle\}`\}[^\n]*\/> : <WithdrawalWhere lang=\{lang\}[^\n]*\/>\}/.test(readFileSync("components/store-cart.tsx", "utf8")),
    true,
  );

  part("Claude 1's focal return on #2953: the welcome offer, and one quote style per language");
  // A welcome offer can be any paid product (lib/welcome-offer.ts): a shipped one draws no box, so the line takes its place.
  const welcomePage = readFileSync("app/[handle]/free/page.tsx", "utf8");
  is("a shipped welcome product (no box) still gets the withdrawal line in the box's place", /<DigitalConsentBox id="dc-welcome"[^\n]*\/> : <WithdrawalWhere lang=/.test(welcomePage), true);
  // The box and the line right under it quote the same label: with the same marks (typography only).
  const marksAround = (text: string, label: string): string => {
    const at = text.indexOf(label);
    return at > 0 ? `${text.slice(at - 1, at)}${text.slice(at + label.length, at + label.length + 1)}` : "";
  };
  is(
    "the box and the line quote the label with the same marks, in every language",
    LANGUAGES.map((lang) => {
      const label = withdrawalWords(lang).withdrawLink;
      return [lang, marksAround(DIGITAL_CONSENT_WORDS[lang].box.membership, label) === marksAround(withdrawalWords(lang).checkoutWhere, label)];
    }),
    LANGUAGES.map((lang) => [lang, true]),
  );

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
