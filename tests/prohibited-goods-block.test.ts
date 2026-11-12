/**
 * 568 [GD2] (b), unit 1: a product that offers what the Terms forbid outright
 * is not published. "What you may not sell" (app/terms/page.tsx) names
 * anything unlawful, anything that infringes someone else's rights and sexual
 * content. Code rules, no model: the words that can only mean the forbidden
 * thing on sale (forged identity documents, stolen card data, cracked or
 * pirated software, counterfeit goods, pornography, machine-gun conversion
 * devices, hacking for hire, hard drugs for sale) stop publication through
 * the same door as fast or easy money (567 [GD1] (d)): the product, its
 * sales page, a bundle and a price's name. A subject that is only doubtful
 * (firearms, cannabis, gambling, nudity...) is a warning to check Stripe's
 * list of restricted businesses, never a block.
 *
 * What fails here:
 *   - a clearly forbidden offer that passes;
 *   - a lesson about the subject, a warning against it, a negation, a quote
 *     or a question that is stopped ("how bartenders spot fake IDs");
 *   - a doubtful subject that blocks, or that is not warned;
 *   - a refusal without the passage, the reason from the Terms and the fix;
 *   - an ad offering forbidden goods that is not refused.
 */
import { readFileSync } from "node:fs";
import { BLOCKING_KINDS, checkCreatorTerms, fastMoneyMessage, fastMoneyRefusal } from "@/lib/terms-check-rules";
import { checkAdText } from "@/lib/ad-creative-check";
import { done, is, part } from "./check";

const base = { ownHosts: [], priceCents: null, currency: "usd", immediateAccessConsent: true, realDeadline: true, realStockLimit: true, resaleLicense: true };
const kinds = (text: string) => checkCreatorTerms({ ...base, text }).map((w) => w.kind).filter((k) => k === "prohibited_goods" || k === "restricted_goods");

part("What the Terms forbid outright is stopped");
for (const text of [
  "Scannable fake IDs for every state, shipped fast.",
  "Novelty passports and forged driver's licenses.",
  "Fresh CC dumps and fullz, updated daily.",
  "Stolen credit cards with high balances.",
  "The 2026 carding method that still works.",
  "Cracked software bundle: Photoshop, Premiere and more.",
  "Adobe keygen included.",
  "Nulled WordPress plugins, 500 of them.",
  "Leaked courses from top creators, all in one drive.",
  "OnlyFans leaks of 200 models.",
  "Replica designer handbags at a fraction of the price.",
  "Counterfeit money that passes the pen test.",
  "Porn videos pack, 4K.",
  "Explicit sex videos, members only.",
  "Nudes pack: 300 photos.",
  "Glock switch files for your printer.",
  "Auto sear blueprint, ready to cut.",
  "Hacked Netflix accounts for a year.",
  "We hack into someone's Instagram for you.",
  "DDoS for hire, any target.",
  "Buy cocaine online, discreet delivery.",
  "Fentanyl for sale.",
]) is(`stopped: ${text}`, kinds(text).includes("prohibited_goods"), true);

part("A lesson about it, a warning against it, a negation, a quote or a question is not stopped");
for (const text of [
  "How bartenders spot fake IDs: a two-hour course.",
  "Fake ID detection training for door staff.",
  "Protect your shop from stolen credit cards.",
  "How to recover hacked accounts in ten minutes.",
  "We never sell cracked software: every license is real.",
  "No pirated content, ever.",
  "Avoid counterfeit money: what cashiers should check.",
  "How to detect counterfeit money at the register.",
  "Porn addiction recovery workbook.",
  "Is a glock switch legal? A lawyer explains the federal rule.",
  "Ghost gun laws by state, explained.",
  "Prevent DDoS attacks on your small site.",
  'Why "leaked courses" sites are a scam.',
  "Cracked eggs and other kitchen fixes.",
  "Replica furniture plans for dollhouses.",
  "Nude lipstick shades for every skin tone.",
]) is(`not stopped: ${text}`, kinds(text).includes("prohibited_goods"), false);

part("A doubtful subject is a warning to check Stripe's list, never a block");
for (const text of [
  "Firearms cleaning masterclass.",
  "CBD oil starter guide.",
  "Sports betting picks every Sunday.",
  "Online casino strategy ebook.",
  "Artistic nude photography presets.",
  "Kratom dosage cheat sheet.",
]) {
  const found = kinds(text);
  is(`warned, not stopped: ${text}`, [found.includes("restricted_goods"), found.includes("prohibited_goods")], [true, false]);
}
const restricted = checkCreatorTerms({ ...base, text: "CBD oil starter guide." }).find((w) => w.kind === "restricted_goods");
is("the warning says to check Stripe's list, without claiming what is on it", [/Stripe/.test(restricted?.why ?? ""), /restricted businesses/.test(restricted?.why ?? ""), /stripe\.com\/legal\/restricted-businesses/.test(restricted?.fix ?? "")], [true, true, true]);
is("a doubtful word said in the negative is not warned", kinds("No CBD, no cannabis: plain herbal tea recipes."), []);
is("plain product words are not warned", kinds("Sourdough bread for beginners, step by step."), []);
is("the forbidden offer is not also warned as doubtful", kinds("Porn videos pack, 4K."), ["prohibited_goods"]);

part("The product, its page, a bundle and a price's name are refused through the same door");
is("blocking kinds: fast or easy money and what the Terms forbid outright", [...BLOCKING_KINDS].sort(), ["fast_money", "prohibited_goods"]);
const refused = fastMoneyRefusal({ title: "Design toolkit", summary: "", about: "Includes cracked software for every app." });
is("found in the description", refused?.field, "about");
is("with the passage, the reason from the Terms and the fix", [refused?.excerpt.includes("cracked software"), /Terms do not allow/.test(refused?.why ?? ""), /someone else's rights/.test(refused?.why ?? ""), (refused?.fix ?? "").length > 20], [true, true, true, true]);
is("a doubtful subject does not refuse", fastMoneyRefusal({ title: "Firearms cleaning masterclass", summary: "", about: "" }), null);
const said = fastMoneyMessage({ ...refused, product: "Design toolkit" }, "publish");
is("the studio says what, where, why and that nothing was changed", [/^“Design toolkit” was not published\./.test(said), said.includes("cracked software"), /someone else's rights/.test(said), /Nothing you wrote was changed/.test(said)], [true, true, true, true]);
for (const [route, call] of [
  ["app/api/store/product/route.ts", /fastMoneyRefusal\(/],
  ["app/api/store/page/route.ts", /fastMoneyOnPage\(/],
  ["app/api/store/bundle/route.ts", /fastMoneyRefusal\(/],
  ["app/api/store/option/route.ts", /fastMoneyRefusal\(/],
] as const) is(`${route} checks before saving`, call.test(readFileSync(route, "utf8")), true);

part("An ad offering forbidden goods is refused");
const ad = checkAdText({ headline: "Cracked software, every app", text: "Download today.", description: "", button: "Shop now" }, { priceCents: 4900, currency: "usd", ownHosts: [], realDeadline: true, realStockLimit: true, verifiedReviews: [] });
is("refused for what the Terms forbid, and not sendable", [ad.sendable, ad.refusals.some((r) => r.rule === "prohibited_goods")], [false, true]);

done();
