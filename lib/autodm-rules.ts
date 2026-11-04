/**
 * AutoDM rules (added 4 November 2026; queue item 480 [SB3], the complement
 * to 39 [G1] AutoDM). Pure and browser-safe: nothing here reads, sends or
 * keeps anything. These are the decisions an automatic reply to a comment
 * needs before any channel is involved:
 *
 *   - which keyword a comment matches. Matching forgives case, accents, a
 *     simple English plural and a small typo ("Guides!!", "gude", "café" for
 *     "cafe"), but never matches inside a longer word ("guide" is not in
 *     "guidebook", "art" is not in "party") and never forgives a digit
 *     ("code10" is not "code11"). The creator's own words are only normalized
 *     to compare them; what they typed is kept and shown as they typed it;
 *   - which keywords one post may have: a few, short, with letters or digits,
 *     and none that another one on the same post already covers;
 *   - how often one person may get the reply again, chosen by the creator
 *     from a short list. The default is once every 12 hours, which is what
 *     Stan fixes for everyone (Stan's help center says once every 12 hours;
 *     not re-verified today);
 *   - who may get it: a new rule starts in test mode, where only the
 *     creator's own listed test accounts get the reply, and nobody gets
 *     anything while AUTODM_LIVE is false;
 *   - what is counted per post: replies sent, clicks on the link in them and
 *     sales from those clicks, as three numbers and nothing about anyone. A
 *     link in a reply carries only the rule's id (dmLinkTag), never who
 *     clicked it.
 *
 * What is NOT here, on purpose. Meta's official documentation for Instagram
 * and Facebook messaging (replies to comments, the window in which a business
 * may write to a person, rate limits, app review) could not be read from the
 * environment this was written in on 4 November 2026, so no Meta number is in
 * this file: no 24-hour or 7-day window, no limit per hour. That is an open
 * evidence gap to close from Meta's own pages, dated, before the channel unit
 * is built; the creator's repeat interval below never replaces whatever Meta
 * allows, it can only be stricter. WhatsApp is the same, and TikTok only if an
 * official API allows it, recorded with its source and date (480 [SB3]).
 * Nothing calls a model here, so this unit adds no cost to any plan.
 */

/**
 * No AutoDM reaches anyone until Meta has approved the app (39 [G1]); nothing
 * reads this as true yet.
 */
export const AUTODM_LIVE = false;

/** The longest keyword, in characters, after trimming the spaces around it. */
export const KEYWORD_MAX_CHARS = 40;
/** The most words one keyword may have, counted as it is compared. */
export const KEYWORD_MAX_WORDS = 4;
/** The most keywords one post may have. */
export const MAX_KEYWORDS_PER_POST = 10;
/**
 * Only this many characters of a comment are looked at. Our own cap, to keep
 * the work per comment bounded; it is not taken from any platform's limit.
 */
export const COMMENT_MAX_CHARS = 2_200;

/**
 * The text as it is compared, never as it is shown: lowercase, accents and
 * other combining marks removed (so "Café" compares as "cafe"), every run of
 * characters that are neither letters nor digits turned into one space, and
 * the spaces at both ends removed.
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokensOf(text: string): string[] {
  const normal = normalizeForMatch(text);
  return normal ? normal.split(" ") : [];
}

/**
 * The forms a word may be compared under: the word itself and, for a simple
 * English plural, its singular. "es" comes off when what is left ends in s,
 * x, z, ch or sh ("boxes", "classes"); "ies" becomes "y" ("stories"); else a
 * single "s" comes off a word longer than 3 letters that does not end in
 * "ss" ("guides", but never "glass"). Both are kept where more than one rule
 * fits ("cases" gives "cas" and "case"), so a match needs one form in common.
 */
export function pluralForms(word: string): string[] {
  const forms = [word];
  const add = (form: string) => {
    if (form && !forms.includes(form)) forms.push(form);
  };
  const length = Array.from(word).length;
  if (length > 4 && word.endsWith("ies")) add(`${word.slice(0, -3)}y`);
  if (word.endsWith("es") && /(?:s|x|z|ch|sh)$/.test(word.slice(0, -2))) add(word.slice(0, -2));
  if (length > 3 && word.endsWith("s") && !word.endsWith("ss")) add(word.slice(0, -1));
  return forms;
}

/**
 * How many typos a comment's word may have against a keyword's word: none
 * when either holds a digit or the keyword's word has 4 letters or fewer, 1
 * when it has 5 to 8, 2 when it has 9 or more. The keyword's word decides, so
 * a missing letter ("gude" for "guide") is forgiven but a short keyword never
 * is ("lynk" and "linkk" are not "link").
 */
export function typoAllowance(word: string, token: string): number {
  if (/\p{N}/u.test(word) || /\p{N}/u.test(token)) return 0;
  const letters = Array.from(word).length;
  if (letters <= 4) return 0;
  return letters <= 8 ? 1 : 2;
}

/**
 * Optimal string alignment distance (insertions, deletions, substitutions and
 * a swap of two neighbouring letters, each counted once), computed only as
 * far as it needs to: anything above `bound` comes back as bound + 1.
 */
export function typoDistance(a: string, b: string, bound: number): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > bound) return bound + 1;
  if (!x.length || !y.length) return Math.max(x.length, y.length);
  let before: number[] = [];
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        value = Math.min(value, before[j - 2] + 1);
      }
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > bound) return bound + 1;
    before = previous;
    previous = current;
  }
  return Math.min(previous[y.length], bound + 1);
}

function wordMatches(token: string, word: string): boolean {
  if (token === word) return true;
  const tokenForms = pluralForms(token);
  if (pluralForms(word).some((form) => tokenForms.includes(form))) return true;
  const allowance = typoAllowance(word, token);
  return allowance > 0 && typoDistance(token, word, allowance) <= allowance;
}

function tokensMatch(tokens: string[], words: string[]): boolean {
  if (!words.length) return false;
  for (let start = 0; start + words.length <= tokens.length; start += 1) {
    if (words.every((word, k) => wordMatches(tokens[start + k], word))) return true;
  }
  return false;
}

/** The first COMMENT_MAX_CHARS characters of a comment, stopping early on a long one. */
function capped(comment: string): string {
  if (comment.length <= COMMENT_MAX_CHARS) return comment;
  let out = "";
  let count = 0;
  for (const character of comment) {
    if (count === COMMENT_MAX_CHARS) break;
    out += character;
    count += 1;
  }
  return out;
}

/**
 * Whether a comment holds the keyword: a keyword of N words matches N words
 * in a row of the comment, each the same once compared, the same plural, or
 * within the typo allowance. Only whole words match, and only the first
 * COMMENT_MAX_CHARS characters of the comment are read.
 */
export function matchesKeyword(comment: string, keyword: string): boolean {
  if (typeof comment !== "string" || typeof keyword !== "string") return false;
  return tokensMatch(tokensOf(capped(comment)), tokensOf(keyword));
}

/**
 * The first of the post's keywords, in the creator's order, that the comment
 * matches, as the creator typed it; null when none does.
 */
export function matchingKeyword(comment: string, keywords: readonly string[]): string | null {
  if (typeof comment !== "string") return null;
  const tokens = tokensOf(capped(comment));
  for (const keyword of keywords) {
    if (typeof keyword === "string" && tokensMatch(tokens, tokensOf(keyword))) return keyword;
  }
  return null;
}

/** Why a post's keyword list was refused, and at which keyword (from 0). */
export type KeywordProblem = "empty" | "too_many" | "too_long" | "too_many_words" | "no_letters" | "duplicate";

/** A post's keywords as the creator typed them, or the first thing wrong with them. */
export type KeywordsResult =
  | { ok: true; keywords: string[] }
  | { ok: false; problem: KeywordProblem; index: number; other?: number };

/**
 * Checks a post's keyword list. Each keyword has 1 to KEYWORD_MAX_CHARS
 * characters once the spaces around it are trimmed, at least one letter or
 * digit, and at most KEYWORD_MAX_WORDS words; a post has 1 to
 * MAX_KEYWORDS_PER_POST of them. Two keywords where one would match the other
 * ("guide" and "Guides", or "guide" and "free guide") are refused as
 * duplicates: `index` is the later one, `other` the one it collides with. A
 * list that is not a list, or holds nothing, is "empty" at index -1. The
 * keywords come back trimmed and otherwise exactly as typed.
 */
export function readKeywords(input: unknown): KeywordsResult {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, problem: "empty", index: -1 };
  if (input.length > MAX_KEYWORDS_PER_POST) return { ok: false, problem: "too_many", index: MAX_KEYWORDS_PER_POST };
  const keywords: string[] = [];
  const words: string[][] = [];
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index];
    const keyword = typeof raw === "string" ? raw.trim() : "";
    if (!keyword) return { ok: false, problem: "empty", index };
    if (Array.from(keyword).length > KEYWORD_MAX_CHARS) return { ok: false, problem: "too_long", index };
    const tokens = tokensOf(keyword);
    if (!tokens.length) return { ok: false, problem: "no_letters", index };
    if (tokens.length > KEYWORD_MAX_WORDS) return { ok: false, problem: "too_many_words", index };
    for (let other = 0; other < words.length; other += 1) {
      if (tokensMatch(words[other], tokens) || tokensMatch(tokens, words[other])) {
        return { ok: false, problem: "duplicate", index, other };
      }
    }
    keywords.push(keyword);
    words.push(tokens);
  }
  return { ok: true, keywords };
}

/**
 * How often one person may get a post's reply again, chosen by the creator:
 * once per post, or again after 1 hour, 12 hours, 24 hours or 7 days.
 */
export const REPEAT_CHOICES = [
  { id: "once", seconds: null },
  { id: "1h", seconds: 3_600 },
  { id: "12h", seconds: 43_200 },
  { id: "24h", seconds: 86_400 },
  { id: "7d", seconds: 604_800 },
] as const;

/** One of the repeat choices. */
export type RepeatId = (typeof REPEAT_CHOICES)[number]["id"];

/** A new rule's repeat interval: 12 hours (Stan's help center says once every 12 hours; not re-verified today). */
export const DEFAULT_REPEAT: RepeatId = "12h";

/** A repeat choice's id, or null for anything else. */
export function readRepeat(input: unknown): RepeatId | null {
  return REPEAT_CHOICES.find((choice) => choice.id === input)?.id ?? null;
}

/**
 * Whether a person may get the reply again: always when never sent; never
 * again for "once"; else only once the interval has passed in full. A last
 * time in the future (a clock that disagrees) counts as just sent, and a
 * time that is not a number refuses.
 */
export function mayReplyAgain(lastSentAtSeconds: number | null, nowSeconds: number, repeat: RepeatId): boolean {
  const choice = REPEAT_CHOICES.find((c) => c.id === repeat);
  if (!choice || !Number.isFinite(nowSeconds)) return false;
  if (lastSentAtSeconds === null) return true;
  if (!Number.isFinite(lastSentAtSeconds)) return false;
  if (choice.seconds === null) return false;
  if (lastSentAtSeconds > nowSeconds) return false;
  return nowSeconds - lastSentAtSeconds >= choice.seconds;
}

/** Off: nobody. Test: only the creator's test accounts. Live: everyone, once AutoDM is live. */
export type AutoDmMode = "off" | "test" | "live";

/** A new rule starts in test mode. */
export const DEFAULT_MODE: AutoDmMode = "test";

/** The most test accounts a creator may list. */
export const MAX_TESTERS = 3;

const TESTER_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** The creator's test accounts, or the first thing wrong with the list (index -1 when it is not a list). */
export type TestersResult =
  | { ok: true; testers: string[] }
  | { ok: false; problem: "not_list" | "too_many" | "bad_id" | "duplicate"; index: number; other?: number };

/**
 * Checks the creator's own test accounts: at most MAX_TESTERS ids, each 1 to
 * 64 letters, digits, "_", "." or "-", none twice. An empty list is allowed
 * (then test mode reaches nobody).
 */
export function readTesters(input: unknown): TestersResult {
  if (!Array.isArray(input)) return { ok: false, problem: "not_list", index: -1 };
  if (input.length > MAX_TESTERS) return { ok: false, problem: "too_many", index: MAX_TESTERS };
  const testers: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const id = input[index];
    if (typeof id !== "string" || !TESTER_ID.test(id)) return { ok: false, problem: "bad_id", index };
    const other = testers.indexOf(id);
    if (other >= 0) return { ok: false, problem: "duplicate", index, other };
    testers.push(id);
  }
  return { ok: true, testers };
}

/**
 * Whether a rule's reply may go to this person: never when off; in test mode
 * only to one of the creator's test accounts (a list that fails readTesters
 * reaches nobody); in live mode only when `live` is true (callers pass
 * AUTODM_LIVE).
 */
export function mayReachPerson(input: {
  mode: AutoDmMode;
  live: boolean;
  personId: string;
  testerIds: readonly string[];
}): boolean {
  if (input.mode === "live") return input.live === true;
  if (input.mode !== "test") return false;
  const testers = readTesters(input.testerIds);
  return testers.ok && typeof input.personId === "string" && testers.testers.includes(input.personId);
}

/** One post's counts, with nothing about anyone: replies sent, clicks on their link, sales from those clicks. */
export type AutoDmCounts = { sent: number; clicked: number; sold: number };

/** A post's counts before anything happened. */
export function emptyCounts(): AutoDmCounts {
  return { sent: 0, clicked: 0, sold: 0 };
}

/** The counts with one more of `kind`, as a new object; the one passed in is left as it was. */
export function addCount(counts: AutoDmCounts, kind: keyof AutoDmCounts): AutoDmCounts {
  return { ...counts, [kind]: whole(counts[kind]) + 1 };
}

function whole(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function grouped(n: number): string {
  return String(whole(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The counts in one line of plain US English: "Sent 1,234 · 30 clicks · 1 sale". */
export function countsLine(counts: AutoDmCounts): string {
  const clicks = whole(counts.clicked);
  const sales = whole(counts.sold);
  return `Sent ${grouped(counts.sent)} · ${grouped(clicks)} ${clicks === 1 ? "click" : "clicks"} · ${grouped(sales)} ${sales === 1 ? "sale" : "sales"}`;
}

const RULE_ID = /^[a-z0-9]{6,24}$/;

/**
 * The query parameter added to a reply's link so a click and a sale can be
 * counted for the rule: `mm_dm=<rule id>`, the rule only, never the person.
 * Null for an id that is not 6 to 24 lowercase letters and digits.
 */
export function dmLinkTag(ruleId: string): { name: "mm_dm"; value: string } | null {
  return typeof ruleId === "string" && RULE_ID.test(ruleId) ? { name: "mm_dm", value: ruleId } : null;
}
