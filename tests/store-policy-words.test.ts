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

const all: PolicyFactsInput = { storeName: "Harbor Kitchen", sellsDigital: true, sellsMemberships: true, paypal: true, pixels: ["Meta", "Google", "TikTok"], postalAddress: "1 Main St, Portland, OR 97201" };

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
