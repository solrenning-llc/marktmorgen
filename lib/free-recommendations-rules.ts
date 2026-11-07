/**
 * Free recommendations between stores (119 [F2-FREE-RECOMMENDATIONS], unit 1):
 * the creator picks up to MAX_RECOMMENDATIONS other Marktmorgen stores, each
 * with one line of their own words, to show to a reader who has just joined
 * their list. Nobody pays for a place and none is sold: there is no paid
 * version of this.
 *
 * The rules, pure and browser-safe:
 *
 *   - The creator's list is read strictly (readRecommendations). Anything
 *     that is not exactly a list of { handle, why } is refused whole, with the
 *     first problem named in plain words (problemWords); it is never cut or
 *     half-read to fit. The store itself, the same store twice, an address no
 *     store can have, and a line with a link, a domain, an email address, a
 *     phone number, an IPv4 address, markup, a control character or any
 *     mark a reader cannot see are refused, read after NFKC normalization.
 *   - A recommendation links only to the other store's own page
 *     (recommendationHref): the address and nothing else. It never carries the
 *     reader's email, a referral code or a tracking parameter, and it never
 *     signs the reader up to anything. Joining that store is the reader's own
 *     choice, made on that store's page with its own confirmation.
 *   - A recommendation is shown only when the store it points to is confirmed
 *     live (shownRecommendations). Unknown, gone, a failed lookup or a list
 *     that does not read all mean nothing is shown, so a reader never follows
 *     a link to a closed store or to an address someone else took later.
 *
 * This unit reads, writes and shows nothing: saving the list in the studio,
 * how liveness is read (and what those reads cost) and the words a buyer sees
 * in each language (lib/buyer-words) are later units.
 */
import { hasUnsafeText } from "@/lib/funnel-bundle";
import { HANDLE_PATTERN } from "@/lib/store-handle-pattern";
import { isTopLevelDomain } from "@/lib/top-level-domains";

/** Stores one store may recommend. */
export const MAX_RECOMMENDATIONS = 3;
/** The longest line the creator may write about one store, in characters. */
export const MAX_WHY = 140;

export type StoreRecommendation = { handle: string; why: string };

export type RecommendationProblem =
  | "list"
  | "too-many"
  | "item"
  | "handle"
  | "own"
  | "repeat"
  | "why-empty"
  | "why-long"
  | "why-contact"
  | "why-unsafe";

export type RecommendationsRead =
  | { ok: true; list: StoreRecommendation[] }
  | { ok: false; problem: RecommendationProblem; index: number | null };

/** Whether a store says it is live: only "live" is shown. */
export type StoreLiveness = "live" | "gone" | "unknown";

/** An address as people type it: spaces, a leading @ and capitals do not matter. */
function normalised(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * A link, an email address, a domain or an IPv4 address: the button already
 * goes to the store. Read on the line normalized with NFKC, so full-width
 * letters, a full-width "@" and a full-width dot count as the plain ones.
 */
const CONTACT = [/\bhttps?:\/\//i, /\bwww[.\u3002]/i, /[^\s@]+@[^\s@]+[.\u3002][a-z]{2,}/i];

/**
 * What a domain label is made of: letters, digits, marks (a combining mark
 * still leaves a name a reader can type) and pictographs (an emoji name is a
 * real address on some endings). "_" and "-" are not, so a name right after
 * one ("my_store.com", "-evil.com") is still read.
 */
const LABEL = String.raw`[\p{L}\p{N}\p{M}\p{So}\p{Extended_Pictographic}]`;
/**
 * Every label followed by a dot and an ending of two letters or more (with any
 * marks on them), up to the next letter or digit. The ending is a lookahead,
 * so "SAM.Writes.COM" reads "Writes.COM" too.
 */
const DOMAIN = new RegExp(String.raw`(?<!${LABEL})${LABEL}(?:(?:${LABEL}|-)*${LABEL})?(?=\.(\p{L}\p{M}*(?:\p{L}\p{M}*)+)(?![\p{L}\p{N}]))`, "gu");
/** The ideographic full stop (U+3002), which an address bar reads as a dot, between Latin letters or digits; between CJK words it ends a sentence. */
const IDEOGRAPHIC_DOT = /(?<=[\p{Script=Latin}\p{N}]\p{M}*)\u3002(?=[\p{Script=Latin}\p{N}])/gu;
/** Four numbers of one to three digits joined by dots, not inside a longer run ("v1.2.3.4" is a version): an IPv4 address, read on the safe side (so "999.1.1.1" too). */
const IPV4 = /(?<![\p{L}\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?![\p{L}\p{N}]|\.\p{N})/u;

/**
 * Whether the line names a domain. Every ending all in lowercase (or in a
 * script with no capitals) is one, with no list of endings, so "shop.de" and
 * "evil.tv" are refused; only ".js", which is no ending at all, is let
 * through so "Node.js" reads as the word it is. An ending with a capital is
 * one when it is a real top-level domain ("EVIL.COM", "ASP.NET", "Socket.IO")
 * or not wholly in Latin letters (a look-alike letter from another script),
 * so a missing space after a sentence ("course.Highly"), a name ("Mr.Beast")
 * and initials ("EE.UU.") are words. A dot followed by a space, a digit or a
 * single letter is not one ("3.5", "9 a.m.", "e.g.", "U.S."). "evil dot com"
 * and "evil[.]com" are words too: no browser makes them a link.
 */
function hasDomain(text: string): boolean {
  const dotted = text.replace(IDEOGRAPHIC_DOT, ".");
  for (const match of dotted.matchAll(DOMAIN)) {
    const ending = match[1];
    if (!/\p{Lu}/u.test(ending)) {
      if (ending !== "js") return true;
    } else if (isTopLevelDomain(ending) || !/^\p{Script=Latin}+$/u.test(ending)) {
      return true;
    }
  }
  return IPV4.test(dotted);
}

/** A run of digits, spaces and dashes long enough to be a phone number: nine digits or more, so a span of years is not one. */
const hasPhone = (text: string) => (text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? []).some((run) => run.replace(/\D/g, "").length >= 9);

/**
 * Control characters, invisible format characters (\p{Cf}: zero-width spaces
 * and joiners, the soft hyphen, U+180E, direction marks and overrides, the
 * byte-order mark, tag characters) and every other mark a reader cannot see
 * (\p{Default_Ignorable_Code_Point}: the combining grapheme joiner, variation
 * selectors, Mongolian free variation selectors, Hangul fillers), which no
 * line of words needs. The one exception is the emoji presentation selector
 * (U+FE0F) or the text one (U+FE0E) right after a pictograph, as a phone types
 * "\u2764\ufe0f", or inside a keycap ("1\ufe0f\u20e3"): it changes how the
 * picture is drawn, and the picture is still read as part of any name around it.
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const PRESENTATION = /(?<=\p{Extended_Pictographic})[\ufe0e\ufe0f]|[\ufe0e\ufe0f](?=\u20e3)/gu;
const hasInvisible = (text: string) => CONTROL.test(text.replace(PRESENTATION, ""));

function lineProblem(raw: string): RecommendationProblem | null {
  if (hasInvisible(raw.replace(/[\n\r\t]/g, " "))) return "why-unsafe";
  const why = raw.replace(/\s+/g, " ").trim();
  if (!why) return "why-empty";
  if ([...why].length > MAX_WHY) return "why-long";
  // Checked as a browser or a reader would see it: full-width forms become the plain ones.
  const plain = why.normalize("NFKC");
  if (hasInvisible(plain) || hasUnsafeText(plain) || /[<>]/.test(plain)) return "why-unsafe";
  if (CONTACT.some((pattern) => pattern.test(plain)) || hasDomain(plain) || hasPhone(plain)) return "why-contact";
  return null;
}

/**
 * The creator's list, as saved or as sent from the studio. Never set means
 * none; anything else that is not exactly a list of { handle, why } is
 * refused with the first problem and the place it is at.
 */
export function readRecommendations(raw: unknown, ownHandle: string): RecommendationsRead {
  const own = typeof ownHandle === "string" ? normalised(ownHandle) : "";
  if (!HANDLE_PATTERN.test(own)) return { ok: false, problem: "own", index: null };
  if (raw === undefined) return { ok: true, list: [] };
  if (!Array.isArray(raw)) return { ok: false, problem: "list", index: null };
  if (raw.length > MAX_RECOMMENDATIONS) return { ok: false, problem: "too-many", index: null };
  const list: StoreRecommendation[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, problem: "item", index };
    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes("handle") || !keys.includes("why")) return { ok: false, problem: "item", index };
    const { handle: rawHandle, why: rawWhy } = item as Record<string, unknown>;
    if (typeof rawHandle !== "string" || typeof rawWhy !== "string") return { ok: false, problem: "item", index };
    const handle = normalised(rawHandle);
    if (!HANDLE_PATTERN.test(handle)) return { ok: false, problem: "handle", index };
    if (handle === own) return { ok: false, problem: "own", index };
    if (seen.has(handle)) return { ok: false, problem: "repeat", index };
    const problem = lineProblem(rawWhy);
    if (problem) return { ok: false, problem, index };
    seen.add(handle);
    list.push({ handle, why: rawWhy.replace(/\s+/g, " ").trim() });
  }
  return { ok: true, list };
}

/** What the studio says about a problem, naming the recommendation by its place (counted from 1). */
export function problemWords(problem: RecommendationProblem, index: number | null): string {
  const words = problemSentence(problem);
  return index === null ? words.charAt(0).toUpperCase() + words.slice(1) : `Recommendation ${index + 1}: ${words}`;
}

function problemSentence(problem: RecommendationProblem): string {
  switch (problem) {
    case "list":
      return "the list of recommendations could not be read. Check it and try again.";
    case "too-many":
      return `you can recommend up to ${MAX_RECOMMENDATIONS} stores.`;
    case "item":
      return `add a store's address and one line about it.`;
    case "handle":
      return `type the store's address, like sam.writes, as it appears after marktmorgen.com/@.`;
    case "own":
      return `choose another creator's store, not this one.`;
    case "repeat":
      return `this store is already on your list.`;
    case "why-empty":
      return `write one line about why you recommend this store.`;
    case "why-long":
      return `keep the line to ${MAX_WHY} characters or fewer.`;
    case "why-contact":
      return `leave out links, email addresses and phone numbers. The button already opens that store's page.`;
    case "why-unsafe":
      return `use plain words only, without code or special characters.`;
  }
}

/** The other store's own page and nothing else, or null for an address no store can have. */
export function recommendationHref(handle: string): string | null {
  const clean = normalised(handle);
  return HANDLE_PATTERN.test(clean) ? `/@${clean}` : null;
}

/** The link's words, whose purpose reads on their own (WCAG 2.4.9). */
export function recommendationLinkWords(handle: string): string {
  return `Visit @${normalised(handle)} on Marktmorgen`;
}

/**
 * The recommendations a reader may see: the creator's list, read strictly, in
 * the creator's order, keeping only the stores `liveness` confirms "live". A
 * list that does not read shows nothing at all, never a part of it.
 */
export function shownRecommendations(
  raw: unknown,
  ownHandle: string,
  liveness: (handle: string) => StoreLiveness | undefined,
): StoreRecommendation[] {
  const read = readRecommendations(raw, ownHandle);
  if (!read.ok) return [];
  return read.list.filter((recommendation) => {
    try {
      return liveness(recommendation.handle) === "live";
    } catch {
      return false;
    }
  });
}
