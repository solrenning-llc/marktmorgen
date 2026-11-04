/**
 * AutoDM rules (480 [SB3]; lib/autodm-rules.ts; added 4 November 2026). Pure:
 * nothing is read, sent or kept here. Checked:
 *
 *   - matching forgives case, accents, simple English plurals and a small
 *     typo (none on 4 letters or fewer, one on 5 to 8, two on 9 or more),
 *     never a digit, and never matches inside a longer word;
 *   - a keyword of several words matches the same words in a row, across
 *     punctuation; the first keyword in the creator's order wins;
 *   - a post's keyword list is refused when empty, too long, too wordy, made
 *     of punctuation or emoji only, or holding two keywords that cover each
 *     other, with the index of each;
 *   - only the first COMMENT_MAX_CHARS characters of a comment are read;
 *   - the repeat interval at its exact boundaries and with a clock ahead;
 *   - test mode reaches only the creator's test accounts, live mode nobody
 *     while AUTODM_LIVE is false;
 *   - the counts line in plain US English, and the link tag.
 */
import {
  AUTODM_LIVE,
  COMMENT_MAX_CHARS,
  DEFAULT_MODE,
  DEFAULT_REPEAT,
  KEYWORD_MAX_CHARS,
  MAX_KEYWORDS_PER_POST,
  MAX_TESTERS,
  REPEAT_CHOICES,
  addCount,
  countsLine,
  dmLinkTag,
  emptyCounts,
  matchesKeyword,
  matchingKeyword,
  mayReachPerson,
  mayReplyAgain,
  normalizeForMatch,
  pluralForms,
  readKeywords,
  readRepeat,
  readTesters,
  typoDistance,
} from "@/lib/autodm-rules";
import { done, is, part } from "./check";

part("Nothing is live");
is("AUTODM_LIVE is false", AUTODM_LIVE, false);
is("a new rule starts in test mode, every 12 hours", [DEFAULT_MODE, DEFAULT_REPEAT], ["test", "12h"]);

part("Normalizing, for comparing only");
is("case, accents and punctuation", normalizeForMatch("  Café — GUIDE!!  "), "cafe guide");
is("runs of symbols become one space", normalizeForMatch("free,,,   guide...now"), "free guide now");
is("emoji and punctuation only become nothing", normalizeForMatch("🔥🔥 !!! ✨"), "");
is("compatibility forms (ligature, full-width)", normalizeForMatch("ﬁle ＧＵＩＤＥ"), "file guide");
is("digits are kept", normalizeForMatch("Code-10"), "code 10");

part("Case and accents");
is("GUIDE matches guide", matchesKeyword("Send me the GUIDE please", "guide"), true);
is("café matches cafe, both ways", [matchesKeyword("love this café", "cafe"), matchesKeyword("love this cafe", "Café")], [true, true]);
is("crème brûlée matches creme brulee", matchesKeyword("Crème Brûlée recipe?", "creme brulee"), true);

part("Plurals");
is("guide / guides, both ways", [matchesKeyword("guides", "guide"), matchesKeyword("guide", "guides")], [true, true]);
is("box / boxes", [matchesKeyword("boxes", "box"), matchesKeyword("box", "boxes")], [true, true]);
is("story / stories", [matchesKeyword("stories", "story"), matchesKeyword("story", "stories")], [true, true]);
is("class / classes", [matchesKeyword("classes", "class"), matchesKeyword("class", "classes")], [true, true]);
is("wish / wishes, church / churches", [matchesKeyword("wishes", "wish"), matchesKeyword("churches", "church")], [true, true]);
is("case / cases", [matchesKeyword("cases", "case"), matchesKeyword("case", "cases")], [true, true]);
is("glass is not stripped to glas", pluralForms("glass"), ["glass"]);
is("glass / glasses", [matchesKeyword("glasses", "glass"), matchesKeyword("glass", "glasses")], [true, true]);
is("a 3-letter word keeps its s", pluralForms("bus"), ["bus"]);
is("plural forms of stories, boxes, guides", [pluralForms("stories"), pluralForms("boxes"), pluralForms("guides")], [
  ["stories", "story", "storie"],
  ["boxes", "box", "boxe"],
  ["guides", "guide"],
]);

part("Typos");
is("5 letters: one swapped, missing, extra or wrong letter", [
  matchesKeyword("giude", "guide"),
  matchesKeyword("gude", "guide"),
  matchesKeyword("guidee", "guide"),
  matchesKeyword("guido", "guide"),
], [true, true, true, true]);
is("5 letters: two typos do not match", matchesKeyword("gidue", "guide"), false);
is("8 letters: one typo matches, two do not", [matchesKeyword("templtae", "template"), matchesKeyword("tmpltae", "template")], [true, false]);
is("9+ letters: two typos match, three do not", [
  matchesKeyword("checklsit", "checklist"),
  matchesKeyword("chcklsit", "checklist"),
  matchesKeyword("chklsit", "checklist"),
], [true, true, false]);
is("4 letters or fewer: no typo at all (link / lynk)", [matchesKeyword("lynk", "link"), matchesKeyword("lnik", "link")], [false, false]);
is("the keyword's word decides the allowance", [matchesKeyword("guid", "guide"), matchesKeyword("linkk", "link")], [true, false]);
is("distance stops early above its bound", typoDistance("abcdefghij", "zyxwvutsrq", 2), 3);
is("distance counts a swap once", typoDistance("abcd", "abdc", 2), 1);
is("distance with a large length gap returns at once", typoDistance("a", "abcdefgh", 1), 2);

part("Digits");
is("code10 does not match code11", matchesKeyword("code10", "code11"), false);
is("code10 matches CODE10", matchesKeyword("CODE10 please", "code10"), true);
is("a long word with a digit allows no typo", matchesKeyword("promocode2026", "promocode2025"), false);
is("2026 does not match 2025", matchesKeyword("plan 2026", "2025"), false);

part("Whole words only");
is("guide is not in guidebook", matchesKeyword("my guidebook", "guide"), false);
is("art is not in party", matchesKeyword("party time", "art"), false);
is("guidebook does not match guide", matchesKeyword("guide", "guidebook"), false);
is("a word inside punctuation still counts", matchesKeyword("(guide)", "guide"), true);

part("Several words");
is("free guide matches 'free, guide!'", matchesKeyword("free, guide!", "free guide"), true);
is("and 'I want the FREE-GUIDES'", matchesKeyword("I want the FREE-GUIDES", "free guide"), true);
is("not when the words are apart", matchesKeyword("free stuff and a guide", "free guide"), false);
is("not in the other order", matchesKeyword("guide free", "free guide"), false);
is("not when the comment is shorter", matchesKeyword("free", "free guide"), false);
is("no typo in a 4-letter word of the keyword", matchesKeyword("send the freee guide", "free guide"), false);
is("a typo in a 5+ letter word of the keyword", matchesKeyword("send the mini cheklist", "mini checklist"), true);
is("first keyword in the creator's order", matchingKeyword("I want the recipes and the guide", ["guide", "recipe"]), "guide");
is("returned as the creator typed it", matchingKeyword("recipe please", ["Guide", "Recipes!"]), "Recipes!");
is("no keyword matches", matchingKeyword("nice photo", ["guide", "recipe"]), null);
is("an empty comment matches nothing", [matchesKeyword("", "guide"), matchesKeyword("🔥", "guide")], [false, false]);
is("an emoji-only keyword matches nothing", matchesKeyword("🔥", "🔥"), false);

part("Comment length cap");
const padding = "x ".repeat(COMMENT_MAX_CHARS / 2);
is("a keyword past the cap is not read", matchesKeyword(`${padding}guide`, "guide"), false);
is("a keyword just inside the cap is read", matchesKeyword(`${"x ".repeat(COMMENT_MAX_CHARS / 2 - 3)}guide`, "guide"), true);
is("the cap counts characters, not code units", matchesKeyword(`${"😀".repeat(COMMENT_MAX_CHARS - 6)} guide`, "guide"), true);
is("a huge comment returns", matchesKeyword("a ".repeat(1_000_000), "guide"), false);

part("A post's keywords");
is("kept as typed, trimmed", readKeywords(["  Free Guide ", "Recipe"]), { ok: true, keywords: ["Free Guide", "Recipe"] });
is("not a list, or an empty one", [readKeywords("guide"), readKeywords([])], [
  { ok: false, problem: "empty", index: -1 },
  { ok: false, problem: "empty", index: -1 },
]);
is("a blank keyword", readKeywords(["guide", "   "]), { ok: false, problem: "empty", index: 1 });
is("a keyword that is not text", readKeywords(["guide", 3]), { ok: false, problem: "empty", index: 1 });
const ten = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
is("ten keywords are allowed", readKeywords(ten).ok, true);
is("eleven are too many", readKeywords([...ten, "kilo"]), { ok: false, problem: "too_many", index: MAX_KEYWORDS_PER_POST });
is("40 characters are allowed", readKeywords(["a".repeat(KEYWORD_MAX_CHARS)]).ok, true);
is("41 are too long", readKeywords(["a".repeat(KEYWORD_MAX_CHARS + 1)]), { ok: false, problem: "too_long", index: 0 });
is("emoji count as one character each", readKeywords([`${"😀".repeat(30)} guide`]).ok, true);
is("four words are allowed, five are not", [readKeywords(["get my free guide"]).ok, readKeywords(["get my free guide now"])], [
  true,
  { ok: false, problem: "too_many_words", index: 0 },
]);
is("punctuation joins words as they are compared", readKeywords(["a-b-c-d-e"]), { ok: false, problem: "too_many_words", index: 0 });
is("emoji or punctuation only", [readKeywords(["🔥🔥"]), readKeywords(["guide", "!!!"])], [
  { ok: false, problem: "no_letters", index: 0 },
  { ok: false, problem: "no_letters", index: 1 },
]);
is("the same word in another case", readKeywords(["guide", "Guide"]), { ok: false, problem: "duplicate", index: 1, other: 0 });
is("a plural of an earlier one", readKeywords(["recipe", "guide", "guides"]), { ok: false, problem: "duplicate", index: 2, other: 1 });
is("a typo of an earlier one", readKeywords(["checklist", "cheklist"]), { ok: false, problem: "duplicate", index: 1, other: 0 });
is("one already covered by a shorter one", readKeywords(["guide", "free guide"]), { ok: false, problem: "duplicate", index: 1, other: 0 });
is("and the other way round", readKeywords(["free guide", "guide"]), { ok: false, problem: "duplicate", index: 1, other: 0 });
is("different words are fine", readKeywords(["link", "lynk", "code10", "code11"]).ok, true);

part("Repeat interval");
is("the choices", REPEAT_CHOICES.map((c) => [c.id, c.seconds]), [["once", null], ["1h", 3600], ["12h", 43200], ["24h", 86400], ["7d", 604800]]);
is("only those ids", [readRepeat("12h"), readRepeat("7d"), readRepeat("2h"), readRepeat(12), readRepeat(undefined)], ["12h", "7d", null, null, null]);
const now = 1_800_000_000;
is("never sent: yes, for every choice", REPEAT_CHOICES.map((c) => mayReplyAgain(null, now, c.id)), [true, true, true, true, true]);
is("once: never again", [mayReplyAgain(now - 10_000_000, now, "once"), mayReplyAgain(now, now, "once")], [false, false]);
is("12h: one second short, exactly, after", [
  mayReplyAgain(now - 43_199, now, "12h"),
  mayReplyAgain(now - 43_200, now, "12h"),
  mayReplyAgain(now - 43_201, now, "12h"),
], [false, true, true]);
is("1h and 7d at their boundaries", [
  mayReplyAgain(now - 3_599, now, "1h"),
  mayReplyAgain(now - 3_600, now, "1h"),
  mayReplyAgain(now - 604_799, now, "7d"),
  mayReplyAgain(now - 604_800, now, "7d"),
], [false, true, false, true]);
is("sent just now: no", mayReplyAgain(now, now, "1h"), false);
is("a last time in the future counts as just sent", [mayReplyAgain(now + 1, now, "1h"), mayReplyAgain(now + 999_999, now, "24h")], [false, false]);
is("a time that is not a number refuses", [mayReplyAgain(Number.NaN, now, "1h"), mayReplyAgain(null, Number.NaN, "1h")], [false, false]);
is("an unknown choice refuses", mayReplyAgain(null, now, "2h" as never), false);

part("Test mode and live mode");
is("off reaches nobody", mayReachPerson({ mode: "off", live: true, personId: "me_test", testerIds: ["me_test"] }), false);
is("test reaches a listed test account", mayReachPerson({ mode: "test", live: false, personId: "me_test", testerIds: ["me_test", "other.acct"] }), true);
is("test does not reach anyone else", mayReachPerson({ mode: "test", live: true, personId: "buyer1", testerIds: ["me_test"] }), false);
is("test with no test account reaches nobody", mayReachPerson({ mode: "test", live: true, personId: "buyer1", testerIds: [] }), false);
is("test with a list that fails reaches nobody", mayReachPerson({ mode: "test", live: false, personId: "a", testerIds: ["a", "b", "c", "d"] }), false);
is("live reaches nobody while AUTODM_LIVE is false", mayReachPerson({ mode: "live", live: AUTODM_LIVE, personId: "buyer1", testerIds: [] }), false);
is("live with live true", mayReachPerson({ mode: "live", live: true, personId: "buyer1", testerIds: [] }), true);
is("an unknown mode reaches nobody", mayReachPerson({ mode: "on" as never, live: true, personId: "a", testerIds: ["a"] }), false);

part("Test accounts");
is("up to three valid ids", readTesters(["me_test", "a.b-c", "X9"]), { ok: true, testers: ["me_test", "a.b-c", "X9"] });
is("an empty list is allowed", readTesters([]), { ok: true, testers: [] });
is("not a list", readTesters("me"), { ok: false, problem: "not_list", index: -1 });
is("four are too many", readTesters(["a", "b", "c", "d"]), { ok: false, problem: "too_many", index: MAX_TESTERS });
is("bad ids", [readTesters([""]), readTesters(["a b"]), readTesters(["@me"]), readTesters(["x".repeat(65)]), readTesters([7])], [
  { ok: false, problem: "bad_id", index: 0 },
  { ok: false, problem: "bad_id", index: 0 },
  { ok: false, problem: "bad_id", index: 0 },
  { ok: false, problem: "bad_id", index: 0 },
  { ok: false, problem: "bad_id", index: 0 },
]);
is("64 characters are allowed", readTesters(["x".repeat(64)]).ok, true);
is("the same id twice", readTesters(["me", "you", "me"]), { ok: false, problem: "duplicate", index: 2, other: 0 });

part("Counts per post");
is("empty counts", emptyCounts(), { sent: 0, clicked: 0, sold: 0 });
const before = { sent: 4, clicked: 1, sold: 0 };
const after = addCount(before, "sold");
is("addCount returns a new object", [after, after === before], [{ sent: 4, clicked: 1, sold: 1 }, false]);
is("and leaves the old one as it was", before, { sent: 4, clicked: 1, sold: 0 });
is("each kind", [addCount(emptyCounts(), "sent"), addCount(emptyCounts(), "clicked")], [
  { sent: 1, clicked: 0, sold: 0 },
  { sent: 0, clicked: 1, sold: 0 },
]);
is("a typical line", countsLine({ sent: 120, clicked: 30, sold: 4 }), "Sent 120 · 30 clicks · 4 sales");
is("singular", countsLine({ sent: 1, clicked: 1, sold: 1 }), "Sent 1 · 1 click · 1 sale");
is("zero is plural", countsLine(emptyCounts()), "Sent 0 · 0 clicks · 0 sales");
is("grouping", countsLine({ sent: 1_234_567, clicked: 1_234, sold: 999 }), "Sent 1,234,567 · 1,234 clicks · 999 sales");
is("a broken number shows as 0", countsLine({ sent: Number.NaN, clicked: -3, sold: 2.7 }), "Sent 0 · 0 clicks · 2 sales");

part("Link tag");
is("a valid rule id", dmLinkTag("abc123"), { name: "mm_dm", value: "abc123" });
is("24 characters", dmLinkTag("a".repeat(24)), { name: "mm_dm", value: "a".repeat(24) });
is("refused ids", [dmLinkTag("abc12"), dmLinkTag("a".repeat(25)), dmLinkTag("ABC123"), dmLinkTag("abc-123"), dmLinkTag("abc 123"), dmLinkTag(42 as never)], [
  null,
  null,
  null,
  null,
  null,
  null,
]);

done();
