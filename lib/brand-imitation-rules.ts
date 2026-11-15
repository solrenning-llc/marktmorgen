/**
 * Words that pose as Marktmorgen itself (568 [GD2] (c), unit 1): a product or
 * a sales page that reads as if it came from Marktmorgen's sign-in, its
 * account or its staff, or that links to an address only made to look like
 * marktmorgen.com, is how a buyer is tricked into giving away a sign-in or a
 * card. The Terms give a creator no right to use our name "except as needed
 * to identify the Services" (section 10) and forbid anything that misleads a
 * buyer ("What you may not sell"), so such words keep a product off the store,
 * the same way a promise of fast money does (lib/terms-check-rules.ts).
 *
 * Pure and fixed: no model, no request, nothing changed. Kept narrow on
 * purpose, so a creator saying where the store runs ("Sold on Marktmorgen",
 * "Marktmorgen emails you a link to your library") is never stopped. What
 * blocks, each only in the same sentence as the name Marktmorgen:
 *   - speaking as its staff: a line that starts or signs off as "Marktmorgen
 *     Support", "The Marktmorgen security team", "Marktmorgen staff" ("Regards,
 *     The Marktmorgen Team"), or "we at Marktmorgen", "this is Marktmorgen";
 *     "an official Marktmorgen ..." (naming its support, as in "contact
 *     Marktmorgen support", or thanking its team, is let through);
 *   - its account in trouble: suspended, locked, closed, unusual activity,
 *     or "verify your account / identity / payment / card";
 *   - a password: Marktmorgen has none, so any sentence that pairs the name
 *     with one is asking for something that does not exist;
 * and, anywhere in the text or in a link of the page, an address that reads
 * as marktmorgen (letters swapped for look-alikes included) but is not
 * marktmorgen.com or one of its subdomains: "marktmorgen-login.com",
 * "marktmorgen.com.pay-now.io", "rnarktmorgen.com".
 * A sentence that says the opposite is let through, because it protects the
 * buyer: "Marktmorgen will never ask for your password", "this is not an
 * official Marktmorgen product".
 *
 * The text read is capped at MAX_TEXT characters and a page's links at
 * MAX_LINKS, so a pasted book costs a bounded amount of work.
 */

export const MAX_TEXT = 60_000;
export const MAX_LINKS = 500;
/** Characters shown on each side of a passage. */
const AROUND = 40;

export type ImitationField = "title" | "summary" | "about" | "page";
/** Where a product is stopped: the field, the passage, why and the fix, in the shape the studio's refusals read. */
export type BrandImitation = { field: ImitationField; excerpt: string; why: string; fix: string; product?: string };

export const IMITATION_WHY =
  "This reads as if it came from Marktmorgen itself: its sign-in, its account or its staff, or an address made to look like ours. The Terms let you use our name only to say your store runs on Marktmorgen, and nothing may mislead your buyers, so the product cannot be published with it.";
export const IMITATION_FIX =
  "Write as yourself, in your own name, and link only to your own pages or to marktmorgen.com itself. Marktmorgen never asks anyone for a password.";

/**
 * The same reason for what is not a product (568 [GD2] (c)): a store's own page, a funnel's page, an email to the
 * list. `outcome` says what does not happen with it ("the page cannot be shown with it").
 */
export function imitationWhy(outcome: string): string {
  return IMITATION_WHY.replace(/so the product cannot be published with it\.$/, `so ${outcome}.`);
}

/**
 * The studio's sentence for such a refusal, in the shape of the other refusals (fastMoneyMessage in
 * lib/terms-check-rules.ts): what did not happen, where, the passage, why, the fix, and that nothing was changed.
 */
export function imitationMessage(passage: unknown, where: string, lead: string): string {
  const p = passage && typeof passage === "object" ? (passage as Record<string, unknown>) : {};
  const words = typeof p.excerpt === "string" ? p.excerpt.trim().replace(/[.,;:!?]+$/, "") : "";
  const quoted = words ? `: “${words}”` : "";
  const why = typeof p.why === "string" && p.why ? p.why : IMITATION_WHY;
  const fix = typeof p.fix === "string" && p.fix ? p.fix : IMITATION_FIX;
  return `${lead}. In ${where}${quoted}. ${why} ${fix} Nothing you wrote was changed.`;
}

/** The name, as people write it: "Marktmorgen", "Markt Morgen", "Markt-Morgen", "MARKTMORGEN". */
const BRAND_ALL = /\bmarkt[\s-]?morgen\b/gi;

/** Speaking as its staff, right after the name ("Marktmorgen Support", "Marktmorgen's security team"). */
const STAFF_AFTER = /^(?:['’]s)?\s+(?:support|security|billing|trust(?:\s+(?:and|&)\s+safety)?|safety|payments?|help\s?desk|customer\s+(?:service|care|support)|admins?|administrators?|staff|moderators?|compliance|verification|fraud|accounts?\s+team|team)\b/i;
/** What may stand before a staff name for it to be the speaker: nothing, a dash or "the" (a line or a sign-off). */
const SPEAKER_START = /^[\s\-\u2013\u2014~*>"'\u201c]*(?:the\s+)?$/i;
/** A sign-off word before it: "Regards, the Marktmorgen Team", "Thanks, Marktmorgen Support". */
const SIGN_OFF = /\b(?:regards|sincerely|thanks|thank\s+you|cheers|best|warmly|yours|signed|from)\s*[,!.:\-\u2013\u2014]*\s*(?:the\s+)?$/i;
/** Speaking as it, whatever comes after: "we at Marktmorgen", "we, the Marktmorgen", "this is Marktmorgen". */
const SPEAKING_AS = /\b(?:we|us)\s*,?\s*(?:(?:here\s+)?at|from)?\s*(?:the\s+)?$|\bthis\s+is\s+(?:the\s+)?$/i;
/** "Official" right before or right after the name. */
const OFFICIAL_BEFORE = /\bofficial\s+$/i;
const OFFICIAL_AFTER = /^\s+official\b/i;
/** The account in trouble, anywhere in the sentence with the name. */
const TROUBLE = /\b(?:suspend(?:ed|s|ing)?|suspension|locked|deactivat(?:ed|e|ion)|disabled|terminated|unusual\s+(?:activity|sign[\s-]?in|login)|security\s+alert|verify\s+your\s+(?:account|identity|payment|card|details|information)|confirm\s+your\s+(?:identity|account|payment|card|billing|details)|update\s+your\s+(?:payment|billing|card)\s+(?:details|information|method))\b/i;
/** A password, anywhere in the sentence with the name: Marktmorgen has none. */
const PASSWORD = /\bpass(?:word|code)s?\b/i;
/** A "no" before the words in the same sentence makes it the protective opposite. */
const NEGATION = /\b(?:never|not|no|nobody|no\s+one|won['’]t|will\s+not|doesn['’]t|does\s+not|don['’]t|isn['’]t|is\s+not|aren['’]t|without)\b/i;

/** A host written in text: with a scheme, "www." or a known ending. */
const HOST = /\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi;

/** Letters a look-alike address swaps in, read back as the letters they imitate. */
function plainLetters(host: string): string {
  return host
    .toLowerCase()
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/0/g, "o")
    .replace(/[1|]/g, "l")
    .replace(/3/g, "e")
    .replace(/[^a-z.]/g, "");
}

/** Whether a host reads as Marktmorgen's without being marktmorgen.com or one of its subdomains. */
export function lookalikeHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (host === "marktmorgen.com" || host.endsWith(".marktmorgen.com")) return false;
  return plainLetters(host).replace(/\./g, "").includes("marktmorgen");
}

function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - AROUND);
  const end = Math.min(text.length, index + length + AROUND);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/** The sentence around `index`: from the last stop before it to the next one after it. */
function sentenceAround(text: string, index: number): { start: number; end: number } {
  let start = index;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !/[.!?\n]/.test(text[end])) end += 1;
  return { start, end };
}

/** The first passage of `text` that poses as Marktmorgen: where it is and how long; null when there is none. */
export function imitationIn(rawText: unknown): { at: number; length: number } | null {
  if (typeof rawText !== "string" || !rawText) return null;
  const text = rawText.slice(0, MAX_TEXT);

  for (const m of text.matchAll(HOST)) {
    const at = m.index ?? 0;
    // Written in capitals ("Marktmorgen.Thanks"), a sentence run together, not an address: an address is typed in
    // small letters, or with its "https://" or "www." in front.
    if (/[A-Z]/.test(m[1]) && !/^(?:https?:\/\/|www\.)/i.test(m[0])) continue;
    // An email address's domain ("help@marktmorgen-help.com") is an address too, and is read the same way.
    if (lookalikeHost(m[1])) return { at, length: m[0].length };
  }

  for (const m of text.matchAll(BRAND_ALL)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const { start: sStart, end: sEnd } = sentenceAround(text, at);
    const sentence = text.slice(sStart, sEnd);
    const before = text.slice(sStart, at);
    const after = text.slice(end, sEnd);
    const staff = STAFF_AFTER.exec(after);
    if (staff && !NEGATION.test(before) && (SPEAKER_START.test(before) || SIGN_OFF.test(before))) return { at, length: m[0].length + staff[0].length };
    if (SPEAKING_AS.test(before) && !NEGATION.test(before)) return { at, length: m[0].length };
    if ((OFFICIAL_BEFORE.test(before) || OFFICIAL_AFTER.test(after)) && !NEGATION.test(before)) return { at, length: m[0].length };
    for (const claim of [TROUBLE, PASSWORD]) {
      const found = claim.exec(sentence);
      if (!found) continue;
      const claimAt = sStart + found.index;
      // "never", "not" anywhere before the claim in the sentence: the opposite, said to protect the buyer.
      if (NEGATION.test(text.slice(sStart, claimAt))) continue;
      const from = Math.min(at, claimAt);
      const to = Math.max(end, claimAt + found[0].length);
      return { at: from, length: to - from };
    }
  }
  return null;
}

/** The first field of a product a buyer reads that poses as Marktmorgen, or null. */
export function brandImitation(product: { title: string; summary: string; about: string }): BrandImitation | null {
  for (const field of ["title", "summary", "about"] as const) {
    const text = typeof product[field] === "string" ? product[field].slice(0, MAX_TEXT) : "";
    const found = imitationIn(text);
    if (found) return { field, excerpt: excerptAt(text, found.at, found.length), why: IMITATION_WHY, fix: IMITATION_FIX };
  }
  return null;
}

/** Every address a page links to: each string under a key named url or href, to MAX_LINKS of them. */
export function pageLinks(page: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (out.length >= MAX_LINKS || depth > 12 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "url" || key === "href") && typeof item === "string" && item) {
        if (out.length < MAX_LINKS) out.push(item.slice(0, 2_048));
      } else walk(item, depth + 1);
    }
  };
  walk(page, 0);
  return out;
}

/** The host of an address, or "" when it is not one with a host. */
function hostOf(address: string): string {
  try {
    const url = new URL(address);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? (url.protocol === "mailto:" ? url.pathname.split("@")[1] ?? "" : url.hostname) : "";
  } catch {
    return "";
  }
}

/**
 * The same check over a sales page: every word a reader reads on it (lib/page-translate.ts, pageWords) and every
 * address it links to. A page is on the store with its product, so it is refused the same way.
 */
export function brandImitationOnPage(words: readonly string[], links: readonly string[] = []): BrandImitation | null {
  for (const text of words) {
    const found = imitationIn(text);
    if (found) return { field: "page", excerpt: excerptAt(text.slice(0, MAX_TEXT), found.at, found.length), why: IMITATION_WHY, fix: IMITATION_FIX };
  }
  for (const link of links.slice(0, MAX_LINKS)) {
    const host = hostOf(link);
    if (host && lookalikeHost(host)) return { field: "page", excerpt: link.slice(0, 2 * AROUND + 20), why: IMITATION_WHY, fix: IMITATION_FIX };
  }
  return null;
}
