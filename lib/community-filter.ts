/**
 * The community's word filter and spam check (113 [E2-COMMUNITY-MODERATION],
 * unit 1; added 1 November 2026): what decides that a post or a comment is
 * held for the creator to look at before anyone else sees it.
 *
 * Held, never deleted: once wired (next unit), a held text goes to the
 * moderation list that already exists (lib/community.ts, the reported list)
 * for the creator to decide, and the member is told it waits for the host.
 * A false alarm costs a member a wait, not their words. Nothing is guessed
 * by a model and nothing leaves the store.
 *
 * Two reasons, each said in words to the creator:
 *
 *   word   a word or phrase on the creator's own list, matched whole, without
 *          caring about capitals, accents, ß, invisible characters, or a
 *          dash, dot or underscore between its words ("cafe" holds "Café",
 *          "dm me" holds "dm-me", "spam" does not hold "spammer" unless the
 *          creator lists that too). In writing with no spaces between words
 *          (Chinese, Japanese), an entry in that writing matches anywhere;
 *   links  more web addresses in one text than FILTER_MAX_LINKS, counted as
 *          the community shows them as links (lib/community-text.ts,
 *          linkCount), from a member, never from the creator.
 *
 * The list is the creator's: up to FILTER_MAX_WORDS entries of up to
 * FILTER_MAX_WORD_LENGTH characters. Keeping it with the community and
 * holding a post on it are the next unit.
 *
 * Browser-safe: plain data and pure functions, so the studio shows the same
 * rule the server applies.
 */
import { linkCount } from "@/lib/community-text";

export const FILTER_MAX_WORDS = 50;
export const FILTER_MAX_WORD_LENGTH = 40;
/** A member's text with more web addresses than this is held: two are a conversation, three are usually an advertisement. */
export const FILTER_MAX_LINKS = 2;

/**
 * How a list entry and a text are compared, never what is kept: invisible
 * characters taken out (soft hyphens and joiners cannot split a word), wide
 * and joined letters made plain, accents off, lower case, ß as ss, a dash,
 * dot or underscore between letters or digits as a space, every run of
 * spaces one space.
 */
export function foldText(text: string): string {
  return text
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/(?<=[\p{L}\p{N}])[-_.](?=[\p{L}\p{N}])/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Writing with no spaces between words: there an entry cannot be told apart as a whole word, so it matches anywhere. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** The creator's list as kept: folded, each once, empty and too long ones left out, at most FILTER_MAX_WORDS. */
export function readFilterWords(raw: unknown): string[] {
  const entries = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\r\n,]/) : [];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const word = foldText(entry);
    if (!word || word.length > FILTER_MAX_WORD_LENGTH || out.includes(word)) continue;
    out.push(word);
    if (out.length === FILTER_MAX_WORDS) break;
  }
  return out;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type HoldReason = { kind: "word"; word: string } | { kind: "links"; count: number };

/**
 * Why a text is held, or null when it goes up as it does today. `byCreator`
 * is true for the community's own creator and team, who are never held.
 */
export function holdReason(text: string, words: readonly string[], byCreator = false): HoldReason | null {
  if (byCreator) return null;
  const folded = foldText(text);
  for (const word of words) {
    // Whole words and phrases: a letter or digit right before or after an entry that starts or ends with one means another word.
    const before = UNSPACED.test(word) || !/^[\p{L}\p{N}]/u.test(word) ? "" : "(?<![\\p{L}\\p{N}])";
    const after = UNSPACED.test(word) || !/[\p{L}\p{N}]$/u.test(word) ? "" : "(?![\\p{L}\\p{N}])";
    if (new RegExp(`${before}${escape(word)}${after}`, "u").test(folded)) return { kind: "word", word };
  }
  const links = linkCount(text);
  if (links > FILTER_MAX_LINKS) return { kind: "links", count: links };
  return null;
}

/** What the creator reads beside a held post or comment. */
export function holdWords(reason: HoldReason): string {
  return reason.kind === "word"
    ? `Held for you to look at: it uses "${reason.word}", which is on your list of words to check.`
    : `Held for you to look at: it has ${reason.count} links, more than ${FILTER_MAX_LINKS}, so you can check it is not advertising.`;
}

/** What the member is told, without saying which word or rule, so the filter is not taught how to be dodged. */
export const HELD_FOR_MEMBER = "Thanks. This is waiting for the community's host to review it before others can see it.";
