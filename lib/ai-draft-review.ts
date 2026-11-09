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
 * Whole words only, any case: "lawn", "outlaw", "treaty" or "curious" are never
 * taken for one. A warning, not a refusal, so a broad list does no harm.
 */
const TOPIC_WORDS: Record<SensitiveTopic, RegExp> = {
  health: /\b(health|medical|medicine|medication|doctors?|nurses?|diagnos(e|is|ed|ing)|disease|illness|symptoms?|cur(e|es|ed|ing)|treat(s|ed|ing|ment|ments)?|therapy|therapist|diet|weight loss|pregnan(cy|t)|supplements?|anxiety|depression|injur(y|ies))\b/i,
  money: /\b(invest(s|ed|ing|ment|ments|or|ors)?|trading|stocks?|crypto|bitcoin|forex|income|profits?|earn(s|ed|ing|ings)?|retire(d|ment)?|savings|loans?|debts?|mortgage|tax(es)?|credit score|passive income)\b/i,
  law: /\b(law|laws|legal(ly)?|lawyers?|attorneys?|contracts?|lawsuits?|sue|court|visa|immigration|copyright|trademark|licen[cs]e)\b/i,
};

const TOPIC_ORDER: SensitiveTopic[] = ["health", "money", "law"];

/** The subjects a draft's text is about, in a fixed order; none for anything else. */
export function sensitiveTopics(text: string): SensitiveTopic[] {
  return TOPIC_ORDER.filter((topic) => TOPIC_WORDS[topic].test(text));
}

const TOPIC_WORDS_SAID: Record<SensitiveTopic, string> = { health: "health", money: "money", law: "the law" };

/** What the checks say about those subjects, or null when there are none. */
export function sensitiveWarning(topics: readonly SensitiveTopic[]): string | null {
  if (!topics.length) return null;
  const words = topics.map((topic) => TOPIC_WORDS_SAID[topic]);
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return `This draft is about ${list}. Before you publish, have someone who knows ${list} read it, and do not promise a result.`;
}
