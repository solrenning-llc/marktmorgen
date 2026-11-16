/**
 * The community's word filter and spam check (113 [E2-COMMUNITY-MODERATION],
 * unit 1; added 1 November 2026): what decides that a post or a comment is
 * held for the creator to look at before anyone else sees it.
 *
 * Held, never deleted: a held post or comment goes to the queue of what
 * waits for the creator's approval (unit 2.1, 16 November 2026: the queue of
 * 543 [CM2], lib/community-approval.ts, holdPost and holdComment), where the
 * creator approves it as written or does not publish it, and its author is
 * told it waits, in the store's language, by the same fixed sentence as any
 * held post (lib/buyer-words/community-approval.ts), never which word or
 * rule. A false alarm costs a member a wait, not their words. Nothing is
 * guessed by a model and nothing leaves the store.
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
 * FILTER_MAX_WORD_LENGTH characters, kept with the community's settings
 * (CommunityConfig.filter, lib/community.ts) with whether the links rule is
 * on; filterHold is what the community's route asks of every member's post
 * and comment. A list that was saved and cannot be read holds everything a
 * member sends until the creator saves it again: unknown is never clean.
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

export type HoldReason = { kind: "word"; word: string } | { kind: "links"; count: number } | { kind: "unread" };

/**
 * The creator's filter as the community keeps it: the list, and whether a
 * member's text with more than FILTER_MAX_LINKS links is held. Off by
 * default: a community nobody set a filter for holds nothing by it.
 */
export type CommunityFilter = { words: string[]; links: boolean };

/** The filter as it is kept, or null when it is there and not exactly a filter (then everything waits). */
export function parseFilter(raw: unknown): CommunityFilter | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (!Array.isArray(v.words) || v.words.length > FILTER_MAX_WORDS || typeof v.links !== "boolean") return null;
  const words = readFilterWords(v.words);
  // Kept already folded and clean: anything else was not written by this code.
  if (words.length !== v.words.length || words.some((word, i) => word !== (v.words as unknown[])[i])) return null;
  return { words, links: v.links };
}

/**
 * Why a member's post or comment waits for the creator, or null when the
 * filter lets it go up. `parts` are each piece of it a reader sees (title,
 * text, a poll's answers, a picture's description), matched one by one so a
 * phrase never runs across two; links are counted over all of them. The
 * creator and the team are never held. `filter` undefined: none was ever
 * set; null: one was set and cannot be read, so it waits ("unread").
 */
export function filterHold(filter: CommunityFilter | null | undefined, parts: readonly string[], byCreator = false): HoldReason | null {
  if (byCreator || filter === undefined) return null;
  if (filter === null) return { kind: "unread" };
  for (const part of parts) {
    const reason = holdReason(part, filter.words);
    if (reason?.kind === "word") return reason;
  }
  if (!filter.links) return null;
  const count = linkCount(parts.join("\n"));
  return count > FILTER_MAX_LINKS ? { kind: "links", count } : null;
}

/** A reason as a held item keeps it, or null for anything that is not exactly one. */
export function parseHoldReason(raw: unknown): HoldReason | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v.kind === "unread") return { kind: "unread" };
  if (v.kind === "links" && typeof v.count === "number" && Number.isSafeInteger(v.count) && v.count > FILTER_MAX_LINKS) return { kind: "links", count: v.count };
  if (v.kind === "word" && typeof v.word === "string" && v.word.length > 0 && v.word.length <= FILTER_MAX_WORD_LENGTH) return { kind: "word", word: v.word };
  return null;
}

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
  if (reason.kind === "unread") return "Held for you to look at: your list of words to check could not be read when it was sent, so it waited instead of going up unchecked.";
  return reason.kind === "word"
    ? `Held for you to look at: it uses "${reason.word}", which is on your list of words to check.`
    : `Held for you to look at: it has ${reason.count} links, more than ${FILTER_MAX_LINKS}, so you can check it is not advertising.`;
}

/** What the member is told, without saying which word or rule, so the filter is not taught how to be dodged. */
export const HELD_FOR_MEMBER = "Thanks. This is waiting for the community's host to review it before others can see it.";
