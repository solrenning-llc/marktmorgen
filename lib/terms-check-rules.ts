/**
 * Warnings about the terms, refund policy and description a creator wrote or
 * pasted for a product (493 [DE2], the complement to 98
 * [D2-COMPLIANCE-REVIEW]), unit 1: the rule only. Nothing calls it yet; the
 * studio shows the warnings before a product is published, and applies a
 * suggested fix only when the creator approves it, in the next unit.
 *
 * Pure and fixed: no model, no request, nothing changed. Each warning carries
 * the passage it is about, the reason in plain words and a suggested fix. It
 * flags; it does not decide that a text is unlawful. What it looks for:
 *   - another company or site named in the text (a host that is not the
 *     creator's own, or a platform for selling creator products): terms
 *     copied from elsewhere often describe rules that do not apply here;
 *   - a price in the text that is not the price the page and checkout show;
 *   - "no refunds" or the like, when the product is sold where the checkout's
 *     immediate-access consent (item 91, lib/digital-consent.ts) does not
 *     apply to it: a buyer in the EU or the UK usually has 14 days to cancel,
 *     as the Help says (lib/help-content.ts, EU withdrawal);
 *   - a promise of earnings, income or results;
 *   - urgency or scarcity with no real deadline or stock limit behind it;
 *   - resale or private label rights, which the Terms allow only under a
 *     license the creator keeps (app/terms/page.tsx, "Content sold with
 *     resale rights").
 * A sentence that says the opposite is never warned, because the fix would
 * tell the creator to delete a protective sentence: a negation in the same
 * clause before the words ("No resale rights", "we do not guarantee any
 * income") or after them ("resale rights are not included"), and a refund
 * rule that keeps the buyer's two weeks to cancel (closing refunds only
 * after that, or the text granting it). Ordinary product text is left
 * alone: well-known tools a product is made with or delivered on
 * (TOOL_HOSTS), a short domain ending only when written as an address
 * (with "https://", "www." or a path), the creator's own community or tip
 * page ("my Patreon"), amounts that are shipping, tax, a fee or a stated
 * value, and a countdown that is a product rather than a timer.
 * The text read is capped at MAX_TEXT characters and the warnings at
 * MAX_WARNINGS, so a pasted book costs a bounded amount of work.
 */

export const MAX_TEXT = 60_000;
export const MAX_WARNINGS = 30;
/** Characters shown on each side of a passage. */
const AROUND = 40;

export type TermsWarningKind = "other_company" | "price_mismatch" | "no_refunds" | "earnings_claim" | "fast_money" | "false_urgency" | "resale_rights";

/**
 * The kinds that stop a product from being published, not only warn (567 [GD1] (d)): what the Terms already forbid.
 * "What you may not sell" (app/terms/page.tsx) includes "anything that promises fast or easy money, or income for
 * little effort". Every other kind is a warning the creator may act on or not.
 */
export const BLOCKING_KINDS: ReadonlySet<TermsWarningKind> = new Set<TermsWarningKind>(["fast_money"]);

/**
 * `at` and `length` place the words in the text read (the first MAX_TEXT characters), for the studio to offer the
 * fix on the creator's approval (withoutSentence, replaceWords); `replacement` is the exact words a price fix puts in.
 */
export type TermsWarning = { kind: TermsWarningKind; excerpt: string; why: string; fix: string; at: number; length: number; replacement?: string };

export type TermsCheckInput = {
  /** The terms, refund policy and description, as the creator wrote them. */
  text: string;
  /** The creator's own hosts (their store address and any domain of theirs), without "www.". */
  ownHosts: readonly string[];
  /** The price the page and checkout show, in the smallest unit; null when the product is free or has several prices. */
  priceCents: number | null;
  /** The checkout's currency, lowercase. Only "usd" amounts written with "$" are compared. */
  currency: string;
  /** Whether the checkout's immediate-access consent (item 91) applies to this product (digital content, not a membership). */
  immediateAccessConsent: boolean;
  /** Whether the product has a real end date or sale deadline set in the studio. */
  realDeadline: boolean;
  /** Whether the product has a real stock or seat limit set in the studio. */
  realStockLimit: boolean;
  /** Whether the creator has said they hold a license to sell this content (the Terms' resale rule). */
  resaleLicense: boolean;
};

const OUR_HOSTS = new Set(["marktmorgen.com"]);

/** Tools a creator's product is made with or delivered on: naming one is not terms copied from another site. */
const TOOL_HOSTS: readonly string[] = [
  "canva.com", "notion.so", "notion.site", "notion.com", "zoom.us", "zoom.com", "youtube.com", "youtu.be", "vimeo.com", "loom.com",
  "google.com", "dropbox.com", "figma.com", "airtable.com", "trello.com", "miro.com", "calendly.com", "discord.com", "discord.gg",
  "slack.com", "github.com", "instagram.com", "tiktok.com", "facebook.com", "x.com", "twitter.com", "linkedin.com", "pinterest.com",
  "spotify.com", "apple.com", "microsoft.com", "adobe.com", "wikipedia.org",
];
/** Endings that are also short words or abbreviations: a site only when written as an address. */
const SHORT_ENDINGS = new Set(["so", "me", "ai", "us", "de", "fr", "ca", "co", "uk", "eu", "app"]);

/** Platforms that sell creator products: naming one in terms usually means the text came from there. */
const PLATFORMS: readonly RegExp[] = [
  /\bgumroad\b/i,
  /\bkajabi\b/i,
  /\bteachable\b/i,
  /\bthinkific\b/i,
  /\bpodia\b/i,
  /\bpayhip\b/i,
  /\bstan store\b/i,
  /\bstan\.store\b/i,
  /\bsysteme\.io\b/i,
  /\bclickfunnels\b/i,
  /\bsellfy\b/i,
  /\blemon squeezy\b/i,
];

const HOST = /\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|store|shop|app|me|so|ai|uk|de|fr|ca|us|eu))\b/gi;

const NO_REFUNDS = /\b(no refunds?|non[- ]?refundable|all sales (?:are )?final|refunds? (?:are|is|will) not (?:be )?(?:offered|available|accepted|given|issued|possible))\b/gi;

const EARNINGS: readonly RegExp[] = [
  /\bguarantee[ds]? (?:\w+ ){0,2}(?:income|results|sales|profits?|returns|earnings|clients)\b/gi,
  /\b(?:earn|make|made|making)\s+(?:up to\s+|over\s+)?\$\s?\d[\d,]*(?:k\b)?/gi,
  /\bget rich\b/gi,
  /\bpassive income\b/gi,
  /\bfinancial freedom\b/gi,
  /\breplace your (?:job|income|salary)\b/gi,
  /\b(?:six|seven)[- ]figures?\b/gi,
];

/**
 * A promise of fast or easy money, or income for little effort: forbidden by the Terms, so it blocks publication.
 * Only a promise blocks: a verb that offers the money ("make easy money", "earn quick cash", "make money while you
 * sleep", "get rich quick with…", "income with no effort"). The bare words ("Easy Money Habits", "quick cash register
 * course", "avoid get-rich-quick schemes") are not stopped: see FAST_MONEY_MENTION and fastMoneyExcused.
 */
const FAST_MONEY: readonly RegExp[] = [
  /\b(?:make|makes|making|earn|earns|earning|get|gets|getting|generate|generates|generating|bring in|pull in)\s+(?:some\s+|real\s+|serious\s+|extra\s+|more\s+)?(?:easy|quick|fast)\s+(?:money|cash|income|profits?)\b/gi,
  /\b(?:make|earn|making|earning)\s+(?:money|cash|income)\s+(?:fast|quickly|overnight|while you sleep|in your sleep|on autopilot)\b/gi,
  /\bget[- ]rich[- ]quick\b(?=\s+(?:with|by|using|from|today|now|in)\b)/gi,
  /\b(?:make|earn|making|earning|get|getting)\s+(?:money|cash|income|profits?)\s+(?:with|for)\s+(?:no|little|zero|minimal)\s+(?:effort|work)\b/gi,
  /\b(?:income|money|cash|profits?)\s+(?:with|for)\s+(?:no|little|zero|minimal)\s+(?:effort|work)\b/gi,
  /\beffortless\s+(?:income|money|cash|profits?)\b/gi,
];
/** The words alone, without a verb that promises them: a warning to reread, never a block. */
const FAST_MONEY_MENTION = /\b(?:easy|quick|fast)\s+(?:money|cash|income|profits?)\b|\bget[- ]rich[- ]quick\b|\b(?:overnight)\s+(?:income|riches|wealth)\b/gi;
/** Words after the phrase that make it something else: cash flow, a cash register, income tax, money habits, a scheme to avoid. */
const NOT_A_PROMISE_AFTER = /^[\s"'\u201d\u2019-]*(?:flows?|registers?|management|managing|habits?|tax(?:es)?|tips|mindset|schemes?|myths?|scams?|offers?|promises?|traps?|claims?|lies|ads?|sellers?|gurus?)\b/i;
/** Words before it that warn against it: avoid, spot, beware, scam, fake, myth, why … fail. */
const WARNS_AGAINST = /\b(?:avoid|avoiding|spot|spotting|beware|scams?|scammers?|fake|fraud|myths?|warning|truth about|why)\b/i;

/** The phrase is quoted, followed by a word that makes it something else, asked as a question, or warned against. */
function fastMoneyExcused(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 80), index);
  const after = text.slice(index + length, index + length + 40);
  if (/["\u201c\u2018']\s*$/.test(before) && /^\s*["\u201d\u2019']/.test(after)) return true;
  if (NOT_A_PROMISE_AFTER.test(after)) return true;
  if (/^\s*\?/.test(after)) return true;
  const clause = before.split(/[.!?;\n]/).pop() ?? "";
  return WARNS_AGAINST.test(clause);
}


const URGENCY_TIME = /\b(limited time|ends (?:today|tonight|soon|at midnight)|today only|last chance|price (?:goes|will go) up|before the timer (?:runs out|ends)|act now|hurry)\b/gi;
const URGENCY_STOCK = /\b(only \d+ (?:left|spots?|seats?|copies|places)|limited (?:spots|seats|copies|places)|selling fast|almost sold out)\b/gi;

const RESALE = /\b(resell(?:ing)? rights?|resale rights?|master resell(?:ing)? rights?|PLR|private label rights?|white[- ]label rights?)\b/gi;

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)/g;
/** A word saying what follows is the price, just before the amount. */
const PRICE_WORD = /\b(price|priced|costs?|pay|paying|only|just|for)\b[^.!?;\n$]{0,12}$/i;
/** An amount that is not the product's price: shipping, tax, a fee, a stated value, a saving. */
const NOT_PRICE_BEFORE = /\b(shipping|delivery|postage|tax|taxes|fees?|save|saving|savings|worth|valued at|refunds?|deposit|tip|bonus)\b[^.!?;\n$]{0,16}$/i;
const NOT_PRICE_AFTER = /^\S*\s*(?:\)|,)?\s*(value|worth|off|discount|shipping|tax|fee|deposit|bonus)\b/i;

/** A word that says the opposite, in the clause before the words. */
const NEGATION = /\b(no|not|never|nor|without|cannot|can't|don't|doesn't|won't|isn't|aren't|didn't|neither|none|excludes?|excluding|make no|makes no)\b/i;
/** A negation in the clause after the words ("resale rights are not included"). */
const NEGATED_AFTER = /^[^.!?;:,\n]{0,30}?\b(?:not (?:included|granted|given|allowed|permitted|offered|transferable|available)|prohibited|forbidden|excluded)\b/i;
/** The text keeps a buyer's two weeks to cancel, in words like "cancel within N days" or "an N-day money-back". */
const KEEPS_14_DAYS = /\b(?:cancel|withdraw|refund|return)\w*\b[^.!?\n]{0,60}?\bwithin (?:(\d+)|fourteen|thirty|30|sixty)[- ]days?\b|\b(?:(\d+)|fourteen|thirty|sixty)[- ]days? (?:money[- ]back|refund|return|cooling[- ]off|right to cancel)/i;
const AFTER_DAYS = /^[^.!?;\n]{0,40}?\bafter (?:(\d+)|fourteen|thirty|sixty) days\b/i;

/** The clause the words are in, before them (back to . ! ? ; : , or a new line), at most its last six words. */
function negatedBefore(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 120), index).replace(/\u2019/g, "'");
  const clause = before.split(/[.!?;:,\n]/).pop() ?? "";
  return NEGATION.test(clause.trim().split(/\s+/).slice(-6).join(" "));
}
/**
 * The creator's own page there, said right before the name: "my patreon.com/jane", "our Skool", "my community at
 * skool.com/jane", "Support me at ko-fi.com/jane". A possessive elsewhere in the sentence ("Our refund policy
 * follows Gumroad terms") is not one.
 */
function ownedNearby(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 60), index).replace(/\u2019/g, "'");
  return /\b(my|our)\s+$/i.test(before) || /\b(my|our)\s+(?:[a-z-]+\s+){0,2}(?:at|on)\s+$/i.test(before) || /\bme\s+(?:at|on)\s+$/i.test(before);
}
function negated(text: string, index: number, length: number): boolean {
  return negatedBefore(text, index) || NEGATED_AFTER.test(text.slice(index + length, index + length + 60).replace(/\u2019/g, "'"));
}
const daysOf = (m: RegExpMatchArray | RegExpExecArray | null): number => {
  if (!m) return 0;
  const n = m.slice(1).find((g) => g !== undefined);
  if (n) return Number(n);
  return /fourteen/i.test(m[0]) ? 14 : /sixty/i.test(m[0]) ? 60 : 30;
};

function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - AROUND);
  const end = Math.min(text.length, index + length + AROUND);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function ownsHost(host: string, own: Set<string>): boolean {
  const h = bareHost(host);
  for (const o of own) if (h === o || h.endsWith(`.${o}`)) return true;
  return false;
}

export function checkCreatorTerms(input: TermsCheckInput): TermsWarning[] {
  const text = typeof input.text === "string" ? input.text.slice(0, MAX_TEXT) : "";
  const out: TermsWarning[] = [];
  const seen = new Set<string>();
  const add = (kind: TermsWarningKind, index: number, length: number, why: string, fix: string, replacement?: string) => {
    const key = `${kind}:${text.slice(index, index + length).toLowerCase()}`;
    if (seen.has(key) || out.length >= MAX_WARNINGS) return;
    seen.add(key);
    out.push({ kind, excerpt: excerptAt(text, index, length), why, fix, at: index, length, ...(replacement ? { replacement } : {}) });
  };
  const own = new Set([...input.ownHosts.map(bareHost), ...OUR_HOSTS]);

  for (const m of text.matchAll(HOST)) {
    const at = m.index ?? 0;
    if (m[0].includes("@") || text[at - 1] === "@") continue;
    // Written in capitals ("it.So"), a sentence run together, not an address.
    if (m[1] !== m[1].toLowerCase() && !/^https?:\/\//i.test(m[0])) continue;
    const ending = m[1].toLowerCase().split(".").pop() ?? "";
    const asAddress = /^https?:\/\//i.test(m[0]) || /^www\./i.test(m[1]) || text[at + m[0].length] === "/";
    if (SHORT_ENDINGS.has(ending) && !asAddress) continue;
    if (ownsHost(m[1], own) || ownsHost(m[1], new Set(TOOL_HOSTS))) continue;
    // The creator's own page elsewhere ("my patreon.com/jane", "Support me at ko-fi.com/jane"): not copied terms.
    if (ownedNearby(text, at)) continue;
    add("other_company", m.index ?? 0, m[0].length,
      `This names ${bareHost(m[1])}, which is not your site. Terms copied from another site may describe rules that do not apply to this store.`,
      "Remove the other site, or replace it with your store's own address.");
  }
  for (const pattern of PLATFORMS) {
    const m = pattern.exec(text);
    if (!m) continue;
    // The creator's own page there, or a line saying the store is not that company.
    if (ownedNearby(text, m.index) || negatedBefore(text, m.index)) continue;
    add("other_company", m.index, m[0].length,
      `This names ${m[0]}, another company. Terms written for another platform may describe rules that do not apply here.`,
      "Remove the other company's name, and check that each rule describes how this store works.");
  }

  if (input.currency === "usd" && input.priceCents !== null && Number.isSafeInteger(input.priceCents)) {
    for (const m of text.matchAll(MONEY)) {
      const index = m.index ?? 0;
      const before = text.slice(Math.max(0, index - 30), index);
      const after = text.slice(index + m[0].length, index + m[0].length + 20);
      if (!PRICE_WORD.test(before) || NOT_PRICE_BEFORE.test(before) || NOT_PRICE_AFTER.test(after)) continue;
      const cents = Number(m[1].replace(/,/g, "")) * 100 + (m[2] ? Number(m[2]) : 0);
      if (cents === input.priceCents) continue;
      add("price_mismatch", index, m[0].length,
        `This says ${m[0].replace(/\s/g, "")}, but the page and checkout show ${formatUsd(input.priceCents)}. A buyer may expect the price written here.`,
        `Change it to ${formatUsd(input.priceCents)}, or remove the amount.`, formatUsd(input.priceCents));
    }
  }

  // The text itself keeps the 14 days somewhere: a "no refunds" beside it is the rule after them.
  if (!input.immediateAccessConsent && daysOf(KEEPS_14_DAYS.exec(text)) < 14) {
    for (const m of text.matchAll(NO_REFUNDS)) {
      const after = AFTER_DAYS.exec(text.slice((m.index ?? 0) + m[0].length));
      if (after && daysOf(after) >= 14) continue;
      add("no_refunds", m.index ?? 0, m[0].length,
        "In the EU, the UK and some other places, a buyer online usually has 14 days to cancel. The checkout's agreement to start access at once does not cover this product, so this sentence may not hold for those buyers.",
        "Say that buyers in the EU and the UK can cancel within 14 days, or remove this sentence.");
    }
  }

  for (const pattern of EARNINGS) {
    for (const m of text.matchAll(pattern)) {
      if (negated(text, m.index ?? 0, m[0].length)) continue;
      add("earnings_claim", m.index ?? 0, m[0].length,
        "This promises earnings, income or results. A promise like this needs proof that typical buyers get it, and results depend on the buyer.",
        "Describe what the product contains and teaches, without promising a result.");
    }
  }

  const promised: [number, number][] = [];
  for (const pattern of FAST_MONEY) {
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0;
      if (negated(text, at, m[0].length) || fastMoneyExcused(text, at, m[0].length)) continue;
      promised.push([at, at + m[0].length]);
      add("fast_money", at, m[0].length, FAST_MONEY_WHY, FAST_MONEY_FIX);
    }
  }
  for (const m of text.matchAll(FAST_MONEY_MENTION)) {
    const at = m.index ?? 0;
    if (promised.some(([from, to]) => at >= from && at < to)) continue;
    if (negated(text, at, m[0].length) || fastMoneyExcused(text, at, m[0].length)) continue;
    add("earnings_claim", at, m[0].length,
      "This mentions fast or easy money. If it promises the buyer fast or easy money, the Terms do not allow it; if it only names the subject, it is fine.",
      "Reread it: say what the product contains and teaches, without promising money for little effort.");
  }

  if (!input.realDeadline) {
    for (const m of text.matchAll(URGENCY_TIME)) {
      if (negated(text, m.index ?? 0, m[0].length)) continue;
      add("false_urgency", m.index ?? 0, m[0].length,
        "This says time is running out, but no end date or sale deadline is set for this product.",
        "Remove this sentence, or say the real date the offer ends.");
    }
  }
  if (!input.realStockLimit) {
    for (const m of text.matchAll(URGENCY_STOCK)) {
      if (negated(text, m.index ?? 0, m[0].length)) continue;
      add("false_urgency", m.index ?? 0, m[0].length,
        "This says few are left, but no stock or seat limit is set for this product.",
        "Set \u201cHow many can be sold, in total\u201d on this product, or remove this sentence.");
    }
  }

  if (!input.resaleLicense) {
    for (const m of text.matchAll(RESALE)) {
      if (negated(text, m.index ?? 0, m[0].length)) continue;
      add("resale_rights", m.index ?? 0, m[0].length,
        "This mentions resale or private label rights. Our Terms allow selling such content only under a license that lets you sell it this way, which you keep and show on request.",
        "Remove this sentence, unless you hold a license that lets you sell this content this way.");
    }
  }
  return out;
}

function formatUsd(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return `$${dollars.toLocaleString("en-US")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

/**
 * Whether the character at `i` ends a sentence: "!", "?", a line break, or a "." followed by a space, the end of the
 * text, or a closing quote or bracket and then a space. A dot inside an address ("othershop.com"), an amount
 * ("$99.00") or a version ("2.0") does not.
 */
function endsSentence(text: string, i: number): boolean {
  const c = text[i];
  if (c === "!" || c === "?" || c === "\n") return true;
  if (c !== ".") return false;
  const next = text[i + 1];
  if (next === undefined || /\s/.test(next)) return true;
  return /["'\u201d\u2019)\]]/.test(next) && (i + 2 >= text.length || /\s/.test(text[i + 2]));
}

/** The sentence holding `at`: back to the end of the previous one, on to its own end (included). */
function sentenceAt(text: string, at: number): [number, number] {
  let start = at;
  while (start > 0 && !endsSentence(text, start - 1)) start -= 1;
  // The closing quote or bracket of the sentence before belongs to it ("no questions asked." Resale…).
  while (start < at && /["'\u201d\u2019)\]]/.test(text[start])) start += 1;
  let end = at;
  while (end < text.length && !endsSentence(text, end)) end += 1;
  if (end < text.length && text[end] !== "\n") end += 1;
  while (end < text.length && /["'\u201d\u2019)\]]/.test(text[end])) end += 1;
  return [start, end];
}

/**
 * The text without the sentence holding `at` (a warning's place), its spacing tidied; the rest is left exactly as
 * written. With `expected`, only while those words are still at `at` (the text may have changed since the warning).
 */
export function withoutSentence(text: string, at: number, expected?: string): string {
  if (!Number.isSafeInteger(at) || at < 0 || at >= text.length) return text;
  if (expected !== undefined && (!expected || text.slice(at, at + expected.length) !== expected)) return text;
  const [start, end] = sentenceAt(text, at);
  const before = text.slice(0, start).replace(/[ \t]+$/, "");
  let after = text.slice(end).replace(/^[ \t]+/, "");
  if (/\n$/.test(before) && /^\n/.test(after)) after = after.slice(1);
  const joined = before && after && !/\n$/.test(before) && !/^\n/.test(after) ? `${before} ${after}` : `${before}${after}`;
  return joined.replace(/\n{3,}/g, "\n\n");
}

/** The text with the words at `at` (`length` of them) replaced: only when they are still the same words. */
export function replaceWords(text: string, at: number, length: number, expected: string, replacement: string): string {
  if (text.slice(at, at + length) !== expected) return text;
  return `${text.slice(0, at)}${replacement}${text.slice(at + length)}`;
}

const FAST_MONEY_WHY =
  "This promises fast or easy money, or income for little effort. The Terms do not allow selling anything that promises fast or easy money, so the product cannot be published with it.";
const FAST_MONEY_FIX = "Remove this promise, and say what the product contains and teaches, and the work it takes.";

/** Where a product is stopped: the field, the passage, why and the fix. */
export type FastMoneyRefusal = { field: "title" | "summary" | "about" | "page" | "option"; excerpt: string; why: string; fix: string; product?: string };

/**
 * The first promise of fast or easy money in what a buyer reads of a product (its title, summary and description),
 * or null. The product route refuses to publish a product, or to save a published one, while there is one; the
 * creator's words are never changed for them.
 */
export function fastMoneyRefusal(product: { title: string; summary: string; about: string }): FastMoneyRefusal | null {
  for (const field of ["title", "summary", "about"] as const) {
    const found = checkCreatorTerms({ text: product[field] ?? "", ownHosts: [], priceCents: null, currency: "usd", immediateAccessConsent: true, realDeadline: true, realStockLimit: true, resaleLicense: true })
      .find((warning) => BLOCKING_KINDS.has(warning.kind));
    if (found) return { field, excerpt: found.excerpt, why: found.why, fix: found.fix };
  }
  return null;
}

/**
 * The same check over a product's sales page: every word a reader reads on it, its second version and its search
 * title and description included (lib/page-translate.ts, pageWords). The page is on the store with its product, so
 * it is refused the same way (567 [GD1] (d), unit 2).
 */
export function fastMoneyOnPage(words: readonly string[]): FastMoneyRefusal | null {
  for (const text of words) {
    const found = fastMoneyRefusal({ title: text, summary: "", about: "" });
    if (found) return { ...found, field: "page" };
  }
  return null;
}

/**
 * Why a product was not published or saved (567 [GD1] (d)): the words, where they are, why and the fix, from the
 * server's own check (lib/terms-check-rules.ts, fastMoneyRefusal). Nothing the creator wrote was changed.
 */
const FIELD_NAMES: Record<string, string> = { title: "the name", summary: "the short description", about: "the description", page: "the sales page", option: "a price's name or its lines" };
export function fastMoneyMessage(passage: unknown, mode: "add" | "save" | "publish" = "save"): string {
  const p = passage && typeof passage === "object" ? (passage as Record<string, unknown>) : {};
  const where = FIELD_NAMES[String(p.field)] ?? "the product's words";
  const words = typeof p.excerpt === "string" ? p.excerpt.trim().replace(/[.,;:!?]+$/, "") : "";
  const quoted = words ? `: \u201c${words}\u201d` : "";
  const why = typeof p.why === "string" && p.why ? p.why : "The Terms do not allow selling anything that promises fast or easy money.";
  const fix = typeof p.fix === "string" && p.fix ? p.fix : "Remove the promise and say what the product contains.";
  const named = typeof p.product === "string" && p.product.trim() ? `\u201c${p.product.trim()}\u201d` : "This product";
  const lead = mode === "publish" ? `${named} was not published` : mode === "add" ? "It was not added" : "Your changes were not saved";
  return `${lead}. In ${where}${quoted}. ${why} ${fix} Nothing you wrote was changed.`;
}
