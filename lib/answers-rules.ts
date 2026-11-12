import {PLAN_TITLES} from "@/lib/plan";
/**
 * A visitor's question about a product, answered from what its page says.
 * Rules the browser can read too; the part that asks the model, counts and
 * remembers is lib/answers.ts, which only the server loads.
 *
 * Measured before it was built (7 October 2026): Kajabi sells a "Sales
 * Agent" that answers pre-purchase questions on landing and checkout pages,
 * at $79 a month for each agent on top of its plan. Hotmart's Tutor and
 * Stan's AI Twin answer members and fans, after the sale. A visitor with one
 * question left — is it a PDF, how long do I have access, is there a refund —
 * either finds the answer in the next few seconds or leaves.
 *
 * What it is, and what keeps it honest:
 *
 *   - Off until the creator switches it on. An answer given in a creator's
 *     name is theirs to allow.
 *   - It answers only from what the product's own page says — its title,
 *     price, description, the blocks of its sales page — and from the notes
 *     the creator writes for it. When the page does not answer the question,
 *     it says exactly that, and the question is shown to the creator (with
 *     no name, address or anything else about who asked), who then knows what
 *     their page is missing. That list is the second half of the feature.
 *   - It never states a price, a refund, a deadline or a result that is not
 *     on the page, and the box says in plain words that the answer is
 *     automatic.
 *
 * What keeps it from costing more than it earns. Each answer is one request
 * to the smallest current model (Haiku 5.5 at $0.10 and $0.50 per million
 * tokens in and out, as lib/spend-cost-table.ts holds it). A store gets a
 * number of answers a month by its plan, below, priced into the plan's
 * automatic monthly AI ceiling (lib/ai-spend-policy.ts); past either the box
 * closes by itself until the month turns. The same question about the same
 * page is answered from memory for a day and costs nothing.
 */

/**
 * Answers a store's visitors may be given in a window (lib/allowance-window.ts: a billing month when the store pays), by where the
 * store stands with its plan. Lowered on October 17, 2026 with the writing
 * jobs (lib/ai-rules.ts, AI_MONTHLY) to what each plan's 60% after-tax floor
 * leaves room for; Store and the free trial have none.
 */
export const ANSWERS_MONTHLY = { trial: 0, creator: 0, pro: 250, scale: 400 } as const;

/** What one visitor may ask of one store: a few in ten minutes, and a ceiling a day. */
export const ASKS_PER_TEN_MINUTES = 6;
export const ASKS_PER_DAY = 30;
/** And what a whole store is asked in any one minute, so a flood cannot spend its month at once. */
export const STORE_ASKS_PER_MINUTE = 20;

export const MIN_QUESTION = 3;
export const MAX_QUESTION = 300;
/** The creator's own notes for the answers: refunds, formats, who to write to. */
export const MAX_ANSWER_FACTS = 2_000;
/** The longest answer shown. */
export const MAX_ANSWER = 600;
/** How much of a page is read to the model, in characters: the longest page still costs a fraction of a cent. */
export const MAX_FACTS_CHARS = 14_000;
/**
 * Told where the length cut left a part of the page out whole (lib/answers.ts,
 * keptParts), so the model never reads what it was given as all the page
 * says. While it is in the facts, no answer about terms is shown
 * (heldToFacts, speaksOfTerms in lib/store-assistant-rules.ts): the part left
 * out may hold a promise's condition.
 */
export const PAGE_GOES_ON = "(The page says more here; it is not repeated.)";
/** Questions a page did not answer, kept for the creator: the newest this many, for this long. */
export const MISSED_KEPT = 50;
export const MISSED_SECONDS = 120 * 86_400;
/** The same question about the same page is answered from memory for this long. */
export const ANSWER_KEPT_SECONDS = 86_400;

export type AnswersSetting = { on: boolean; facts: string };

export const NO_ANSWERS: AnswersSetting = { on: false, facts: "" };

/** The setting as stored or sent, made safe to use. Off on every store written before it existed. */
export function parseAnswers(raw: unknown): AnswersSetting {
  if (!raw || typeof raw !== "object") return { ...NO_ANSWERS };
  const value = raw as Record<string, unknown>;
  const facts =
    typeof value.facts === "string"
      ? value.facts
          .replace(/\r\n?/g, "\n")
          .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
          .slice(0, MAX_ANSWER_FACTS)
      : "";
  return { on: value.on === true, facts };
}

/** A question as typed: one line, bounded; empty when there is too little to be one. */
export function readQuestion(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUESTION);
  return text.length >= MIN_QUESTION ? text : "";
}

/** The same question, however it was typed, for finding an answer already given. */
export function questionKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** What the box says when the page does not answer the question. */
export function unknownWords(storeName: string): string {
  return `This page does not say. Ask ${storeName} before you buy.`;
}

/** Published allowance wording follows the same cap and plan identities as admission. */
export function answerAllowanceWords(): string {
 const count=(n:number)=>n.toLocaleString('en-US');
 return 'Up to '+count(ANSWERS_MONTHLY.pro)+' automated answer requests a month on '+PLAN_TITLES.pro+' and '+count(ANSWERS_MONTHLY.scale)+' on '+PLAN_TITLES.scale+'; not included on '+PLAN_TITLES.creator+' or during the free trial. The store guide uses the same allowance and the plan\'s monthly AI budget. Attempts count even when the model cannot return an answer.';
}
