/**
 * AutoDM rule, reply and decision (480 [SB3], unit 2; lib/autodm-reply-rules.ts;
 * added 5 November 2026). Pure: nothing is read, sent or kept here. Checked:
 *
 *   - the reply's text: trimmed, 1 to REPLY_MAX_CHARS characters as a person
 *     sees them (a family emoji, a flag, an accent in two parts is one) under
 *     a code point cap, no link typed in the common ways (full-width and
 *     joined ones too; a capitalized word after a dot is a sentence), no
 *     control, invisible or tag character (the joiners real emoji use and an
 *     England flag kept), Windows line ends read as plain ones;
 *   - a post's whole rule: every part checked by unit 1's readers, the first
 *     problem named with its field (and its keyword or test account), the
 *     product one the store sells now, defaults for what was left out;
 *   - test before live: a rule saved live only when its test reply went out
 *     for exactly this rule, so any change to what people get asks for a new
 *     test;
 *   - the decision for one comment, in a fixed order: the rule off, no
 *     account id, the account's own comment, the person out of reach, no
 *     keyword, too soon; never a send while AUTODM_LIVE is false outside test
 *     mode, even when the caller passes live (the live path itself is unit
 *     1's mayReachPerson);
 *   - the reply's link: the store's own product page with only the rule id
 *     added, never who clicked; a base a browser would read otherwise is
 *     refused and the product's part is encoded;
 *   - the studio's test box, which never promises a reply decideReply would
 *     refuse, and every problem said in plain US English, never "keyword 0".
 */
import { AUTODM_LIVE, DEFAULT_MODE, DEFAULT_REPEAT, KEYWORD_MAX_CHARS, MAX_KEYWORDS_PER_POST, MAX_TESTERS, mayReachPerson } from "@/lib/autodm-rules";
import {
  REPLY_MAX_CHARS,
  REPLY_MAX_CODE_POINTS,
  decideReply,
  noteTested,
  readAutoDmRule,
  readReplyText,
  replyMessage,
  ruleFingerprint,
  ruleProblemWords,
  tryComment,
  type AutoDmRule,
} from "@/lib/autodm-reply-rules";
import { done, is, part } from "./check";

/** One behavior, its checks under one heading. */
function check(name: string, fn: () => void) {
  part(name);
  fn();
}
/** One comparison by value, named by what it compares. */
function equal(actual: unknown, expected: unknown, what = "") {
  is(what || "as expected", actual, expected);
}
/** A check that is not a comparison of two values. */
function holds(what: string, ok: boolean) {
  is(what, ok, true);
}

const PRODUCTS = [
  { id: "p1a2b3c4", title: "Free Guide" },
  { id: "k9x8y7z6", title: "Knife Skills: 10 Lessons" },
];
const BASE = "https://marktmorgen.com/@chef";

function input(over: Record<string, unknown> = {}) {
  return {
    id: "rule42abc",
    post: "17890012345",
    keywords: ["guide", "free"],
    repeat: "12h",
    mode: "test",
    testers: ["my_test_account"],
    reply: "Here is the guide you asked for. Enjoy!",
    product: "p1a2b3c4",
    tested: null,
    ...over,
  };
}
function rule(over: Record<string, unknown> = {}): AutoDmRule {
  const result = readAutoDmRule(input(over), PRODUCTS);
  if (!result.ok) throw new Error(`fixture refused: ${JSON.stringify(result)}`);
  return result.rule;
}

// The reply's text.
check("a reply is trimmed and kept as typed", () => {
  equal(readReplyText("  Here you go!  "), { ok: true, text: "Here you go!" });
});
check("an empty or blank reply is refused", () => {
  equal(readReplyText(""), { ok: false, problem: "empty" });
  equal(readReplyText("   \n "), { ok: false, problem: "empty" });
  equal(readReplyText(undefined), { ok: false, problem: "empty" });
  equal(readReplyText(42), { ok: false, problem: "empty" });
});
check("a reply at the cap passes, one character more is too long, counted in characters not code units", () => {
  equal(readReplyText("a".repeat(REPLY_MAX_CHARS)).ok, true);
  equal(readReplyText("a".repeat(REPLY_MAX_CHARS + 1)), { ok: false, problem: "too_long" });
  // An emoji is one character to a person, two code units to JavaScript.
  equal(readReplyText("😀".repeat(REPLY_MAX_CHARS)).ok, true);
});
check("characters are counted as a person sees them: a family emoji, a flag or an accent typed in two parts is one", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"; // 7 code points, 1 character
  equal(readReplyText(family.repeat(100)).ok, true, "100 families");
  equal(readReplyText("\u{1F1E7}\u{1F1F7}".repeat(260)).ok, true, "260 flags");
  equal(readReplyText("e\u0301".repeat(300)).ok, true, "300 accents in two parts");
  equal(readReplyText(family.repeat(REPLY_MAX_CHARS)).ok, true, "500 families");
  equal(readReplyText(family.repeat(REPLY_MAX_CHARS + 1)), { ok: false, problem: "too_long" }, "501 families");
});
check("a character stacked with endless marks is too long, by a code point cap behind the character count", () => {
  equal(readReplyText("a" + "\u0301".repeat(REPLY_MAX_CODE_POINTS)), { ok: false, problem: "too_long" });
  equal(REPLY_MAX_CODE_POINTS >= REPLY_MAX_CHARS * 8, true, "room for 500 family emoji");
});
check("a link typed into the reply is refused: the product's link is added by the code", () => {
  for (const text of [
    "Get it at https://example.com/guide",
    "Go to http://bit.ly/x",
    "Visit www.example.com",
    "Visit WWW.Example.com now",
    "see example.com/guide",
    "see shop.example.store",
    "mylink.ly",
    "ftp://files.example.net",
    "linktr.ee/chef",
    "chef.studio/free",
    "Go to Chef.Academy/start",
    "t.co/abc",
    "beacons.ai/chef",
    "example.co/x",
    "find me on example.de",
    "see example.co",
    "see example\u200D.com/guide",
    "see ｅｘａｍｐｌｅ．ｃｏｍ",
    "ＷＷＷ．example.org",
  ]) {
    equal(readReplyText(text), { ok: false, problem: "link" }, text);
  }
});
check("ordinary sentences with dots are not links", () => {
  for (const text of ["Thanks.Enjoy it!", "e.g. the first lesson", "It's 9.99 today", "Hi, Mr. Smith", "See you at 5p.m.", "Sold out.Store opens Monday", "Thanks.Shop again soon", "Done.Co-op members first", "and/or both"]) {
    equal(readReplyText(text).ok, true, text);
  }
});
check("control characters are refused; line breaks are kept, Windows line ends read as plain ones", () => {
  equal(readReplyText("Hi\u0000there"), { ok: false, problem: "control" });
  equal(readReplyText("Hi\u0007there"), { ok: false, problem: "control" });
  equal(readReplyText("Hi\u009bthere"), { ok: false, problem: "control" });
  equal(readReplyText("Hi\tthere"), { ok: false, problem: "control" });
  equal(readReplyText("Hi\r\nthere"), { ok: true, text: "Hi\nthere" });
  equal(readReplyText("Line one\n\nLine two"), { ok: true, text: "Line one\n\nLine two" });
});
check("invisible direction marks that could hide what the reply says are refused", () => {
  equal(readReplyText("Hi\u202Ethere"), { ok: false, problem: "control" });
  equal(readReplyText("Hi\u2066there"), { ok: false, problem: "control" });
  for (const mark of ["\u061C", "\u200B", "\u2060", "\uFEFF", "\u2028", "\u2029", "\u{E0041}", "\u{E007F}", "\uD800", "\uDC00"]) {
    equal(readReplyText(`Hi${mark}there`), { ok: false, problem: "control" }, `U+${mark.codePointAt(0)!.toString(16)}`);
  }
});
check("the joiners and the emoji style mark that real emoji are made of are kept, and so is the England flag", () => {
  equal(readReplyText("Team \u{1F468}\u200D\u{1F373} \u2764\uFE0F").ok, true, "cook and red heart");
  equal(readReplyText("Go \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}!").ok, true, "England flag");
  equal(readReplyText("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645").ok, true, "a Persian word with its non-joiner");
});

// A post's whole rule.
check("a complete rule is read with every part as typed", () => {
  const result = readAutoDmRule(input({ keywords: [" Guide ", "free"] }), PRODUCTS);
  equal(result, {
    ok: true,
    rule: {
      id: "rule42abc",
      post: "17890012345",
      keywords: ["Guide", "free"],
      repeat: "12h",
      mode: "test",
      testers: ["my_test_account"],
      reply: "Here is the guide you asked for. Enjoy!",
      product: "p1a2b3c4",
      tested: null,
    },
  });
});
check("what was left out takes the defaults: 12 hours, test mode, no test accounts, never tested", () => {
  const result = readAutoDmRule({ id: "rule42abc", post: "1789", keywords: ["guide"], reply: "Here it is", product: "p1a2b3c4" }, PRODUCTS);
  if (!result.ok) throw new Error(JSON.stringify(result));
  equal([result.rule.repeat, result.rule.mode, result.rule.testers, result.rule.tested], [DEFAULT_REPEAT, DEFAULT_MODE, [], null]);
});
check("a rule that is not an object is refused at its id", () => {
  for (const value of [null, undefined, "x", 3, []]) equal(readAutoDmRule(value, PRODUCTS), { ok: false, field: "id", problem: "bad" }, String(value));
});
check("an id the link tag would not carry is refused", () => {
  for (const id of ["", "ABCDEF12", "short", "x".repeat(25), "rule-42abc", 42]) equal(readAutoDmRule(input({ id }), PRODUCTS), { ok: false, field: "id", problem: "bad" }, String(id));
});
check("a post id must be 1 to 64 letters, digits, '_' or '-'", () => {
  equal(readAutoDmRule(input({ post: "a".repeat(64) }), PRODUCTS).ok, true);
  for (const post of ["", "a".repeat(65), "17 89", "../x", 1789]) equal(readAutoDmRule(input({ post }), PRODUCTS), { ok: false, field: "post", problem: "bad" }, String(post));
});
check("keyword problems come back with the keyword's place, from unit 1's reader", () => {
  equal(readAutoDmRule(input({ keywords: [] }), PRODUCTS), { ok: false, field: "keywords", problem: "empty", index: -1 });
  equal(readAutoDmRule(input({ keywords: ["guide", "Guides"] }), PRODUCTS), { ok: false, field: "keywords", problem: "duplicate", index: 1, other: 0 });
  equal(readAutoDmRule(input({ keywords: ["x".repeat(KEYWORD_MAX_CHARS + 1)] }), PRODUCTS), { ok: false, field: "keywords", problem: "too_long", index: 0 });
  equal(readAutoDmRule(input({ keywords: Array.from({ length: MAX_KEYWORDS_PER_POST + 1 }, (_, i) => `word${i}`) }), PRODUCTS), { ok: false, field: "keywords", problem: "too_many", index: MAX_KEYWORDS_PER_POST });
});
check("a repeat or a mode that is not one of the choices is refused, not replaced by the default", () => {
  equal(readAutoDmRule(input({ repeat: "2h" }), PRODUCTS), { ok: false, field: "repeat", problem: "bad" });
  equal(readAutoDmRule(input({ repeat: null }), PRODUCTS), { ok: false, field: "repeat", problem: "bad" });
  equal(readAutoDmRule(input({ mode: "on" }), PRODUCTS), { ok: false, field: "mode", problem: "bad" });
  equal(readAutoDmRule(input({ mode: null }), PRODUCTS), { ok: false, field: "mode", problem: "bad" });
});
check("test account problems come back with the account's place", () => {
  equal(readAutoDmRule(input({ testers: ["a", "a"] }), PRODUCTS), { ok: false, field: "testers", problem: "duplicate", index: 1, other: 0 });
  equal(readAutoDmRule(input({ testers: ["bad id"] }), PRODUCTS), { ok: false, field: "testers", problem: "bad_id", index: 0 });
  equal(readAutoDmRule(input({ testers: "a" }), PRODUCTS), { ok: false, field: "testers", problem: "not_list", index: -1 });
});
check("reply problems come back at the reply", () => {
  equal(readAutoDmRule(input({ reply: "" }), PRODUCTS), { ok: false, field: "reply", problem: "empty" });
  equal(readAutoDmRule(input({ reply: "go to www.x.com" }), PRODUCTS), { ok: false, field: "reply", problem: "link" });
});
check("the product must be one the store sells now, by its id", () => {
  equal(readAutoDmRule(input({ product: "gone1234" }), PRODUCTS), { ok: false, field: "product", problem: "bad" });
  equal(readAutoDmRule(input({ product: "" }), PRODUCTS), { ok: false, field: "product", problem: "bad" });
  equal(readAutoDmRule(input({ product: "Free Guide" }), PRODUCTS), { ok: false, field: "product", problem: "bad" });
  equal(readAutoDmRule(input({ product: "p1a2b3c4" }), []), { ok: false, field: "product", problem: "bad" });
});
check("the first problem in field order is the one named", () => {
  equal(readAutoDmRule(input({ post: "", keywords: [], reply: "" }), PRODUCTS), { ok: false, field: "post", problem: "bad" });
  equal(readAutoDmRule(input({ keywords: [], reply: "" }), PRODUCTS), { ok: false, field: "keywords", problem: "empty", index: -1 });
});

// Test before live.
check("a rule never tested cannot be saved live", () => {
  equal(readAutoDmRule(input({ mode: "live", tested: null }), PRODUCTS), { ok: false, field: "mode", problem: "untested" });
});
check("a rule whose test reply went out for exactly this rule can be saved live", () => {
  const tested = noteTested(rule());
  equal(readAutoDmRule({ ...tested, mode: "live" }, PRODUCTS, tested.tested).ok, true);
});
check("changing what people get, who gets it again or which post after the test asks for a new test", () => {
  const tested = noteTested(rule());
  for (const change of [{ keywords: ["guide"] }, { reply: "Changed text" }, { product: "k9x8y7z6" }, { repeat: "1h" }, { post: "999" }]) {
    equal(readAutoDmRule({ ...tested, ...change, mode: "live" }, PRODUCTS, tested.tested), { ok: false, field: "mode", problem: "untested" }, JSON.stringify(change));
  }
});
check("changing the test accounts or the mode alone keeps the test", () => {
  const tested = noteTested(rule());
  equal(readAutoDmRule({ ...tested, testers: [], mode: "live" }, PRODUCTS, tested.tested).ok, true);
  const off: AutoDmRule = { ...tested, mode: "off" };
  equal(ruleFingerprint(off), ruleFingerprint(tested));
});
check("a fingerprint keeps keyword order and exact spelling: a change of either is a change", () => {
  const base = rule();
  equal(ruleFingerprint(rule({ keywords: ["free", "guide"] })) === ruleFingerprint(base), false);
  equal(ruleFingerprint(rule({ keywords: ["Guide", "free"] })) === ruleFingerprint(base), false);
});
check("a fingerprint cannot be forged by moving text between fields", () => {
  const a = rule({ keywords: ["guide"], reply: "free stuff" });
  const b = rule({ keywords: ["guide free"], reply: "stuff" });
  equal(ruleFingerprint(a) === ruleFingerprint(b), false);
});
check("one keyword of two words and two keywords of one word each are different rules", () => {
  equal(ruleFingerprint(rule({ keywords: ["free guide"] })) === ruleFingerprint(rule({ keywords: ["free", "guide"] })), false);
});
check("a test mark sent with the rule is ignored: only the mark the server kept lets it go live", () => {
  const forged = ruleFingerprint(rule());
  equal(readAutoDmRule(input({ mode: "live", tested: forged }), PRODUCTS), { ok: false, field: "mode", problem: "untested" });
  const kept = readAutoDmRule(input({ tested: forged }), PRODUCTS);
  equal(kept.ok && kept.rule.tested, null);
  equal(readAutoDmRule(input({ mode: "live" }), PRODUCTS, forged).ok, true);
});
check("a kept mark that is not text, or is empty, counts as never tested", () => {
  for (const kept of [5, "", undefined, {}] as unknown[]) {
    equal(readAutoDmRule(input({ mode: "live" }), PRODUCTS, kept as string | null), { ok: false, field: "mode", problem: "untested" }, String(kept));
  }
});
check("noteTested leaves the rule passed in as it was", () => {
  const base = rule();
  const marked = noteTested(base);
  equal(base.tested, null);
  equal(marked.tested, ruleFingerprint(base));
});

// The decision for one comment.
const NOW = 2_000_000_000;
function decide(over: Partial<Parameters<typeof decideReply>[0]> = {}) {
  return decideReply({ rule: rule(), comment: "guide please!", personId: "my_test_account", ownAccountId: "chef_account", lastSentAtSeconds: null, nowSeconds: NOW, live: AUTODM_LIVE, ...over });
}
check("a test account's matching comment in test mode gets the reply, with the keyword it matched", () => {
  equal(decide(), { send: true, keyword: "guide" });
});
check("a rule that is off sends nothing, before anything else is looked at", () => {
  equal(decide({ rule: rule({ mode: "off" }), comment: "", personId: "" }), { send: false, why: "off" });
});
check("the account's own comment on its own post never gets the reply, even when it is a test account", () => {
  equal(decide({ personId: "chef_account", rule: rule({ testers: ["chef_account"] }) }), { send: false, why: "own" });
});
check("in test mode, anyone who is not a test account is out of reach", () => {
  equal(decide({ personId: "a_buyer" }), { send: false, why: "not_reached" });
});
check("live mode reaches nobody while AUTODM_LIVE is false, even when the caller says live", () => {
  equal(AUTODM_LIVE, false);
  const live = { ...noteTested(rule()), mode: "live" as const };
  equal(decide({ rule: live, personId: "a_buyer" }), { send: false, why: "not_reached" });
  equal(decide({ rule: live, personId: "a_buyer", live: true }), { send: false, why: "not_reached" });
  // The live path itself, once AutoDM is live, is unit 1's mayReachPerson, which decideReply asks.
  equal(mayReachPerson({ mode: "live", live: true, personId: "a_buyer", testerIds: [] }), true);
});
check("a live rule never tested sends nothing even if live were on", () => {
  const untested = { ...rule(), mode: "live" as const };
  equal(decide({ rule: untested, personId: "a_buyer", live: true }), { send: false, why: "untested" });
});
check("no keyword in the comment: nothing is sent", () => {
  equal(decide({ comment: "love this" }), { send: false, why: "no_match" });
  equal(decide({ comment: "guidebook" }), { send: false, why: "no_match" });
});
check("the same person again inside the repeat interval: too soon; after it: sent", () => {
  equal(decide({ lastSentAtSeconds: NOW - 43_199 }), { send: false, why: "too_soon" });
  equal(decide({ lastSentAtSeconds: NOW - 43_200 }), { send: true, keyword: "guide" });
  equal(decide({ rule: rule({ repeat: "once" }), lastSentAtSeconds: NOW - 10_000_000 }), { send: false, why: "too_soon" });
});
check("a missing person id or own account id never sends", () => {
  equal(decide({ personId: "" }), { send: false, why: "not_reached" });
  equal(decide({ rule: rule({ testers: [] }) }), { send: false, why: "not_reached" });
  // Without the account's own id, its own comment could not be told apart: nothing is sent.
  equal(decide({ rule: rule({ testers: ["chef"] }), comment: "guide", personId: "chef", ownAccountId: "" }), { send: false, why: "no_account" });
  equal(decide({ ownAccountId: "" }), { send: false, why: "no_account" });
  equal(decide({ ownAccountId: undefined as unknown as string }), { send: false, why: "no_account" });
  equal(decide({ ownAccountId: 7 as unknown as string }), { send: false, why: "no_account" });
  // A blank value names no account and no person: refused, never trimmed into another id (Codex G2's light on #2499).
  for (const blank of [" ", "\t", "\r\n", "\u00a0 "]) {
    equal(decide({ rule: rule({ testers: ["chef"] }), comment: "guide", personId: "chef", ownAccountId: blank }), { send: false, why: "no_account" });
    equal(decide({ personId: blank }), { send: false, why: "not_reached" });
  }
});

// The reply's link.
check("the reply carries the store's own product page with only the rule id added", () => {
  equal(replyMessage(rule(), BASE, PRODUCTS[0]), {
    text: "Here is the guide you asked for. Enjoy!",
    link: "https://marktmorgen.com/@chef/p/free-guide-p1a2b3c4?mm_dm=rule42abc",
  });
});
check("a creator's own domain works the same", () => {
  equal(replyMessage(rule({ product: "k9x8y7z6" }), "https://chef.example", PRODUCTS[1])?.link, "https://chef.example/p/knife-skills-10-lessons-k9x8y7z6?mm_dm=rule42abc");
});
check("no link when the base is not https, ends in a slash, carries a query, or the product is not the rule's", () => {
  equal(replyMessage(rule(), "http://marktmorgen.com/@chef", PRODUCTS[0]), null);
  equal(replyMessage(rule(), "https://marktmorgen.com/@chef/", PRODUCTS[0]), null);
  equal(replyMessage(rule(), "https://marktmorgen.com/@chef?x=1", PRODUCTS[0]), null);
  equal(replyMessage(rule(), "https://marktmorgen.com/@chef#x", PRODUCTS[0]), null);
  equal(replyMessage(rule(), "javascript:alert(1)", PRODUCTS[0]), null);
  equal(replyMessage(rule(), "https://marktmorgen.com@evil.example/@chef", PRODUCTS[0]), null);
  equal(replyMessage(rule(), "https://marktmorgen.com/@chef/..", PRODUCTS[0]), null, "dot segments");
  equal(replyMessage(rule(), "https://marktmorgen.com/@other/../@chef", PRODUCTS[0]), null, "dot segments inside");
  equal(replyMessage(rule(), "https://evil.example\\marktmorgen.com", PRODUCTS[0]), null, "backslash");
  equal(replyMessage(rule(), "https://user:pw@marktmorgen.com/@chef", PRODUCTS[0]), null, "user and password");
  equal(replyMessage(rule(), "https://marktmorgen.com/@chef?", PRODUCTS[0]), null, "empty query");
  equal(replyMessage(rule(), "https://marktmorgen.com/@chef#", PRODUCTS[0]), null, "empty fragment");
  equal(replyMessage(rule(), "https://marktmorgen.com/@ch ef", PRODUCTS[0]), null, "space");
  equal(replyMessage(rule(), BASE, PRODUCTS[1]), null);
});
check("a product id with link characters is written into the path, never into the query", () => {
  const odd = { id: "x?mm_dm=other99#", title: "" };
  const r = readAutoDmRule(input({ product: odd.id }), [odd]);
  if (!r.ok) throw new Error(JSON.stringify(r));
  equal(replyMessage(r.rule, BASE, odd)?.link, "https://marktmorgen.com/@chef/p/x%3Fmm_dm%3Dother99%23?mm_dm=rule42abc");
});
check("the link never names the person, the post or the keyword", () => {
  const link = replyMessage(rule(), BASE, PRODUCTS[0])!.link;
  for (const word of ["my_test_account", "17890012345", "guide&", "keyword", "person"]) equal(link.includes(word), false, word);
});

// The studio's test box and the words.
check("the test box says which keyword matched and who would get the reply in each mode", () => {
  equal(tryComment(rule(), "GUIDES!!"), { matched: "guide", words: 'This comment matches "guide". In test mode, only your test accounts get the reply.' });
  equal(tryComment(rule({ mode: "off" }), "guide"), { matched: "guide", words: 'This comment matches "guide". This rule is off, so nobody gets the reply.' });
  const live = { ...noteTested(rule()), mode: "live" as const };
  equal(tryComment(live, "guide").words, AUTODM_LIVE ? 'This comment matches "guide". Everyone who comments it gets the reply.' : 'This comment matches "guide". AutoDM can\'t send replies yet, so nobody gets the reply.');
});
check("the test box never says someone gets a reply that decideReply would refuse", () => {
  equal(tryComment(rule({ testers: [] }), "guide").words, 'This comment matches "guide". In test mode, only your test accounts get the reply, and you haven\'t listed any yet, so nobody gets it.');
  const untested = { ...rule(), mode: "live" as const };
  equal(tryComment(untested, "guide", true).words, 'This comment matches "guide". This rule hasn\'t had a test reply yet, so nobody gets the reply.');
  equal(tryComment(untested, "guide").words, 'This comment matches "guide". This rule hasn\'t had a test reply yet, so nobody gets the reply.');
  const tested = { ...noteTested(rule()), mode: "live" as const };
  equal(tryComment(tested, "guide", true).words, 'This comment matches "guide". AutoDM can\'t send replies yet, so nobody gets the reply.', "the caller cannot open what AUTODM_LIVE keeps shut");
});
check("the test box says plainly when nothing matches", () => {
  equal(tryComment(rule(), "love this"), { matched: null, words: "This comment doesn't match any keyword, so no reply is sent." });
});
check("the test box shows the keyword as the creator typed it", () => {
  equal(tryComment(rule({ keywords: ["Free Guide"] }), "free guides").matched, "Free Guide");
});
check("every problem has one plain US English sentence, numbered from 1 for people", () => {
  const sentences = [
    ruleProblemWords({ ok: false, field: "id", problem: "bad" }),
    ruleProblemWords({ ok: false, field: "post", problem: "bad" }),
    ruleProblemWords({ ok: false, field: "keywords", problem: "empty", index: -1 }),
    ruleProblemWords({ ok: false, field: "keywords", problem: "empty", index: 2 }),
    ruleProblemWords({ ok: false, field: "keywords", problem: "too_many", index: 10 }),
    ruleProblemWords({ ok: false, field: "keywords", problem: "too_long", index: 0 }),
    ruleProblemWords({ ok: false, field: "keywords", problem: "too_many_words", index: 0 }),
    ruleProblemWords({ ok: false, field: "keywords", problem: "no_letters", index: 0 }),
    ruleProblemWords({ ok: false, field: "keywords", problem: "duplicate", index: 1, other: 0 }),
    ruleProblemWords({ ok: false, field: "repeat", problem: "bad" }),
    ruleProblemWords({ ok: false, field: "mode", problem: "bad" }),
    ruleProblemWords({ ok: false, field: "mode", problem: "untested" }),
    ruleProblemWords({ ok: false, field: "testers", problem: "not_list", index: -1 }),
    ruleProblemWords({ ok: false, field: "testers", problem: "too_many", index: 3 }),
    ruleProblemWords({ ok: false, field: "testers", problem: "bad_id", index: 0 }),
    ruleProblemWords({ ok: false, field: "testers", problem: "duplicate", index: 1, other: 0 }),
    ruleProblemWords({ ok: false, field: "reply", problem: "empty" }),
    ruleProblemWords({ ok: false, field: "reply", problem: "too_long" }),
    ruleProblemWords({ ok: false, field: "reply", problem: "link" }),
    ruleProblemWords({ ok: false, field: "reply", problem: "control" }),
    ruleProblemWords({ ok: false, field: "product", problem: "bad" }),
  ];
  equal(new Set(sentences).size, sentences.length, "every sentence is its own");
  for (const sentence of sentences) {
    holds(`a sentence: ${sentence}`, /^[A-Z].*\.$/.test(sentence));
    holds(`no code word: ${sentence}`, !/\bundefined\b|NaN|-1|\bindex\b/.test(sentence));
  }
  equal(ruleProblemWords({ ok: false, field: "keywords", problem: "duplicate", index: 1, other: 0 }), "Keyword 2 already matches keyword 1. Remove one of them.");
  equal(ruleProblemWords({ ok: false, field: "keywords", problem: "too_long", index: 0 }), `Keyword 1 is too long. Use at most ${KEYWORD_MAX_CHARS} characters.`);
  equal(ruleProblemWords({ ok: false, field: "testers", problem: "too_many", index: 3 }), `List at most ${MAX_TESTERS} test accounts.`);
  equal(ruleProblemWords({ ok: false, field: "reply", problem: "too_long" }), `Use at most ${REPLY_MAX_CHARS} characters in the reply.`);
  equal(ruleProblemWords({ ok: false, field: "reply", problem: "link" }), "Take the link out of the reply. The product's link is added for you, so its clicks and sales are counted.");
  equal(ruleProblemWords({ ok: false, field: "mode", problem: "untested" }), "Send a test reply to one of your test accounts before you turn this rule on.");
});
check("a problem with a missing or broken place never says keyword 0 or test account NaN", () => {
  for (const index of [undefined, NaN, -1, 1.5, Infinity] as unknown as number[]) {
    for (const problem of ["too_long", "too_many_words", "no_letters", "duplicate"] as const) {
      const words = ruleProblemWords({ ok: false, field: "keywords", problem, index, other: index });
      holds(`keywords ${problem} at ${index}: ${words}`, !/\b0\b|NaN|undefined|Infinity|-1|1\.5/.test(words) && /^A keyword /.test(words));
    }
    for (const problem of ["bad_id", "duplicate"] as const) {
      const words = ruleProblemWords({ ok: false, field: "testers", problem, index, other: index });
      holds(`testers ${problem} at ${index}: ${words}`, !/\b0\b|NaN|undefined|Infinity|-1|1\.5/.test(words) && /^A test account /.test(words));
    }
  }
  equal(ruleProblemWords({ ok: false, field: "keywords", problem: "duplicate", index: 1 }), "Keyword 2 already matches another keyword. Remove one of them.");
});

done();
