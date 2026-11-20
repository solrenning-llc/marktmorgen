import { AI_MONTHLY, READ_PDF_JOBS } from '@/lib/ai-rules';
import { ANSWERS_MONTHLY } from '@/lib/answers-rules';
import { AI_REQUEST_LIMITS, ANSWER_MODEL, SUPPORTED_AI_MODELS, WRITING_MODEL } from '@/lib/ai-request-rules';
import { aiRequestHoldMicroUsd } from '@/lib/spend-cost-table';
import type { AiBudgetTier, AiSpendPolicy } from '@/lib/ai-spend-policy';
/** Current source envelope: translated help can make two calls in one job.
 * Visitor answers and the store guide share one separate monthly allowance.
 * Affiliate drafts, inbox, voice and number summaries share writing jobs.
 * Schema 3 (433 [PV3] (b), 20 November 2026): each kind of call is priced at
 * the worst request its own feature can send with its model fixed in code,
 * and a PDF read only inside a run that took its jobs (lib/ai-call-budget.ts).
 * This is a request-count envelope, not proof of model prices or tax treatment.
 */
export const AI_ENTITLEMENT_RULES = {
  schema: 3,
  writingCallsPerJob: 2,
  visitorCallsPerAttempt: 1,
  documentReadsPerPdfRun: 1,
  failedAttempts: 'retained',
  callEnvelope: 'async-job-shared-counter-owner-bound-no-reset-after-completion',
  callPricing: 'writing-text-either-fixed-model;answer-text-answer-model;document-answer-model-once-per-pdf-run',
  writing: AI_MONTHLY,
  visitor: ANSWERS_MONTHLY,
  request: AI_REQUEST_LIMITS,
  models: SUPPORTED_AI_MODELS,
  writingModel: WRITING_MODEL,
  answerModel: ANSWER_MODEL,
} as const;
export function aiEntitlementsSnapshot(): string {
  return JSON.stringify(AI_ENTITLEMENT_RULES);
}

/** The dearest request each kind of call can send, in micro-USD, from the cost table (lib/spend-cost-table.ts):
 * text at every request cap (system and text bytes, blocks, one image, every output token), and a document at the
 * model's whole context, as the cost table holds every PDF. */
const TEXT_MAX = { inputBytes: AI_REQUEST_LIMITS.systemBytes + AI_REQUEST_LIMITS.textBytes, blocks: AI_REQUEST_LIMITS.contentBlocks, media: 'image', maxTokens: AI_REQUEST_LIMITS.outputTokens } as const;
const DOCUMENT_MAX = { ...TEXT_MAX, media: 'document' } as const;
function priced(model: string, shape: typeof TEXT_MAX | typeof DOCUMENT_MAX): number {
  const value = aiRequestHoldMicroUsd(model, shape);
  if (value === null || value <= 0) throw new Error('A fixed AI model is missing from the cost table');
  return value;
}
export type AiSlotPrices = { writing: number; answer: number; document: number };
/** A writing job's call may ask either fixed model (some jobs ask the answer model) with text; a visitor answer asks the
 * answer model with text (tests/ai-funded-rights.test.ts holds lib/answers.ts and lib/store-guide.ts to it); the only
 * document request is a PDF read on the answer model (lib/ai.ts refuses any other). */
export const AI_SLOT_MICRO_USD: Readonly<AiSlotPrices> = Object.freeze({
  writing: Math.max(priced(WRITING_MODEL, TEXT_MAX), priced(ANSWER_MODEL, TEXT_MAX)),
  answer: priced(ANSWER_MODEL, TEXT_MAX),
  document: priced(ANSWER_MODEL, DOCUMENT_MAX),
});

/** Any allowed model may be selected for any call, so fund the most expensive
 * reviewed request for every permitted call, never an average: the reading of
 * a policy that does not name its price per kind of call (aiSlotPricesOf).
 */
export function requiredAiStoreMicroUsd(tier: AiBudgetTier, requestMicroUsd: Readonly<Record<string, number>>): bigint | null {
  // Non-paying scopes can retain any historical plan: fund the largest rights.
  const rights = tier === 'setup' || tier === 'ended' ? 'scale' : tier;
  if (!Object.hasOwn(AI_MONTHLY,rights) || !Object.hasOwn(ANSWERS_MONTHLY,rights)) return null;
  const charges = SUPPORTED_AI_MODELS.map(model=>requestMicroUsd?.[model]);
  if(charges.some(value=>!Number.isSafeInteger(value)||value<=0))return null;
  const calls = BigInt(AI_MONTHLY[rights])*BigInt(AI_ENTITLEMENT_RULES.writingCallsPerJob)
    + BigInt(ANSWERS_MONTHLY[rights])*BigInt(AI_ENTITLEMENT_RULES.visitorCallsPerAttempt);
  return calls*BigInt(Math.max(...charges as number[]));
}

/** Every published right of a tier used in full in one month, each call at the worst request its feature can send:
 * all writing jobs' calls at the writing price, the PDF reads those jobs can pay for (one per 1 + READ_PDF_JOBS jobs)
 * at the document price in place of one writing call each, and every visitor answer at the answer price. */
export function requiredAiRightsMicroUsd(tier: AiBudgetTier, slots: Readonly<AiSlotPrices> = AI_SLOT_MICRO_USD): bigint | null {
  // Non-paying scopes can retain any historical plan: fund the largest rights.
  const rights = tier === 'setup' || tier === 'ended' ? 'scale' : tier;
  if (!Object.hasOwn(AI_MONTHLY,rights) || !Object.hasOwn(ANSWERS_MONTHLY,rights)) return null;
  if (!slots || ![slots.writing, slots.answer, slots.document].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  const jobs = BigInt(AI_MONTHLY[rights]);
  const pdfRuns = jobs / BigInt(1 + READ_PDF_JOBS) * BigInt(AI_ENTITLEMENT_RULES.documentReadsPerPdfRun);
  const documentExtra = slots.document > slots.writing ? BigInt(slots.document - slots.writing) : BigInt(0);
  return jobs * BigInt(AI_ENTITLEMENT_RULES.writingCallsPerJob) * BigInt(slots.writing)
    + pdfRuns * documentExtra
    + BigInt(ANSWERS_MONTHLY[rights]) * BigInt(AI_ENTITLEMENT_RULES.visitorCallsPerAttempt) * BigInt(slots.answer);
}

/** A valid monetary ledger can still underfund the advertised usage. Commercial
 * release must cover all calls for every scope with at least one funded slot.
 * A policy that names its price per kind of call (slotMicroUsd, the automatic
 * one) is held to those prices; any other, to its largest request for every call. */
export function aiEntitlementsFunded(policy: AiSpendPolicy): boolean {
  return Object.entries(policy.fundedStores).every(([scope, slots]) => {
    if (slots === 0) return true;
    const tier = scope as AiBudgetTier;
    const required = policy.slotMicroUsd === undefined
      ? requiredAiStoreMicroUsd(tier, policy.requestMicroUsd)
      : requiredAiRightsMicroUsd(tier, policy.slotMicroUsd);
    const cap = policy.storeMicroUsd[tier];
    return required !== null && Number.isSafeInteger(cap) && cap >= 0 && BigInt(cap) >= required;
  });
}
