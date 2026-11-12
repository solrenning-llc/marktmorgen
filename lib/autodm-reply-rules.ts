/**
 * AutoDM: a post's whole rule, the reply it sends and the decision for one
 * comment (added 5 November 2026; queue item 480 [SB3], unit 2, on top of
 * unit 1's lib/autodm-rules.ts). Pure and browser-safe: nothing here reads,
 * sends or keeps anything, and nothing calls a model, so this unit adds no
 * cost to any plan.
 *
 *   - the reply's text: what the person gets, typed by the creator, 1 to
 *     REPLY_MAX_CHARS characters, with no link typed by hand that the
 *     readers recognize (an address written to dodge them, such as
 *     "mara . com" or "mara[.]com", can still be typed as words; it is never
 *     made a link). The one link sent is the product's own page, added by the
 *     code with the rule's count tag (dmLinkTag), so every click and sale
 *     through it is counted for the post;
 *   - a post's whole rule (readAutoDmRule): every part checked by unit 1's
 *     readers, the product one the store sells now, and the first problem
 *     named with its field, in the order the studio shows the fields;
 *   - test before live: a rule may be saved live only once a test reply went
 *     out to one of the creator's test accounts for exactly this rule
 *     (ruleFingerprint, noteTested). Changing the keywords, the reply, the
 *     product, the post or the repeat interval asks for a new test; changing
 *     only the test accounts or the mode does not;
 *   - the decision for one comment (decideReply), in a fixed order so the
 *     cheapest refusal comes first and the channel unit only has to carry it
 *     out: the rule off, no id for the account the post belongs to, the
 *     account's own comment, a live rule never tested, the person out of
 *     reach (test accounts only in test mode, nobody live while AUTODM_LIVE
 *     is false, which the function holds itself whatever its caller says),
 *     no keyword, too soon for this person;
 *   - the studio's test box (tryComment) and every problem as one plain US
 *     English sentence (ruleProblemWords).
 *
 * What is NOT here, on purpose, as in unit 1: no number of Meta's (the
 * window in which a business may write to a person, a message's longest
 * length, rate limits, a fee per message). Meta's developer pages could not
 * be read from this environment on 4 and 5 November 2026 (the network policy
 * refuses developers.facebook.com). REPLY_MAX_CHARS is our own cap, chosen
 * short enough for one phone screen; it is not Meta's limit, and the channel
 * unit must hold it under whatever Meta allows, never above it. The channel
 * unit (receiving a comment, sending the reply) also needs, before it is
 * built: Meta's dated pages for those numbers, a priced and capped cost for
 * each comment received and each reply sent, and where a commenter's id is
 * kept and for how long (the repeat interval), with the privacy policy.
 */
import {
  AUTODM_LIVE,
  DEFAULT_MODE,
  DEFAULT_REPEAT,
  KEYWORD_MAX_CHARS,
  KEYWORD_MAX_WORDS,
  MAX_KEYWORDS_PER_POST,
  MAX_TESTERS,
  dmLinkTag,
  matchingKeyword,
  mayReachPerson,
  mayReplyAgain,
  readKeywords,
  readRepeat,
  readTesters,
  type AutoDmMode,
  type KeywordProblem,
  type RepeatId,
} from "@/lib/autodm-rules";
import { productSegment } from "@/lib/product-slug";

/**
 * The longest reply text, in characters as a person sees them: a family
 * emoji, a flag or an accent typed as a letter and a mark is one (grapheme
 * clusters, Intl.Segmenter). Our own cap, so a reply reads on one phone
 * screen; not Meta's limit.
 */
export const REPLY_MAX_CHARS = 500;
/**
 * A second cap, in code points, behind the character count: one character
 * can be stacked with any number of marks, which would make a short-looking
 * reply endless. 8 a character leaves room for 500 family emoji (7 each).
 */
export const REPLY_MAX_CODE_POINTS = 4_000;

/** Characters as a person sees them. */
function graphemes(text: string): number {
  let count = 0;
  for (const _ of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) count += 1;
  return count;
}

/** Why a reply's text was refused. */
export type ReplyProblem = "empty" | "too_long" | "link" | "control";

/**
 * Control characters (C0 and C1, tab included), the line and paragraph
 * separators (U+2028, U+2029), the invisible marks that turn text around or
 * isolate a run of it (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to
 * U+2069), the invisible spaces and operators (U+200B, U+2060 to U+2064,
 * U+FEFF) and the tag characters (U+E0000 to U+E007F), any of which could
 * make a reply read differently from what the creator saw. Kept: a line
 * break, the joiners real emoji and scripts are made of (U+200C, U+200D),
 * the emoji style mark (U+FE0F), and tags inside a subdivision flag (the
 * England flag is a black flag, tag letters and a cancel tag), removed
 * before this is tested. A lone half of a surrogate pair is refused too.
 */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}\ud800-\udfff]/u;
const SUBDIVISION_FLAG = /\u{1f3f4}[\u{e0030}-\u{e0039}\u{e0061}-\u{e007a}]{1,6}\u{e007f}/gu;

/**
 * The common ways a link is typed by hand: a scheme ("https://", "ftp://"),
 * "www.", any name with a path ("linktr.ee/chef", "t.co/abc"), or a name
 * ending, in lowercase, in one of the endings links in comments and bios use
 * most ("example.co", "example.de"). It is tested on the text with
 * compatibility forms folded (so full-width "ｅｘａｍｐｌｅ．ｃｏｍ" reads as
 * "example.com") and the joiners removed. A capitalized word after a dot
 * ("Sold out.Store opens Monday") is a sentence, not an ending, and "9.99",
 * "e.g." or "5p.m." are not links. Not a security boundary and not every
 * link there is (the reply is the creator's own words to their own
 * followers): it keeps the reply's one link the product's, which is counted.
 */
const LINK = [
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/[^\s/]/i,
  /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|io|co|ai|ee|me|to|tv|us|uk|ca|de|fr|es|it|nl|eu|br|app|link|ly|gg|shop|store|xyz|info|biz|online|bio|site|page)\b/,
];

/**
 * The reply's text as the creator typed it, trimmed, with Windows line ends
 * read as plain ones; or what is wrong with it. Anything that is not text is
 * "empty".
 */
export function readReplyText(input: unknown): { ok: true; text: string } | { ok: false; problem: ReplyProblem } {
  if (typeof input !== "string") return { ok: false, problem: "empty" };
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, problem: "empty" };
  if (CONTROL.test(text.replace(SUBDIVISION_FLAG, ""))) return { ok: false, problem: "control" };
  if (Array.from(text).length > REPLY_MAX_CODE_POINTS || graphemes(text) > REPLY_MAX_CHARS) return { ok: false, problem: "too_long" };
  const plain = text.normalize("NFKC").replace(/[\u200c\u200d]/g, "");
  if (LINK.some((pattern) => pattern.test(plain))) return { ok: false, problem: "link" };
  return { ok: true, text };
}

/** Our own shape for a post's id on the platform: 1 to 64 letters, digits, "_" or "-". */
const POST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One post's rule as it is kept. `tested` is the fingerprint of the rule
 * whose test reply last went out to a test account, or null.
 */
export type AutoDmRule = {
  id: string;
  post: string;
  keywords: string[];
  repeat: RepeatId;
  mode: AutoDmMode;
  testers: string[];
  reply: string;
  product: string;
  tested: string | null;
};

/** The parts of a rule, in the order the studio shows them and problems are named. */
export type RuleField = "id" | "post" | "keywords" | "repeat" | "mode" | "testers" | "reply" | "product";

/** The first thing wrong with a rule. `index` and `other` count from 0, as unit 1's readers do. */
export type RuleProblem =
  | { ok: false; field: "id" | "post" | "repeat" | "product"; problem: "bad" }
  | { ok: false; field: "mode"; problem: "bad" | "untested" }
  | { ok: false; field: "keywords"; problem: KeywordProblem; index: number; other?: number }
  | { ok: false; field: "testers"; problem: "not_list" | "too_many" | "bad_id" | "duplicate"; index: number; other?: number }
  | { ok: false; field: "reply"; problem: ReplyProblem };

/** A rule checked whole, or its first problem. */
export type RuleResult = { ok: true; rule: AutoDmRule } | RuleProblem;

const MODES: readonly AutoDmMode[] = ["off", "test", "live"];

/**
 * What a rule's test covers: the post, the keywords in order and as typed,
 * the repeat interval, the reply and the product. Each part is written with
 * its length, so text moved from one part to another never gives the same
 * fingerprint. The test accounts and the mode are left out: they decide who
 * gets the reply, not what it is.
 */
export function ruleFingerprint(rule: Pick<AutoDmRule, "post" | "keywords" | "repeat" | "reply" | "product">): string {
  return JSON.stringify([rule.post, rule.keywords, rule.repeat, rule.reply, rule.product]);
}

/** The rule marked as tested as it is now, as a new object; the one passed in is left as it was. */
export function noteTested(rule: AutoDmRule): AutoDmRule {
  return { ...rule, tested: ruleFingerprint(rule) };
}

/**
 * Checks a post's whole rule, as the studio or the API sends it, against the
 * ids of the products the store sells now. A repeat interval, mode or list of
 * test accounts left out takes its default (12 hours, test mode, none); one
 * sent but not one of the choices is refused, never replaced.
 *
 * `kept` is the test mark the server kept for this post's rule (noteTested,
 * after a test reply really went out), or null. A `tested` sent with the
 * rule is ignored: anyone can work out a fingerprint, so only the server's
 * own mark lets a rule be saved live, and only when it is the fingerprint of
 * the rule as sent now.
 */
export function readAutoDmRule(input: unknown, products: readonly { id: string }[], kept: string | null = null): RuleResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, field: "id", problem: "bad" };
  const value = input as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "";
  if (!dmLinkTag(id)) return { ok: false, field: "id", problem: "bad" };
  const post = typeof value.post === "string" ? value.post : "";
  if (!POST_ID.test(post)) return { ok: false, field: "post", problem: "bad" };
  const keywords = readKeywords(value.keywords);
  if (!keywords.ok) return { ok: false, field: "keywords", problem: keywords.problem, index: keywords.index, ...(keywords.other === undefined ? {} : { other: keywords.other }) };
  const repeat = "repeat" in value ? readRepeat(value.repeat) : DEFAULT_REPEAT;
  if (!repeat) return { ok: false, field: "repeat", problem: "bad" };
  const mode = "mode" in value ? MODES.find((m) => m === value.mode) ?? null : DEFAULT_MODE;
  if (!mode) return { ok: false, field: "mode", problem: "bad" };
  const testers = "testers" in value ? readTesters(value.testers) : readTesters([]);
  if (!testers.ok) return { ok: false, field: "testers", problem: testers.problem, index: testers.index, ...(testers.other === undefined ? {} : { other: testers.other }) };
  const reply = readReplyText(value.reply);
  if (!reply.ok) return { ok: false, field: "reply", problem: reply.problem };
  const product = typeof value.product === "string" ? value.product : "";
  if (!product || !products.some((p) => p.id === product)) return { ok: false, field: "product", problem: "bad" };
  const tested = typeof kept === "string" && kept ? kept : null;
  const rule: AutoDmRule = { id, post, keywords: keywords.keywords, repeat, mode, testers: testers.testers, reply: reply.text, product, tested };
  if (mode === "live" && tested !== ruleFingerprint(rule)) return { ok: false, field: "mode", problem: "untested" };
  return { ok: true, rule };
}

/** Why a comment gets no reply. */
export type SkipReason = "off" | "no_account" | "own" | "untested" | "not_reached" | "no_match" | "too_soon";

/** Send the rule's reply (and which keyword matched), or why not. */
export type Decision = { send: true; keyword: string } | { send: false; why: SkipReason };

/**
 * Whether one comment gets the rule's reply. `lastSentAtSeconds` is when this
 * person last got this post's reply (null for never); `ownAccountId` is the
 * account the post belongs to, without which nothing is sent, since its own
 * comment could not be told apart. `live` can only narrow: a live rule
 * reaches people only when the caller passes true AND AUTODM_LIVE is true,
 * so this function keeps its own lock. In order: the rule off; no account
 * id; the account's own comment (never answered, even when it is listed as
 * a test account);
 * a live rule whose test does not match it; the person out of reach; no
 * keyword in the comment; too soon for this person. The person is looked at
 * only after the rule and before the comment's words.
 */
export function decideReply(input: {
  rule: AutoDmRule;
  comment: string;
  personId: string;
  ownAccountId: string;
  lastSentAtSeconds: number | null;
  nowSeconds: number;
  live: boolean;
}): Decision {
  const { rule } = input;
  if (rule.mode === "off") return { send: false, why: "off" };
  // A blank value (spaces, a tab, a line break) names no account either: it is refused, never trimmed into another id (Codex G2's light).
  if (typeof input.ownAccountId !== "string" || !input.ownAccountId.trim()) return { send: false, why: "no_account" };
  if (input.personId === input.ownAccountId) return { send: false, why: "own" };
  if (rule.mode === "live" && rule.tested !== ruleFingerprint(rule)) return { send: false, why: "untested" };
  if (typeof input.personId !== "string" || !input.personId.trim() || !mayReachPerson({ mode: rule.mode, live: input.live === true && AUTODM_LIVE, personId: input.personId, testerIds: rule.testers })) {
    return { send: false, why: "not_reached" };
  }
  const keyword = matchingKeyword(input.comment, rule.keywords);
  if (keyword === null) return { send: false, why: "no_match" };
  if (!mayReplyAgain(input.lastSentAtSeconds, input.nowSeconds, rule.repeat)) return { send: false, why: "too_soon" };
  return { send: true, keyword };
}

/**
 * The reply as it is sent: the creator's text and, apart, the product's page
 * under the store's base address (lib/purchase-email.ts, storeBase: its own
 * domain or its address here) with only the rule's id added, the product's
 * part of the path encoded so nothing in an id can reach the query. Null
 * when the base is not a plain https address exactly as a browser would
 * read it (no user or password, query, fragment, trailing slash, "." or ".."
 * part, backslash or space), or the product is not the rule's.
 */
export function replyMessage(rule: AutoDmRule, base: string, product: { id: string; title: string }): { text: string; link: string } | null {
  const tag = dmLinkTag(rule.id);
  if (!tag || product.id !== rule.product) return null;
  if (!plainHttpsBase(base)) return null;
  return { text: rule.reply, link: `${base}/p/${encodeURIComponent(productSegment(product))}?${tag.name}=${tag.value}` };
}

/** Whether `base` is an https address with nothing a browser would read differently from how it is written. */
function plainHttpsBase(base: unknown): boolean {
  if (typeof base !== "string" || base.endsWith("/") || /[\s?#\\]/.test(base)) return false;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
  // A bare host reads back with "/" added; any other difference is a part the browser would read otherwise.
  return url.href === base || (url.pathname === "/" && url.href === `${base}/`);
}

const quote = (keyword: string) => `"${keyword}"`;

/**
 * The studio's test box: which keyword a typed comment matches, as the
 * creator typed it, and who would get the reply as the rule is now, never
 * more than decideReply would send to: nobody in test mode without test
 * accounts, nobody for a live rule without its test, nobody live while
 * AUTODM_LIVE is false whatever `live` says. Nothing is sent and the repeat
 * interval is not looked at.
 */
export function tryComment(rule: AutoDmRule, comment: string, live = AUTODM_LIVE): { matched: string | null; words: string } {
  const matched = matchingKeyword(comment, rule.keywords);
  if (matched === null) return { matched, words: "This comment doesn't match any keyword, so no reply is sent." };
  const who =
    rule.mode === "off"
      ? "This rule is off, so nobody gets the reply."
      : rule.mode === "test"
        ? rule.testers.length
          ? "In test mode, only your test accounts get the reply."
          : "In test mode, only your test accounts get the reply, and you haven't listed any yet, so nobody gets it."
        : rule.tested !== ruleFingerprint(rule)
          ? "This rule hasn't had a test reply yet, so nobody gets the reply."
          : live === true && AUTODM_LIVE
            ? "Everyone whose comment matches gets the reply."
            : "AutoDM can't send replies yet, so nobody gets the reply.";
  return { matched, words: `This comment matches ${quote(matched)}. ${who}` };
}

/** A place counted from 1 for people, or 0 when it is missing or not a whole number from 0. */
const nth = (index: number | undefined) => (Number.isSafeInteger(index) && (index as number) >= 0 ? (index as number) + 1 : 0);
/** "Keyword 2", or "A keyword" when the place is not known. */
const keywordAt = (n: number) => (n ? `Keyword ${n}` : "A keyword");
/** "Test account 2", or "A test account" when the place is not known. */
const testerAt = (n: number) => (n ? `Test account ${n}` : "A test account");

/** A rule's problem as one plain US English sentence for the creator; places counted from 1. */
export function ruleProblemWords(problem: RuleProblem): string {
  switch (problem.field) {
    case "id":
      return "Something went wrong saving this rule. Please try again.";
    case "post":
      return "Choose the post this rule answers.";
    case "repeat":
      return "Choose how often one person can get this reply.";
    case "mode":
      return problem.problem === "untested"
        ? "Send a test reply to one of your test accounts before you turn this rule on."
        : "Choose off, test or on for this rule.";
    case "product":
      return "Choose a product your store sells now.";
    case "reply":
      switch (problem.problem) {
        case "empty":
          return "Write the reply people get.";
        case "too_long":
          return `Use at most ${REPLY_MAX_CHARS} characters in the reply.`;
        case "link":
          return "Take the link out of the reply. The product's link is added for you, so its clicks and sales are counted.";
        case "control":
          return "Remove the hidden special characters from the reply.";
      }
      break;
    case "keywords": {
      const n = nth(problem.index);
      switch (problem.problem) {
        case "empty":
          return n ? `Keyword ${n} is empty. Type a word or remove it.` : "Add at least one keyword.";
        case "too_many":
          return `Use at most ${MAX_KEYWORDS_PER_POST} keywords on one post.`;
        case "too_long":
          return `${keywordAt(n)} is too long. Use at most ${KEYWORD_MAX_CHARS} characters.`;
        case "too_many_words":
          return `${keywordAt(n)} has too many words. Use at most ${KEYWORD_MAX_WORDS}.`;
        case "no_letters":
          return `${keywordAt(n)} needs at least one letter or number.`;
        case "duplicate": {
          const other = nth(problem.other);
          return `${keywordAt(n)} already matches ${other && other !== n ? `keyword ${other}` : "another keyword"}. Remove one of them.`;
        }
      }
      break;
    }
    case "testers": {
      const n = nth(problem.index);
      switch (problem.problem) {
        case "not_list":
          return "List your test accounts again, one per line.";
        case "too_many":
          return `List at most ${MAX_TESTERS} test accounts.`;
        case "bad_id":
          return `${testerAt(n)} is not an account ID. Use letters, numbers, "_", "." or "-".`;
        case "duplicate": {
          const other = nth(problem.other);
          return `${testerAt(n)} is the same as ${other && other !== n ? `test account ${other}` : "another test account"}. Remove one of them.`;
        }
      }
      break;
    }
  }
  return "Something went wrong saving this rule. Please try again.";
}
