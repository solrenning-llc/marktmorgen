/**
 * What the creator checks under every AI draft before it is saved (756 [STN3],
 * unit 1). The writing box (components/ai-assist.tsx) marks what it filled in
 * as an "AI draft", in words, and lists three checks; a form that saves the
 * draft waits until all three are checked (components/product-editor.tsx).
 * Pure rules: nothing here calls a model, reads or writes anything.
 */

/** The badge drawn by the page over every draft the writing help fills in, never by the model. */
export const AI_DRAFT_BADGE = "AI draft";

/** The three things the creator confirms, in plain words: the facts, any picture, the price and numbers. */
export const AI_DRAFT_CHECKS: readonly { id: "facts" | "picture" | "price"; label: string }[] = [
  { id: "facts", label: "Every fact in it is true, and it says only what you offer." },
  { id: "picture", label: "If there is a picture, it fits what it says." },
  { id: "price", label: "The price and every number in it are right." },
];

/** What the form says when it is asked to save while a draft is not checked yet. */
export const AI_DRAFT_HOLD = "This has an AI draft you have not checked yet. Check the three boxes under it, then save.";

/** A new draft: none checked. */
export function freshChecks(): boolean[] {
  return AI_DRAFT_CHECKS.map(() => false);
}

/** All three checked, and only then; a list of any other length is never done. */
export function reviewDone(checks: readonly boolean[]): boolean {
  return checks.length === AI_DRAFT_CHECKS.length && checks.every((ticked) => ticked === true);
}

/** The first check left, or -1 when none is. */
export function firstUnchecked(checks: readonly boolean[]): number {
  return checks.findIndex((ticked) => ticked !== true);
}

/** Why a save waits: null when no draft is waiting (`null`) or it is checked, the sentence otherwise. */
export function aiDraftHold(checks: readonly boolean[] | null): string | null {
  if (checks === null) return null;
  return reviewDone(checks) ? null : AI_DRAFT_HOLD;
}

/** A subject where a wrong sentence can hurt someone, so an AI draft about it asks for a reader who knows it (756 [STN3], unit 2). */
export type SensitiveTopic = "health" | "money" | "law";

/**
 * What a draft is about: its subjects, or "unread" when it is written in a
 * language the word lists below do not read, so the warning is the general
 * one rather than none (Claude 6's review of #3436).
 */
export type DraftTopics = readonly SensitiveTopic[] | "unread";

/** Every piece of text a draft holds, at any depth; numbers and keys are settings, never claims, so they are left out. */
export function draftStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(draftStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(draftStrings);
  return [];
}

/**
 * Whole words only, any case: "lawn", "outlaw", "treaty" or "curious" are never
 * taken for one. Words that mostly mean something else in a product draft are
 * left out or read only in the phrase that is about the subject: "treats"
 * (dog treats), "cured" (cured meats), "stock" (stock photos, chicken stock),
 * "earn" (earn a certificate), "license" (a font's commercial license),
 * "court" (a basketball court), "money-back" (a guarantee), "tax included"
 * (a price), "mother-in-law", "Murphy's law". Sale wording is not a subject
 * either, and is read narrowly so the subject that shares its words still
 * is: "save money" only before a sale object ("with the bundle", "on every
 * order"), "savings on" only before one ("on shipping", "on your order"),
 * "big savings" only alone, "taxing" only before a workout or a day,
 * "treated" only before a material, "with care", "to a" treat or "like
 * royalty", "while stocks last", "trading cards" or "pins", "the law of
 * attraction". "Saving money: a plan", "your savings on autopilot",
 * "taxing your side hustle" and "wounds treated to prevent infection" are
 * still the subject.
 */
const TOPIC_WORDS: Record<SensitiveTopic, RegExp> = {
  health: /\b(health|medical|medicine|medications?|doctors?|nurses?|diagnos(e|es|is|ed|ing)|diseases?|illness(es)?|disorders?|symptoms?|cures?|(?<!(pressure|heat)-)treated(?! (wood|lumber|timber|pine|cedar|glass|steel|leather|fabric|paper|water|with care|like (royalty|vips?|a vip|kings?|queens?|family|friends|gold)|to (a|an|the|our|your|free|some|special))\b)|patients|treat(ing|ments?)|therap(y|ies)|therapists?|diet(s|ing)?|weight[- ]loss|pregnan(cy|t)|supplements?|anxiety|depression|injur(y|ies)|cancer|(chronic|back|joint|neck) pain|pain relief|heal(s|ed|ing)|trauma)\b/i,
  money: /\b(money(?![- ]back)(?!(?<=\b(save|saves|saved|saving) money) (with (the|this|our|a|each|every) (bundle|kit|set|pack|box|combo|deal|plan)s?|on (every|each|shipping|your (next )?orders?|orders?|the bundle|bundles))\b)|financ(e|es|ial|ially)|invest(s|ed|ing|ment|ments|or|ors)?|trading(?! (cards?|pins?)\b)|stocks(?! last\b)|stock (market|trading)|crypto|bitcoin|forex|income|profits?|earnings|retire(d|ment)?|savings(?! on (every|each|shipping|your (next )?orders?|orders?|the bundle|bundles|all|everything|select|kits?)\b)(?!(?<=\b(big|bigger|huge|great|extra|instant|bundle) savings)\s*([!.,:;]|$))|loans?|debts?|mortgages?|tax(es|ed)?(?! included\b)|taxing(?! (\w+ )?(workouts?|climbs?|days?|hikes?|runs?|routines?|sessions?|weeks?|class(es)?|rides?|exercises?)\b)|credit scores?|passive income)\b/i,
  law: /\b((?<!-in-|murphy's |murphy’s )law(?! of (attraction|averages)\b)|laws|legal(ly)?|lawyers?|attorneys?|contracts?|lawsuits?|sue|sued|suing|(in|to|before) court|courtrooms?|court (case|order|date|hearing)s?|visas?|immigration|copyrights?|trademarks?)\b/i,
};

const TOPIC_ORDER: SensitiveTopic[] = ["health", "money", "law"];

/** The subjects a text, or any one of several, is about, in a fixed order; none for anything else. */
export function sensitiveTopics(text: string | readonly string[]): SensitiveTopic[] {
  const texts = typeof text === "string" ? [text] : text;
  return TOPIC_ORDER.filter((topic) => texts.some((one) => TOPIC_WORDS[topic].test(one)));
}

/**
 * The store languages the word lists read. A draft is written in the store's
 * language (lib/ai.ts, storeLanguage); lists in the other store languages
 * would miss their own wording without a native reader to write them, so a
 * draft in any of those, or in a language not said, gets the general warning.
 */
const READ_LANGUAGES: ReadonlySet<string> = new Set(["en"]);

/** What a draft's own strings are about, read in its language (756 [STN3], unit 2). */
export function draftTopics(texts: readonly string[], language: string | null | undefined): DraftTopics {
  if (!language || !READ_LANGUAGES.has(language)) return "unread";
  return sensitiveTopics(texts);
}

const TOPIC_WORDS_SAID: Record<SensitiveTopic, string> = { health: "health", money: "money", law: "the law" };
const TOPIC_READER: Record<SensitiveTopic, string> = { health: "a doctor", money: "an accountant", law: "a lawyer" };

const listed = (words: readonly string[], last: "and" | "or") =>
  words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;

/** The label drawn before the warning, in bold. */
export function sensitiveLabel(topics: DraftTopics): string {
  return topics === "unread" ? "Health, money or the law:" : "Sensitive topic:";
}

/** What the checks say about those subjects, or null when there are none. */
export function sensitiveWarning(topics: DraftTopics): string | null {
  if (topics === "unread") {
    return "If this draft is about health, money or the law, have someone who knows the subject read it before you publish, such as a doctor, an accountant or a lawyer, and do not promise a result. We look for these subjects only in drafts written in English.";
  }
  if (!topics.length) return null;
  const subjects = listed(topics.map((topic) => TOPIC_WORDS_SAID[topic]), "and");
  const readers = listed(topics.map((topic) => TOPIC_READER[topic]), "or");
  const subject = topics.length === 1 ? "the subject" : "each subject";
  return `This draft is about ${subjects}. Before you publish, have someone who knows ${subject} read it, such as ${readers}, and do not promise a result.`;
}
