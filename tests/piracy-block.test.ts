/**
 * 568 [GD2] (b), unit 2: the Terms' "What you may not sell" also names
 * "anything that infringes someone else's rights". Words that plainly offer
 * pirated or counterfeit goods (cracked or nulled software, key generators,
 * leaked courses, counterfeit items) are a blocking kind of
 * lib/terms-check-rules.ts beside fast money and sexual content, so the same
 * server refusal stops the product, its sales page, a bundle or a price;
 * words that only may be someone else's (replica, dupe, knockoff, torrent,
 * bootleg, unofficial) are a warning to reread. Pure rules: no model, no
 * request, nothing the creator wrote is changed.
 *
 * What fails here:
 *   - plain piracy or counterfeit words that pass;
 *   - a block on a sentence about protecting against it ("how to spot
 *     counterfeit sneakers", "protect your course from leaks"), on a negation
 *     right beside the words, or on ordinary words ("cracked pepper", "a
 *     leaked roof", "crack the code");
 *   - a doubtful word that blocks, or that is not warned;
 *   - a refusal or panel line that does not say what blocks.
 */
import { readFileSync } from "node:fs";
import { BLOCKING_KINDS, blockingWhat, checkCreatorTerms, fastMoneyMessage, fastMoneyOnPage, fastMoneyRefusal } from "@/lib/terms-check-rules";
import { checkAdText } from "@/lib/ad-creative-check";
import { done, is, part } from "./check";

const base = { ownHosts: [], priceCents: null, currency: "usd", immediateAccessConsent: true, realDeadline: false, realStockLimit: false, resaleLicense: false };
const kinds = (text: string) => checkCreatorTerms({ ...base, text }).map((w) => w.kind).filter((k) => k === "infringing" || k === "maybe_infringing");

part("Plain piracy or counterfeit is stopped");
for (const text of [
  "Cracked software bundle, lifetime.",
  "Adobe Photoshop cracked version.",
  "Pirated ebooks, 500 titles.",
  "Nulled WordPress themes and plugins.",
  "Nulled plugins pack.",
  "Keygen for every Office version.",
  "Leaked course from a top marketer.",
  "The leaked masterclass videos.",
  "Counterfeit sneakers at half price.",
  "Counterfeit designer bags.",
  "Pirated copies of the movie.",
]) is(`stopped: ${text}`, kinds(text), ["infringing"]);

part("Words about something else are not stopped");
for (const [text, expected] of [
  ["How to spot counterfeit sneakers before you buy.", ["maybe_infringing"]],
  ["Protect your course from leaked course sites.", ["maybe_infringing"]],
  ["Why cracked software is a security risk.", ["maybe_infringing"]],
  ["Avoid pirated ebooks: where to borrow for free.", ["maybe_infringing"]],
  ["No cracked software, only licensed copies.", []],
  ["This bundle contains no pirated content.", []],
  ["Cracked pepper steak recipe.", []],
  ["Fixing a leaked roof, step by step.", []],
  ["Crack the code of watercolor.", []],
  ["Leaked secrets of my own kitchen.", []],
  ["Watercolor basics.", []],
] as const) is(`not stopped: ${text}`, kinds(text), [...expected]);

part("Doubtful words are a warning, never a block");
for (const text of [
  "Replica watches.",
  "Perfume dupes of famous brands.",
  "Knockoff designer patterns.",
  "Torrent links included.",
  "Bootleg concert recordings.",
  "Unofficial Disney coloring pages.",
]) {
  is(`warned: ${text}`, kinds(text), ["maybe_infringing"]);
  is(`not blocked: ${text}`, fastMoneyRefusal({ title: text, summary: "", about: "" }), null);
}

part("A refusal says what blocks, where and how to fix it");
const refused = fastMoneyRefusal({ title: "Toolkit", summary: "", about: "Nulled plugins, every month." });
is("found in the description", refused?.field, "about");
is("the Terms' reason and the fix", [/someone else/.test(refused?.why ?? ""), /Terms do not allow/.test(refused?.why ?? ""), /license/.test(refused?.fix ?? "")], [true, true, true]);
const said = fastMoneyMessage(refused, "publish");
is("the message names it, never fast money", [/someone else/.test(said), /fast or easy money/.test(said)], [true, false]);
is("a sales page is refused the same way", fastMoneyOnPage(["Welcome", "Get the keygen here"])?.field, "page");
is("the Terms' prohibitions block, and only they do", [...BLOCKING_KINDS].sort(), ["fast_money", "infringing", "sexual_content", "unlawful"]);
is("the studio names it", blockingWhat(["infringing"]), "Pirated or counterfeit goods");
is("the studio names two at once", blockingWhat(["infringing", "fast_money"]), "A promise of fast or easy money and pirated or counterfeit goods");
is("the studio names all three", blockingWhat(["sexual_content", "infringing", "fast_money"]), "A promise of fast or easy money, sexual content and pirated or counterfeit goods");
const panel = readFileSync("components/terms-check-panel.tsx", "utf8");
is("the panel titles both new kinds", [/\binfringing: "/.test(panel), /maybe_infringing: "/.test(panel)], [true, true]);

part("An ad offering pirated goods is refused");
const ad = checkAdText({ headline: "Cracked software", text: "Every app you need.", description: "", button: "Shop now" }, { priceCents: null, currency: "usd", ownHosts: [], realDeadline: false, realStockLimit: false, verifiedReviews: [] });
is("refused and not sendable", [ad.refusals.some((r) => r.rule === "infringing"), ad.sendable], [true, false]);
done();
