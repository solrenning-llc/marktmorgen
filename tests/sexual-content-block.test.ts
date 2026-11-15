/**
 * 568 [GD2] (b), unit 1: a product the Terms forbid is stopped by rules, not
 * only warned. "What you may not sell" (app/terms/page.tsx) names "sexual
 * content" beside the promise of fast or easy money that 567 [GD1] (d) already
 * stops. So a product, its sales page, a bundle or a price whose words plainly
 * describe sexual content cannot be published, nor a published one saved with
 * them, through the same server refusal (lib/terms-check-rules.ts,
 * fastMoneyRefusal, and every route that calls it); words that only may be
 * adult content are a warning the creator rereads, never a block. No model,
 * no request, nothing the creator wrote is changed.
 *
 * What fails here:
 *   - plain sexual content that passes in the title, summary, description,
 *     a sales page or a price's words;
 *   - a block on words that are about something else: a negation ("no
 *     explicit content"), recovery from it ("quit porn"), the law or a
 *     child-safety course about it, "food porn" photography, nude lipstick;
 *   - a doubtful word ("erotic", "NSFW", "OnlyFans") that blocks, or that is
 *     not warned at all;
 *   - a refusal without the passage, the Terms' reason and the fix, or a
 *     message that calls it fast money;
 *   - the warnings panel or an ad's check not naming it.
 */
import { readFileSync } from "node:fs";
import { BLOCKING_KINDS, MAX_WARNINGS, blockingWhat, checkCreatorTerms, fastMoneyMessage, fastMoneyOnPage, fastMoneyRefusal } from "@/lib/terms-check-rules";
import { checkAdText } from "@/lib/ad-creative-check";
import { done, is, part } from "./check";

const base = { ownHosts: [], priceCents: null, currency: "usd", immediateAccessConsent: true, realDeadline: false, realStockLimit: false, resaleLicense: false };
const kinds = (text: string) => checkCreatorTerms({ ...base, text }).map((w) => w.kind).filter((k) => k === "sexual_content" || k === "adult_content");

part("Plain sexual content is stopped");
for (const text of [
  "Porn videos, updated weekly.",
  "My pornographic photo set.",
  "Uncensored hentai pack.",
  "Our sex tape, full length.",
  "Sexually explicit stories for adults.",
  "Explicit sex scenes in every chapter.",
  "XXX videos of me.",
  "X-rated clips, HD.",
  "OnlyFans leaks bundle.",
  "Leaked nudes of models.",
  "PORN pack",
  "No paywall, porn clips every day.",
  "No-limits porn videos.",
  "XXX videos for teens.",
  "Free porn downloads.",
]) is(`stopped: ${text}`, kinds(text), ["sexual_content"]);

part("Words about something else are not stopped");
for (const [text, expected] of [
  ["No explicit sexual content: a course for teens on consent.", []],
  ["This guide contains no pornographic images.", []],
  ["Quit porn in 90 days: a recovery workbook.", ["adult_content"]],
  ["Break free from porn addiction.", ["adult_content"]],
  ["Porn addiction recovery program for men.", ["adult_content"]],
  ["Talk to your kids about the dangers of pornography.", ["adult_content"]],
  ["Revenge porn laws explained for victims.", ["adult_content"]],
  ["Food porn photography presets for Lightroom.", ["adult_content"]],
  ["Cabin porn: 50 tiny houses to build.", ["adult_content"]],
  ["Sex education for parents of toddlers.", []],
  ["Nude lipstick shades for every skin tone.", []],
  ["A nude palette of eyeshadows.", []],
  ["Sussex cottage watercolor prints.", []],
  ["Essex walking guide.", []],
  ["Expornent tracker", []],
  ["Watercolor basics, step by step.", []],
] as const) is(`not stopped: ${text}`, kinds(text), [...expected]);

part("Doubtful words are a warning, never a block");
for (const text of [
  "Erotic short stories.",
  "An erotica collection.",
  "NSFW art commissions.",
  "Exclusive OnlyFans content.",
  "My Fansly bundle.",
  "Nude photography for beginners.",
  "Fetish photo set.",
  "Escort services directory.",
  "Cam girl tips.",
  "Striptease class.",
  "Sexting scripts.",
  "Nudes, uncensored.",
]) {
  is(`warned: ${text}`, kinds(text), ["adult_content"]);
  is(`not blocked: ${text}`, fastMoneyRefusal({ title: text, summary: "", about: "" }), null);
}
is("a doubtful word said in the negative is not warned", kinds("Nothing erotic here: a cookbook."), []);

part("A refusal says where, why and how to fix it, in its own words");
const refused = fastMoneyRefusal({ title: "Photo pack", summary: "", about: "Porn videos of me, every week." });
is("found in the description", refused?.field, "about");
is("the passage, the Terms' reason and the fix", [refused?.excerpt.includes("Porn videos"), /sexual content/.test(refused?.why ?? ""), /Terms do not allow/.test(refused?.why ?? ""), (refused?.fix ?? "").length > 20], [true, true, true, true]);
const said = fastMoneyMessage(refused, "publish");
is("the message names sexual content, never fast money", [/sexual content/.test(said), /fast or easy money/.test(said), /Nothing you wrote was changed/.test(said)], [true, false, true]);
is("the title is read", fastMoneyRefusal({ title: "Hentai pack", summary: "", about: "" })?.field, "title");
is("the summary is read", fastMoneyRefusal({ title: "Pack", summary: "XXX videos", about: "" })?.field, "summary");
is("a sales page is refused the same way", fastMoneyOnPage(["Welcome", "Uncensored porn clips inside"])?.field, "page");
is("plain product words pass", fastMoneyRefusal({ title: "Bread basics", summary: "Ten loaves.", about: "Flour, water, salt." }), null);
is("the Terms' prohibitions block, and only they do", [...BLOCKING_KINDS].sort(), ["fast_money", "infringing", "sexual_content"]);

part("A crowded text still keeps the passage that blocks");
const crowded = Array.from({ length: MAX_WARNINGS + 5 }, (_, i) => `https://outside${i}.com`).join(". ") + ". Porn clips inside.";
const kept = checkCreatorTerms({ ...base, text: crowded });
is("the warnings stay capped", kept.length, MAX_WARNINGS);
is("the sexual content passage is kept and still points at the words", kept.filter((w) => w.kind === "sexual_content").map((w) => crowded.slice(w.at, w.at + w.length)), ["Porn"]);
is("and the product is refused", fastMoneyRefusal({ title: "Pack", summary: crowded, about: "" })?.field, "summary");

part("The studio names what blocks");
is("fast money alone", blockingWhat(["fast_money"]), "A promise of fast or easy money");
is("sexual content alone", blockingWhat(["sexual_content", "earnings_claim"]), "Sexual content");
is("both", blockingWhat(["sexual_content", "fast_money"]), "A promise of fast or easy money and sexual content");
const panel = readFileSync("components/terms-check-panel.tsx", "utf8");
is("the panel titles both new kinds", [/sexual_content: "/.test(panel), /adult_content: "/.test(panel)], [true, true]);
is("the panel's blocking line is drawn from what blocks", /blockingWhat\(warnings\.map\(\(w\) => w\.kind\)\)/.test(panel), true);

part("An ad with sexual content is refused");
const ad = checkAdText({ headline: "Porn videos", text: "New every week.", description: "", button: "Shop now" }, { priceCents: null, currency: "usd", ownHosts: [], realDeadline: false, realStockLimit: false, verifiedReviews: [] });
is("refused, not only warned, and not sendable", [ad.refusals.some((r) => r.rule === "sexual_content"), ad.sendable], [true, false]);
done();
