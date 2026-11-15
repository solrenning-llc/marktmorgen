/**
 * 568 [GD2] (b), unit 3: the first entry of the Terms' "What you may not
 * sell" is "Anything unlawful". Words that plainly offer what is unlawful to
 * sell wherever a buyer is (fake identity documents or diplomas, stolen cards
 * or accounts, card dumps, hard drugs for sale) are a blocking kind of
 * lib/terms-check-rules.ts beside fast money, sexual content and pirated or
 * counterfeit goods, refused through the same server check; goods whose
 * legality depends on the place (cannabis, CBD, kratom, psilocybin, steroids,
 * firearms, ammunition) are a warning. Pure rules: no model, no request,
 * nothing the creator wrote is changed.
 *
 * What fails here:
 *   - a plain offer of fake documents, stolen data or hard drugs that passes;
 *   - a block on a sentence about protecting against it ("how to spot fake
 *     IDs at the door", "what to do if your card is stolen"), on recovery
 *     ("quit meth"), on a negation right beside it, or on ordinary words
 *     ("fake tan", "a stolen kiss", "the history of cocaine in medicine");
 *   - a place-dependent good that blocks or is not warned.
 */
import { BLOCKING_KINDS, blockingWhat, checkCreatorTerms, fastMoneyMessage, fastMoneyRefusal } from "@/lib/terms-check-rules";
import { checkAdText } from "@/lib/ad-creative-check";
import { done, is, part } from "./check";

const base = { ownHosts: [], priceCents: null, currency: "usd", immediateAccessConsent: true, realDeadline: false, realStockLimit: false, resaleLicense: false };
const kinds = (text: string) => checkCreatorTerms({ ...base, text }).map((w) => w.kind).filter((k) => k === "unlawful" || k === "maybe_unlawful");

part("A plain offer of what is unlawful is stopped");
for (const text of [
  "Fake IDs that scan.",
  "Fake passport templates.",
  "Fake driver's license, any state.",
  "Fake diplomas from real universities.",
  "Fake doctor's notes for work.",
  "Scannable IDs shipped fast.",
  "Novelty driver's licenses.",
  "Fresh CC dumps every week.",
  "Fullz with SSN.",
  "Carding tutorial for beginners.",
  "Stolen credit cards, tested.",
  "Hacked Netflix accounts.",
  "Buy cocaine discreetly.",
  "Order fentanyl online.",
]) is(`stopped: ${text}`, kinds(text), ["unlawful"]);

part("Words about something else are not stopped");
for (const [text, expected] of [
  ["How to spot fake IDs at the door: a training for bar staff.", ["maybe_unlawful"]],
  ["What to do when stolen credit cards are used on your store.", ["maybe_unlawful"]],
  ["Protect your shop from carding attacks.", []],
  ["We never sell fake IDs.", []],
  ["Fake tan tutorial.", []],
  ["A stolen kiss: a short story.", []],
  ["Fake news literacy for teens.", []],
  ["Quit meth: a recovery workbook.", []],
  ["Watercolor basics.", []],
] as const) is(`not stopped: ${text}`, kinds(text), [...expected]);

part("Goods whose legality depends on the place are a warning, never a block");
for (const text of [
  "Cannabis growing guide.",
  "CBD oil recipes.",
  "Kratom brewing course.",
  "Psilocybin microdosing journal.",
  "Steroids cycle plans.",
  "Firearms maintenance course.",
  "Ammunition reloading manual.",
]) {
  is(`warned: ${text}`, kinds(text), ["maybe_unlawful"]);
  is(`not blocked: ${text}`, fastMoneyRefusal({ title: text, summary: "", about: "" }), null);
}
is("a glue gun is nobody's firearm", kinds("Glue gun crafts for kids."), []);

part("A refusal says what blocks, where and how to fix it");
const refused = fastMoneyRefusal({ title: "Pack", summary: "Fake IDs that scan.", about: "" });
is("found in the summary", refused?.field, "summary");
is("the Terms' reason", [/unlawful/.test(refused?.why ?? ""), /Terms do not allow/.test(refused?.why ?? "")], [true, true]);
is("the message names it, never fast money", [/unlawful/.test(fastMoneyMessage(refused, "add")), /fast or easy money/.test(fastMoneyMessage(refused, "add"))], [true, false]);
is("the four prohibitions block, and only they do", [...BLOCKING_KINDS].sort(), ["fast_money", "infringing", "sexual_content", "unlawful"]);
is("the studio names it", blockingWhat(["unlawful"]), "Something unlawful to sell");
is("with the others", blockingWhat(["unlawful", "fast_money"]), "A promise of fast or easy money and something unlawful to sell");

part("An ad offering it is refused");
const ad = checkAdText({ headline: "Fake IDs", text: "Any state.", description: "", button: "Shop now" }, { priceCents: null, currency: "usd", ownHosts: [], realDeadline: false, realStockLimit: false, verifiedReviews: [] });
is("refused and not sendable", [ad.refusals.some((r) => r.rule === "unlawful"), ad.sendable], [true, false]);
done();
