/**
 * 759 [STN6], unit 1: an AutoDM keyword is exact by default, and a post's counts start at the comments.
 *
 * On Stan a keyword found anywhere in a comment sends the reply, so "I already have the guide" gets the guide again.
 * Here a new rule answers only a comment that is the keyword alone (case, accents, punctuation, emoji and styled
 * letters aside); the forgiving match, a keyword inside a sentence with a plural or a typo, is the creator's choice
 * ("close"). A change of that choice changes who gets the reply, so it asks for a new test. A post's counts add the
 * comments that held a keyword, still bare numbers with nothing about anyone.
 */
import * as rules from "@/lib/autodm-rules";
import { addCount, countsLine, emptyCounts, matchesKeyword, matchingKeyword } from "@/lib/autodm-rules";
import { decideReply, noteTested, readAutoDmRule, ruleFingerprint, ruleProblemWords, tryComment, type AutoDmRule } from "@/lib/autodm-reply-rules";
import { done, is, part } from "./check";

const r = rules as Record<string, unknown>;
const readMatch = r.readMatch as ((input: unknown) => string | null) | undefined;
type Match = "exact" | "close";
const matches = matchesKeyword as (comment: string, keyword: string, match?: Match) => boolean;
const matching = matchingKeyword as (comment: string, keywords: readonly string[], match?: Match) => string | null;

part("A keyword is exact unless the creator chooses otherwise");
is("the choices are exact and close", r.MATCH_CHOICES, ["exact", "close"]);
is("a new rule is exact", r.DEFAULT_MATCH, "exact");
is("each choice reads as itself", [readMatch?.("exact"), readMatch?.("close")], ["exact", "close"]);
is("anything else is refused, never replaced", [readMatch?.("Exact"), readMatch?.("fuzzy"), readMatch?.(""), readMatch?.(null), readMatch?.(1)], [null, null, null, null, null]);

part("Exact: the comment is the keyword alone");
for (const [comment, keyword] of [
  ["guide", "guide"],
  ["GUIDE!!", "guide"],
  ["  Guide 🙌", "guide"],
  ["𝐆𝐔𝐈𝐃𝐄", "guide"],
  ["café", "Cafe"],
  ["Free, guide!", "free guide"],
  ["code10", "code10"],
] as const) {
  is(`"${comment}" matches "${keyword}"`, matches(comment, keyword, "exact"), true);
}
for (const [comment, keyword] of [
  ["I already have the guide", "guide"],
  ["guide please", "guide"],
  ["guides", "guide"],
  ["gude", "guide"],
  ["guidebook", "guide"],
  ["guide", "free guide"],
  ["free guide now", "free guide"],
  ["code11", "code10"],
  ["", "guide"],
] as const) {
  is(`"${comment}" does not match "${keyword}"`, matches(comment, keyword, "exact"), false);
}
is("with no choice passed, matching is exact", matches("send me the guide", "guide"), false);
is("the first keyword, as typed, that the whole comment is", matching("Recipe!", ["guide", "Recipe"], "exact"), "Recipe");
is("none when the comment is more than a keyword", matching("the recipe please", ["guide", "recipe"]), null);

part("Close: the forgiving match, chosen by the creator");
is("a keyword inside a sentence", matches("send me the guide", "guide", "close"), true);
is("a plural and a typo", [matches("guides", "guide", "close"), matches("gude", "guide", "close")], [true, true]);
is("still never inside a longer word", matches("guidebook", "guide", "close"), false);

part("A rule keeps its choice, and a change asks for a new test");
const PRODUCTS = [{ id: "p1a2b3c4" }];
const base = { id: "rule1abc", post: "post_1", keywords: ["guide"], testers: ["tester.one"], reply: "Here it is!", product: "p1a2b3c4" };
const plain = readAutoDmRule(base, PRODUCTS);
const close = readAutoDmRule({ ...base, match: "close" }, PRODUCTS);
is("left out, it is exact", plain.ok && (plain.rule as AutoDmRule & { match?: string }).match, "exact");
is("close is kept", close.ok && (close.rule as AutoDmRule & { match?: string }).match, "close");
const bad = readAutoDmRule({ ...base, match: "fuzzy" }, PRODUCTS);
is("anything else is refused on its own field", bad.ok ? null : [bad.field, bad.problem], ["match", "bad"]);
is("and said in plain words", bad.ok ? "" : ruleProblemWords(bad), "Choose whether a comment must be the keyword alone or may only contain it.");
if (plain.ok && close.ok) {
  is("the choice is part of what a test covers", ruleFingerprint(plain.rule) === ruleFingerprint(close.rule), false);
  const tested = noteTested(plain.rule);
  const switched = readAutoDmRule({ ...base, match: "close", mode: "live" }, PRODUCTS, tested.tested);
  is("a rule tested as exact cannot go live as close", switched.ok ? null : [switched.field, switched.problem], ["mode", "untested"]);
  const decide = (rule: AutoDmRule, comment: string) =>
    decideReply({ rule, comment, personId: "tester.one", ownAccountId: "shop.own", lastSentAtSeconds: null, nowSeconds: 1_000, live: false });
  is("exact: a sentence that holds the keyword gets nothing", decide(plain.rule, "I already have the guide"), { send: false, why: "no_match" });
  is("exact: the keyword alone gets the reply", decide(plain.rule, "Guide!"), { send: true, keyword: "guide" });
  is("close: the sentence gets the reply", decide(close.rule, "I already have the guide"), { send: true, keyword: "guide" });
  is("the studio's test box follows the rule's choice", [tryComment(plain.rule, "the guide please").matched, tryComment(close.rule, "the guide please").matched], [null, "guide"]);
}

part("A post's counts start at the comments that held a keyword");
is("empty counts", emptyCounts(), { commented: 0, sent: 0, clicked: 0, sold: 0 } as never);
is("one comment more", addCount(emptyCounts(), "commented" as never), { commented: 1, sent: 0, clicked: 0, sold: 0 } as never);
is("a typical line", countsLine({ commented: 140, sent: 120, clicked: 30, sold: 4 } as never), "140 comments · Sent 120 · 30 clicks · 4 sales");
is("singular", countsLine({ commented: 1, sent: 1, clicked: 1, sold: 1 } as never), "1 comment · Sent 1 · 1 click · 1 sale");
is("a broken number shows as 0", countsLine({ commented: Number.NaN, sent: 2, clicked: 0, sold: 0 } as never), "0 comments · Sent 2 · 0 clicks · 0 sales");

done();
