/**
 * 617 [SZ1], unit 2: the policy facts in every buyer language
 * (lib/buyer-words/policies.ts). Every language has every sentence, places the
 * store's name and address, keeps "Global Privacy Control" and the 14 days,
 * never promises compliance, and English stays exactly as unit 1 wrote it.
 */
import { LANGUAGE_CODES } from "@/lib/store-language";
import { POLICY_WORDS } from "@/lib/buyer-words/policies";
import { type PolicyFactsInput, notAdvice, policyFacts, policyFingerprint } from "@/lib/store-policy-facts";
import { done, is, part } from "./check";

const all: PolicyFactsInput = { storeName: "Harbor Kitchen", sellsDigital: true, sellsMemberships: true, stripe: true, paypal: true, pixels: ["Meta", "Google", "TikTok"], postalAddress: "1 Main St, Portland, OR 97201", membersSelfCancel: true };

part("Every language says every part");
for (const code of LANGUAGE_CODES) {
  const sections = policyFacts(all, code);
  const text = sections.flatMap((s) => s.sentences).join(" ");
  is(`${code}: the same five sections`, sections.map((s) => s.id), ["seller", "cancel", "memberships", "measurement", "contact"]);
  is(`${code}: the same number of sentences`, sections.map((s) => s.sentences.length), [3, 3, 2, 3, 1]);
  is(`${code}: the name, the address, the 14 days, PayPal, the pixels and Global Privacy Control`, ["Harbor Kitchen", "1 Main St, Portland, OR 97201", "14", "PayPal", "Meta", "TikTok", "Global Privacy Control"].every((word) => text.includes(word)), true);
  is(`${code}: titles all set`, sections.every((s) => s.title.trim().length > 2), true);
  is(`${code}: no word left in English where another language is spoken`, code === "en" ? true : !/\b(the seller|membership|checkout|nothing is measured)\b/i.test(text), true);
  is(`${code}: says it is not legal advice`, notAdvice(code).length > 60, true);
}

part("Every language names only the accounts the store takes money into (Codex N1's MEDIUM on #1824)");
for (const code of LANGUAGE_CODES) {
  const seller = (stripe: boolean, paypal: boolean) => (policyFacts({ ...all, stripe, paypal }, code).find((s) => s.id === "seller")?.sentences ?? []).join(" ");
  is(`${code}: Stripe only`, [seller(true, false).includes("Stripe"), seller(true, false).includes("PayPal")], [true, false]);
  is(`${code}: Stripe and PayPal`, [seller(true, true).includes("Stripe"), seller(true, true).includes("PayPal")], [true, true]);
  is(`${code}: PayPal only, never Stripe`, [seller(false, true).includes("Stripe"), seller(false, true).includes("PayPal"), seller(false, true).includes("Harbor Kitchen")], [false, true, true]);
  is(`${code}: neither, no account named`, [seller(false, false).includes("Stripe"), seller(false, false).includes("PayPal"), policyFacts({ ...all, stripe: false, paypal: false }, code)[0].sentences.length], [false, false, 2]);
  is(`${code}: the four are four different sentences`, new Set([seller(true, false), seller(true, true), seller(false, true), seller(false, false)]).size, 4);
}

part("Translation gaps from Claude 1's LOW on #1824");
const sentenceOf = (code: string, id: string, i: number) => policyFacts(all, code).find((s) => s.id === id)?.sentences[i] ?? "";
is("de: whose PayPal account it is", sentenceOf("de", "seller", 2).includes("PayPal-Konto von Harbor Kitchen"), true);
is("it: the store's own accounts, and no masculine-only 'da solo'", [sentenceOf("it", "seller", 2).includes("intestato a Harbor Kitchen"), sentenceOf("it", "memberships", 0).includes("da solo")], [true, false]);
is("pt: the buyer cancels on their own", sentenceOf("pt", "memberships", 0).includes("por conta própria"), true);

part("English stays exactly as unit 1 wrote it");
is("the seller", policyFacts(all, "en")[0].sentences[0], "Harbor Kitchen is the seller. Each sale is a contract between Harbor Kitchen and the buyer.");
is("the list joined with each language's own word", [policyFacts(all, "en")[3].sentences[0], policyFacts(all, "de")[3].sentences[0]], ["Harbor Kitchen measures its ads with Meta, Google and TikTok.", "Harbor Kitchen misst seine Werbung mit Meta, Google und TikTok."]);
is("an unknown language reads as English", policyFacts(all, "xx")[0].title, "Who sells");

part("Never a promise of compliance, in any language");
const promises = /\b(conforme|cumple con|garantiza|garantit|garantiert|garantisce|garante|voldoet aan alle|fully compliant)\b/i;
is("no language promises compliance", LANGUAGE_CODES.filter((code) => promises.test(policyFacts(all, code).flatMap((s) => s.sentences).join(" "))), []);

part("Each language is its own version");
is("the fingerprint differs by language", new Set(LANGUAGE_CODES.map((code) => policyFingerprint(policyFacts(all, code)))).size, LANGUAGE_CODES.length);
is("without the store's name, nothing is said", policyFacts({ ...all, storeName: " " }, "en"), []);
is("every language has the same keys", LANGUAGE_CODES.every((code) => JSON.stringify(Object.keys(POLICY_WORDS[code]).sort()) === JSON.stringify(Object.keys(POLICY_WORDS.en).sort())), true);

done();
