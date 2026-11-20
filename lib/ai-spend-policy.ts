import { AI_SLOT_MICRO_USD, aiEntitlementsSnapshot, requiredAiRightsMicroUsd, type AiSlotPrices } from '@/lib/ai-entitlement-rules';
import { AI_REQUEST_LIMITS, SUPPORTED_AI_MODELS } from '@/lib/ai-request-rules';
import { COST_TABLE_VERSION, aiRequestHoldMicroUsd } from '@/lib/spend-cost-table';
/** Reviewed USD microdollar ceilings. Unknown budgets never authorize spending. */
export const AI_SPEND_RULES = {
  schema: 5,
  microUsdPerUsd: 1_000_000,
  maxInteger: 1_000_000_000_000,
  reservation: 'full-request-ceiling-no-refunds',
  automaticCharge: 'hard-bound-of-each-request-from-cost-table',
  ledger: 'nl:ai-spend:v2:{YYYY-MM}',
  missingLedger: 'automatic-policy-opens-each-month-once-never-recreates',
  changedAutomaticCeilings: 'carry-every-counter',
  expiry: 'none',
} as const;
export const aiSpendLedgerKey = (month: string) => 'nl:ai-spend:v2:{' + month + '}';
/** Marks that a month's ledger was opened, in the same cluster slot, so a lost ledger is never recreated empty. */
export const aiSpendOpenedKey = (month: string) => aiSpendLedgerKey(month) + ':opened';
export const AI_BUDGET_TIERS = ['creator', 'pro', 'scale', 'trial', 'setup', 'ended'] as const;
export type AiBudgetTier = typeof AI_BUDGET_TIERS[number];
export type AiSpendPolicy = {
  reviewId: string;
  month: string;
  evidence: string;
  /** Includes the full allowed context, output, media, billing surcharges and currency costs. */
  requestMicroUsd: Record<'claude-sonnet-5-5' | 'claude-haiku-5-5', number>;
  storeMicroUsd: Record<AiBudgetTier, number>;
  /** Includes trial/acquisition calls; those must be separately funded in the review. */
  companyMicroUsd: number;
  /** Maximum store allocations; every admitted store may use its full tier budget. */
  fundedStores: Record<AiBudgetTier, number>;
  /** The worst request of each kind of call, from the cost table (AI_SLOT_MICRO_USD): the automatic policy names it, so
   * its rights are funded at what each feature can send (lib/ai-entitlement-rules.ts). A policy without it is held to
   * its largest request for every call. Never lower than the cost table's. */
  slotMicroUsd?: AiSlotPrices;
};

/** The automatic policy's identity: computed in code from the cost table, never an external review. */
export const AUTOMATIC_AI_SPEND_REVIEW_ID = 'automatic_' + COST_TABLE_VERSION.replace(/[^A-Za-z0-9_-]/g, '_');
/** Paid stores' allocations are funded by their own subscription; this is a
 * finite count per tier, not a forecast. Past it, new allocations refuse. */
export const PAID_AI_ALLOCATIONS_PER_TIER = 10_000;
/**
 * Each plan's monthly AI ceiling, computed from what the plan publishes and
 * enforces: every writing job (lib/ai-rules.ts), every PDF read those jobs can
 * pay for and every visitor answer (lib/answers-rules.ts), each call at the
 * worst request its own feature can send with its model fixed in code, from
 * the cost table (lib/spend-cost-table.ts, requiredAiRightsMicroUsd in
 * lib/ai-entitlement-rules.ts). So every published right is funded: the
 * ceiling no longer runs out before the rights do (433 [PV3] (b), 20 November
 * 2026; until then it funded only a reference job and answer, US$3.35 on
 * Studio and US$6.37 on Scale). tests/spend-floor.test.ts holds every plan's
 * worst case, with this ceiling, to a positive net.
 *
 * Trial, setup and ended stores have no revenue. Their AI is a funded
 * exposure (docs/funded-exposure-review.md) that needs a reviewed reserve
 * this code cannot compute, so they have no allocation here; they also
 * reserve that exposure before any spending (lib/ai.ts).
 */
function fundedRights(tier: 'creator' | 'pro' | 'scale'): number {
  const required = requiredAiRightsMicroUsd(tier);
  if (required === null || required > BigInt(AI_SPEND_RULES.maxInteger)) throw new Error('A plan\'s AI rights cannot be priced from the cost table');
  return Number(required);
}
export const AUTOMATIC_AI_STORE_MICRO_USD: Record<AiBudgetTier, number> = {
  creator: fundedRights('creator'),
  pro: fundedRights('pro'),
  scale: fundedRights('scale'),
  trial: 0,
  setup: 0,
  ended: 0,
};
const AUTOMATIC_FUNDED: Record<AiBudgetTier, number> = { creator: PAID_AI_ALLOCATIONS_PER_TIER, pro: PAID_AI_ALLOCATIONS_PER_TIER, scale: PAID_AI_ALLOCATIONS_PER_TIER, trial: 0, setup: 0, ended: 0 };
/** The largest request the request bounds allow, per model: a whole context window and every output token. */
function largestRequest(model: string): number {
  const value = aiRequestHoldMicroUsd(model, { inputBytes: AI_REQUEST_LIMITS.systemBytes + AI_REQUEST_LIMITS.textBytes, blocks: AI_REQUEST_LIMITS.contentBlocks, media: 'document', maxTokens: AI_REQUEST_LIMITS.outputTokens });
  if (value === null) throw new Error('A supported model is missing from the cost table');
  return value;
}
/** Month-free ceilings, bound into the commercial terms snapshot. */
export const AUTOMATIC_AI_SPEND_CEILINGS = {
  reviewId: AUTOMATIC_AI_SPEND_REVIEW_ID,
  requestMicroUsd: { 'claude-sonnet-5-5': largestRequest('claude-sonnet-5-5'), 'claude-haiku-5-5': largestRequest('claude-haiku-5-5') },
  storeMicroUsd: AUTOMATIC_AI_STORE_MICRO_USD,
  fundedStores: AUTOMATIC_FUNDED,
  slotMicroUsd: AI_SLOT_MICRO_USD,
} as const;

/** An optional deployment setting that can only LOWER every ceiling: a whole
 * percent from 0 to 100. Above 100 counts as 100; anything else is ignored. */
export function ceilingPercent(raw: string | undefined): number {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,6}$/.test(text)) return 100;
  return Math.min(100, Number(text));
}

/** The automatic policy for the current UTC month. Nothing to renew: a new
 * month is a new ledger, opened once by the first reservation in it. */
export function automaticAiSpendPolicy(now = new Date(), percent = ceilingPercent(typeof process === 'undefined' ? undefined : process.env?.MARKTMORGEN_AI_SPEND_CEILING_PERCENT)): AiSpendPolicy | null {
  if (!Number.isFinite(now.getTime())) return null;
  const share = Math.max(0, Math.min(100, Math.floor(percent)));
  const storeMicroUsd = Object.fromEntries(AI_BUDGET_TIERS.map(tier => [tier, Math.floor(AUTOMATIC_AI_STORE_MICRO_USD[tier] * share / 100)])) as Record<AiBudgetTier, number>;
  const companyMicroUsd = AI_BUDGET_TIERS.reduce((sum, tier) => sum + storeMicroUsd[tier] * AUTOMATIC_FUNDED[tier], 0);
  return {
    reviewId: AUTOMATIC_AI_SPEND_REVIEW_ID,
    month: now.toISOString().slice(0, 7),
    evidence: 'Computed in code from ' + COST_TABLE_VERSION + ' (lib/spend-cost-table.ts) and the published allowances; ceiling ' + share + '%.',
    requestMicroUsd: { ...AUTOMATIC_AI_SPEND_CEILINGS.requestMicroUsd },
    storeMicroUsd,
    companyMicroUsd: Math.max(1, companyMicroUsd),
    fundedStores: { ...AUTOMATIC_FUNDED },
    slotMicroUsd: { ...AI_SLOT_MICRO_USD },
  };
}
/** The policy in force now. Always the automatic one. */
export function currentAiSpendPolicy(now = new Date()): AiSpendPolicy | null {
  return automaticAiSpendPolicy(now);
}

/** Canonical binding to every reviewed monetary ceiling; insertion order cannot change it. */
export function aiSpendPolicySnapshot(policy: AiSpendPolicy): string {
  return JSON.stringify([AI_SPEND_RULES.schema, policy.reviewId, policy.month, policy.evidence, aiEntitlementsSnapshot(),
    ['claude-sonnet-5-5', 'claude-haiku-5-5'].map(model => [model, policy.requestMicroUsd[model as keyof typeof policy.requestMicroUsd]]),
    AI_BUDGET_TIERS.map(tier => [tier, policy.storeMicroUsd[tier], policy.fundedStores[tier]]), policy.companyMicroUsd,
    ...(policy.slotMicroUsd === undefined ? [] : [['writing', 'answer', 'document'].map(kind => [kind, policy.slotMicroUsd![kind as keyof AiSlotPrices]])])]);
}

const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= AI_SPEND_RULES.maxInteger;
export function isAiSpendPolicyValid(policy: AiSpendPolicy | null, now = new Date()): policy is AiSpendPolicy {
  if (!policy || !Number.isFinite(now.getTime()) || policy.month !== now.toISOString().slice(0, 7)
    || typeof policy.reviewId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(policy.reviewId)
    || typeof policy.evidence !== 'string' || !policy.evidence.trim()
    || !integer(policy.companyMicroUsd) || policy.companyMicroUsd <= 0
    || !policy.storeMicroUsd || !AI_BUDGET_TIERS.every(tier => integer(policy.storeMicroUsd[tier]))
    || !policy.fundedStores || !AI_BUDGET_TIERS.every(tier => integer(policy.fundedStores[tier]))
    || !policy.requestMicroUsd || !SUPPORTED_AI_MODELS.every(model => integer(policy.requestMicroUsd[model]) && policy.requestMicroUsd[model] > 0)) return false;
  // Prices per kind of call, when named, are never below the cost table's worst request of that kind, and only the
  // automatic policy names them: it is the one that reserves each request's own hold (lib/ai-spend.ts); a separately
  // reviewed policy debits its flat per-model ceiling, so it is held to that ceiling for every call.
  if (policy.slotMicroUsd !== undefined && (policy.reviewId !== AUTOMATIC_AI_SPEND_REVIEW_ID || !policy.slotMicroUsd || typeof policy.slotMicroUsd !== 'object'
    || !(['writing', 'answer', 'document'] as const).every(kind => integer(policy.slotMicroUsd![kind]) && policy.slotMicroUsd![kind] >= AI_SLOT_MICRO_USD[kind]))) return false;
  const total = AI_BUDGET_TIERS.reduce((sum, tier) => sum + BigInt(policy.storeMicroUsd[tier]) * BigInt(policy.fundedStores[tier]), BigInt(0));
  return AI_BUDGET_TIERS.some(tier => policy.fundedStores[tier] > 0) && total <= BigInt(policy.companyMicroUsd);
}

/** Full monthly allocations in USD cents, rounded upward only after annual aggregation. */
export function aiStoreCostCents(policy: AiSpendPolicy | null, tier: AiBudgetTier, months: number): number | null {
  if (!isAiSpendPolicyValid(policy) || !AI_BUDGET_TIERS.includes(tier) || (months !== 1 && months !== 12) || policy.fundedStores[tier] < 1) return null;
  return Number((BigInt(policy.storeMicroUsd[tier]) * BigInt(months) + BigInt(9999)) / BigInt(10000));
}
