/**
 * The signed page and the words before signing never state that a copy WAS
 * emailed (Codex U, 5 November 2026; C4-20261105-1930-C2-1). The page is
 * reopened later without the sign route's result, and sendSignedCopies can
 * fail (a refused sender, a spent quota), so the sentence must be true either
 * way: we try to send a copy by email and it may not arrive, and the signer
 * can keep one now with the
 * page's own print button, which is always shown once signed. Nothing about
 * signing, its record, its validity or the consent changes.
 *
 * What fails here: a past-tense "a copy was emailed" in any language; a
 * signed sentence without the name, the date or the print button's own
 * label; "before" promising the signer receives a copy; the page showing the
 * sentence without the print button, or reading a send result it does not
 * have.
 */
import { readFileSync } from "node:fs";
import { agreementWords } from "@/lib/buyer-words/agreements";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

/** Past-tense "a copy was sent" in each language (the sentences that were there, and their near forms). */
const sentAsFact: Record<string, RegExp> = {
  en: /\bcopy (?:was|has been) (?:e-?mailed|sent)\b|\bwas emailed\b/i,
  es: /\bse envi[óo] una copia\b|\buna copia (?:fue|ha sido) enviada\b/i,
  fr: /\bune copie a [ée]t[ée] envoy[ée]e\b/i,
  de: /\beine kopie ging\b|\beine kopie wurde (?:per e-mail )?(?:gesendet|geschickt|verschickt)\b/i,
  it: /\buna copia [èe] stata inviata\b/i,
  nl: /\ber ging een kopie\b|\been kopie (?:is|werd) (?:per e-mail )?(?:verstuurd|verzonden|gestuurd)\b/i,
  pt: /\bfoi enviada uma c[óo]pia\b|\buma c[óo]pia foi enviada\b/i,
};
/** "You receive / get a copy" as a promise, in the words before signing. */
const receivesAsPromise: Record<string, RegExp> = {
  en: /\ba copy is emailed to you\b|\byou (?:will )?(?:get|receive) a copy\b/i,
  es: /\brecibe una copia\b|\brecibir[áa] una copia\b/i,
  fr: /\bune copie vous est envoy[ée]e\b|\bvous recevrez une copie\b/i,
  de: /\bbekommen sie eine kopie\b|\berhalten sie eine kopie\b/i,
  it: /\bricevi una copia\b|\briceverai una copia\b/i,
  nl: /\bkrijgt u een kopie\b|\bontvangt u een kopie\b/i,
  pt: /\brecebe uma c[óo]pia\b|\breceber[áa] uma c[óo]pia\b/i,
};

/**
 * "A copy is sent" in the present, as if it always arrived (Codex U on #2705, proof
 * codex/u-review-2705-present-claim-proof@3a375a83): sendSignedCopies can come back with no copy sent, so the
 * sentence says it is an attempt that may not arrive, never a plain present-tense fact.
 */
const sentUnqualified: Record<string, RegExp> = {
  en: /a copy is sent by email/i,
  es: /se envía una copia por email/i,
  fr: /une copie est envoyée par e-mail/i,
  de: /(?:eine kopie wird|wird eine kopie) per e-mail .* geschickt/i,
  it: /una copia viene inviata via email/i,
  nl: /(?:er wordt een kopie|wordt een kopie) per e-mail .*gestuurd/i,
  pt: /é enviada uma cópia por email/i,
};
/** The attempt, and that it may not arrive, in each language. */
const triesAndMayFail: Record<string, [RegExp, RegExp]> = {
  en: [/\bwe try to send a copy\b/i, /\bmay not arrive\b/i],
  es: [/\bintentamos enviar una copia\b/i, /\bpuede no llegar\b/i],
  fr: [/\bnous essayons d'envoyer une copie\b/i, /\bpeut ne pas arriver\b/i],
  de: [/\bversuchen wir, eine kopie\b|\bwir versuchen, eine kopie\b/i, /\bkommt vielleicht nicht an\b/i],
  it: [/\bproviamo a inviare una copia\b/i, /\bpotrebbe non arrivare\b/i],
  nl: [/\b(?:we|wij) proberen een kopie\b|\bproberen (?:we|wij) een kopie\b/i, /\bkomt mogelijk niet aan\b/i],
  pt: [/\btentamos enviar uma c[óo]pia\b/i, /\bpode não chegar\b/i],
};

part("Never a copy sent as a plain fact, past or present: an attempt that may not arrive (Codex U)");
for (const language of LANGUAGE_CODES) {
  const w = agreementWords(language);
  for (const [where, said] of [["signed", w.signedBody("Sample Signer", "Sample date")], ["before", w.before("Sample Store")]] as const) {
    is(`${language} ${where}: no unqualified "a copy is sent"`, sentUnqualified[language].test(said), false);
    is(`${language} ${where}: says we try to send one and it may not arrive`, triesAndMayFail[language].map((re) => re.test(said)), [true, true]);
  }
}

part("The signed sentence, in every language");
for (const language of LANGUAGE_CODES) {
  const w = agreementWords(language);
  const said = w.signedBody("Sample Signer", "Sample date");
  is(`${language}: never says a copy was sent, as a fact`, sentAsFact[language].test(said), false);
  is(`${language}: keeps the signer's name and the date`, [said.includes("Sample Signer"), said.includes("Sample date")], [true, true]);
  is(`${language}: names the page's own print button, so the signer can keep a copy now`, said.includes(w.print), true);
}

part("The words before signing, in every language");
for (const language of LANGUAGE_CODES) {
  const w = agreementWords(language);
  const said = w.before("Sample Store");
  is(`${language}: never promises the signer receives a copy`, receivesAsPromise[language].test(said), false);
  is(`${language}: never says a copy was sent`, sentAsFact[language].test(said), false);
  is(`${language}: names the print button the signed page shows`, said.includes(w.print), true);
}

part("The page, reopened later without the sign route's result");
const page = readFileSync("app/[handle]/sign/[agreement]/page.tsx", "utf8");
is("the sentence still comes from the signature's name and date only", page.includes("w.signedBody(signature.name, said.date(signature.at))"), true);
const signedBlock = page.slice(page.indexOf('{status === "signed" && signature ? (\n            <div className="mt-6">'));
is("the print button is shown whenever it is signed", /^\{status === "signed" && signature \? \([\s\S]{0,1500}<PrintButton label=\{w\.print\} \/>/.test(signedBlock), true);
is("nothing on the page reads whether the copy was sent", /copies|sendSignedCopies|failed/.test(page), false);
done();
