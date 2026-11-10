/**
 * The one table of supplier rates that the automatic spend ceilings are
 * computed from (lib/ai-spend-policy.ts, lib/upload-budget-policy.ts).
 * Client-safe: no secrets, no environment, no network.
 *
 * Every figure is a published list price, read on the date below, or a
 * deliberately high allowance stated as such. Nothing here is an average or
 * a forecast. A changed rate moves every ceiling and every reservation that
 * is computed from it; tests/spend-cost-table.test.ts fails when another file
 * repeats a rate that no longer matches this one.
 *
 * Sources, read 2026-10-17:
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   https://platform.claude.com/docs/en/models/sonnet-5-5/overview
 *   https://platform.claude.com/docs/en/models/haiku-5-5/overview
 *   https://platform.claude.com/docs/en/build-with-claude/vision
 *   https://platform.claude.com/docs/en/build-with-claude/pdf-support
 *   https://developers.cloudflare.com/r2/pricing/
 *   https://upstash.com/pricing/redis (the Upstash transfer and storage rates)
 *
 * Read 2026-11-10 (the Vercel Blob operation rate):
 *   https://vercel.com/docs/vercel-blob/usage-and-pricing (page dated 2026-09-23)
 *   https://vercel.com/docs/pricing/regional-pricing (page dated 2026-09-14)
 */
import { BLOB_LIST_PAGES } from '@/lib/storage-rules';
import { VAULT_CONTROL_CALLS_PER_UPLOAD, VAULT_LIST_PAGES, VAULT_MEASURE_REQUESTS } from '@/lib/vault-rules';
export const COST_TABLE_VERSION = 'cost-table-2026-10-17';

type RateTier = { readonly upToInputTokens: number; readonly inputMicroUsdPerMTok: number; readonly outputMicroUsdPerMTok: number };
type ModelRates = { readonly contextTokens: number; readonly tiers: readonly RateTier[] };

/** Anthropic list prices in micro-USD per million tokens (1 USD = 1,000,000).
 * Sonnet 5.5: $2 in / $10 out across the full 1M context at standard pricing.
 * Haiku 5.5: $0.10 / $0.50 for prompts up to 100,000 tokens and $0.50 / $2.50
 * above, the whole request priced at the higher rate. The application never
 * sends inference_geo, so the 1.1x US-only multiplier does not apply.
 */
export const ANTHROPIC_RATES = {
  'claude-sonnet-5-5': { contextTokens: 1_000_000, tiers: [{ upToInputTokens: 1_000_000, inputMicroUsdPerMTok: 2_000_000, outputMicroUsdPerMTok: 10_000_000 }] },
  'claude-haiku-5-5': { contextTokens: 1_000_000, tiers: [
    { upToInputTokens: 100_000, inputMicroUsdPerMTok: 100_000, outputMicroUsdPerMTok: 500_000 },
    { upToInputTokens: 1_000_000, inputMicroUsdPerMTok: 500_000, outputMicroUsdPerMTok: 2_500_000 },
  ] },
} as const satisfies Record<string, ModelRates>;
export type RatedModel = keyof typeof ANTHROPIC_RATES;

/** A deliberately high allowance, not a measured rate, added to every model
 * charge for taxes on the provider invoice, currency exchange and card or
 * remittance costs. */
export const PROVIDER_CHARGES_BPS = 1_000;

/** A hard input bound worked out from the request itself. Every token covers
 * at least one byte of text, so UTF-8 bytes bound the text tokens; the
 * framing allowance covers the message structure. An image is downscaled by
 * the provider to at most 4,784 visual tokens (the high-resolution tier of
 * Claude 4.7 and later; 1,568 on older models). A PDF page carries extracted
 * text that its byte size does not bound, so a request with a document is
 * held at the model's whole context window. */
export const AI_FRAMING_TOKENS = 1_024;
export const AI_TOKENS_PER_BLOCK = 32;
export const IMAGE_TOKEN_CEILING = 4_784;

/** Hosting rates for the request that waits on the model (tests/traffic-cost.ts
 * holds the same figures for visits): function memory $0.0106 per GB-hour at
 * 2 GB, held for the whole 45-second model timeout; $0.60 per million
 * function calls; $0.128 per CPU-hour, one CPU-second counted; $2.00 per
 * million database commands, twenty counted. */
export const VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR = 10_600;
export const VERCEL_FUNCTION_GB = 2;
export const VERCEL_CALL_MICRO_USD_PER_MILLION = 600_000;
export const VERCEL_CPU_MICRO_USD_PER_HOUR = 128_000;
export const UPSTASH_MICRO_USD_PER_MILLION_COMMANDS = 2_000_000;
export const AI_CALL_WAIT_SECONDS = 45;
const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;
/** What one model call costs the host and the database, whatever its answer. */
export const AI_CALL_INFRA_MICRO_USD = Number(
  ceilDiv(BigInt(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR * VERCEL_FUNCTION_GB * AI_CALL_WAIT_SECONDS), BigInt(3600))
  + ceilDiv(BigInt(VERCEL_CALL_MICRO_USD_PER_MILLION), BigInt(1_000_000))
  + ceilDiv(BigInt(VERCEL_CPU_MICRO_USD_PER_HOUR), BigInt(3600))
  + ceilDiv(BigInt(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS * 20), BigInt(1_000_000)));

/** Upstash Redis pay as you go, with no free quota counted: data moved past
 * the free 200 GB a month is $0.03 a GB, and data kept past the first free GB
 * $0.25 a GB-month. Read 2026-10-17 for the per-plan worst case of the
 * features that move or keep store data in the database
 * (tests/plan-cost-registry.ts). Storage is billed on the daily average of
 * the data kept, across every replica and region (Upstash's pricing FAQ,
 * read 2026-10-18): one region is priced here, and a read region added to
 * the database multiplies the storage line by the copies it keeps. */
export const UPSTASH_MICRO_USD_PER_GB_TRANSFER = 30_000;
export const UPSTASH_MICRO_USD_PER_GB_MONTH = 250_000;

/** Cloudflare R2 Standard, no free-tier credit: $0.015 per GB-month,
 * $4.50 per million Class A operations, $0.36 per million Class B. */
export const R2_STORAGE_MICRO_USD_PER_GB_MONTH = 15_000;
export const R2_CLASS_A_MICRO_USD_PER_MILLION = 4_500_000;
export const R2_CLASS_B_MICRO_USD_PER_MILLION = 360_000;

/** Vercel Blob Advanced Operations (an upload, a copy, a list, a store
 * created), no included amount counted: the top of the regional range,
 * "Blob Advanced Operations | 1,000,000 for $4.50 - $7.00" (Regional
 * Pricing, read 2026-11-10), so no region is assumed. The Blob pricing page
 * (read 2026-11-10) counts every list as one. */
export const BLOB_ADVANCED_MICRO_USD_PER_MILLION = 7_000_000;

/** Upload doors (lib/upload-budget.ts): each request is a function call held
 * at 2 GB for up to 10 seconds with one CPU-second and twenty database
 * commands. An upload start is priced at the R2 operations its own path makes
 * at most (app/api/store/vault: open, done, abort; held by
 * tests/vault-open-class-a.test.ts). Class A: every page of the vault listing
 * that admission reads (VAULT_LIST_PAGES), CreateMultipartUpload and
 * CompleteMultipartUpload; AbortMultipartUpload and DeleteObject are free.
 * Class B: three file measurements (VAULT_MEASURE_REQUESTS each, a HEAD and a
 * ranged GET): the expired session admission retires, the completion, and a
 * cancellation after a completion whose measurement could not be read. Each
 * signed piece is one Class A part upload. Vercel Blob: every page of the
 * host file store's listing that admission reads (BLOB_LIST_PAGES, Vercel
 * Blob list, an Advanced Operation). */
export const UPLOAD_REQUEST_WAIT_SECONDS = 10;
export const UPLOAD_REQUEST_INFRA_MICRO_USD = Number(
  ceilDiv(BigInt(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR * VERCEL_FUNCTION_GB * UPLOAD_REQUEST_WAIT_SECONDS), BigInt(3600))
  + ceilDiv(BigInt(VERCEL_CALL_MICRO_USD_PER_MILLION), BigInt(1_000_000))
  + ceilDiv(BigInt(VERCEL_CPU_MICRO_USD_PER_HOUR), BigInt(3600))
  + ceilDiv(BigInt(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS * 20), BigInt(1_000_000)));
export const UPLOAD_OPEN_CLASS_A_OPS = VAULT_LIST_PAGES + 2;
export const UPLOAD_OPEN_CLASS_B_OPS = 3 * VAULT_MEASURE_REQUESTS;
export const UPLOAD_OPEN_BLOB_ADVANCED_OPS = BLOB_LIST_PAGES;
/** Requests one upload start is priced for: the start, and the finish and
 * cancel requests lib/vault.ts lets one upload make in all
 * (VAULT_CONTROL_CALLS_PER_UPLOAD: a repeat past them is refused before any
 * other work, and a repeat inside them is answered from the first one's
 * record, with no request to R2; tests/vault-control-once.test.ts). */
export const UPLOAD_REQUESTS_PER_OPEN = 1 + VAULT_CONTROL_CALLS_PER_UPLOAD;

/** The most a month of upload starts and signed pieces can cost, in whole micro-USD. */
export function uploadOperationsMicroUsd(opens: number, controlRequests: number, piecesPerControl: number): number | null {
  if (![opens, controlRequests, piecesPerControl].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  const million = BigInt(1_000_000);
  const classA = BigInt(opens) * BigInt(UPLOAD_OPEN_CLASS_A_OPS) + BigInt(controlRequests) * BigInt(piecesPerControl);
  const classB = BigInt(opens) * BigInt(UPLOAD_OPEN_CLASS_B_OPS);
  const requests = BigInt(opens) * BigInt(UPLOAD_REQUESTS_PER_OPEN) + BigInt(controlRequests);
  const blobAdvanced = BigInt(opens) * BigInt(UPLOAD_OPEN_BLOB_ADVANCED_OPS);
  const total = ceilDiv(classA * BigInt(R2_CLASS_A_MICRO_USD_PER_MILLION), million) + ceilDiv(classB * BigInt(R2_CLASS_B_MICRO_USD_PER_MILLION), million)
    + ceilDiv(blobAdvanced * BigInt(BLOB_ADVANCED_MICRO_USD_PER_MILLION), million)
    + requests * BigInt(UPLOAD_REQUEST_INFRA_MICRO_USD);
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(total);
}

export type AiRequestShape = { inputBytes: number; blocks: number; media: 'image' | 'document' | null; maxTokens: number };

/** The most one request can cost, in whole micro-USD, rounded up at every
 * step. Null when the model or the shape is not one this table can bound. */
export function aiRequestHoldMicroUsd(model: string, shape: AiRequestShape): number | null {
  if (!Object.hasOwn(ANTHROPIC_RATES, model) || !shape || typeof shape !== 'object') return null;
  const { inputBytes, blocks, media, maxTokens } = shape;
  if (![inputBytes, blocks, maxTokens].every(n => Number.isSafeInteger(n) && n >= 0) || maxTokens < 1 || blocks < 1
    || (media !== null && media !== 'image' && media !== 'document')) return null;
  const rates: ModelRates = ANTHROPIC_RATES[model as RatedModel];
  const bound = inputBytes + AI_FRAMING_TOKENS + AI_TOKENS_PER_BLOCK * blocks + (media === 'image' ? IMAGE_TOKEN_CEILING : 0);
  const input = media === 'document' ? rates.contextTokens : Math.min(bound, rates.contextTokens);
  if (maxTokens > rates.contextTokens) return null;
  const tier = rates.tiers.find(row => input <= row.upToInputTokens);
  if (!tier) return null;
  const million = BigInt(1_000_000);
  const provider = ceilDiv(BigInt(input) * BigInt(tier.inputMicroUsdPerMTok), million) + ceilDiv(BigInt(maxTokens) * BigInt(tier.outputMicroUsdPerMTok), million);
  const charged = ceilDiv(provider * BigInt(10_000 + PROVIDER_CHARGES_BPS), BigInt(10_000));
  const total = charged + BigInt(AI_CALL_INFRA_MICRO_USD);
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(total);
}

/** The priced unit behind a writing job: one call to the writing model with
 * 12 KiB of instructions and notes and up to 3,000 tokens back. Longer
 * requests (a whole sales page, a PDF) reserve more and are said to. */
export const WRITING_JOB_REFERENCE = { model: 'claude-sonnet-5-5', shape: { inputBytes: 12_288, blocks: 1, media: null, maxTokens: 3_000 } } as const;
/** The priced unit behind a visitor answer or a store-guide reply: one call to
 * the answering model with 24 KiB of page facts and question, 400 tokens back. */
export const ANSWER_REFERENCE = { model: 'claude-haiku-5-5', shape: { inputBytes: 24_576, blocks: 1, media: null, maxTokens: 400 } } as const;
/** Reading a product's PDF: the answering model, a document and 1,500 tokens back. */
export const PDF_READ_REFERENCE = { model: 'claude-haiku-5-5', shape: { inputBytes: 2_048, blocks: 2, media: 'document', maxTokens: 1_500 } } as const;

const priced = (ref: { model: string; shape: AiRequestShape }) => {
  const value = aiRequestHoldMicroUsd(ref.model, ref.shape);
  if (value === null) throw new Error('Unpriceable reference request');
  return value;
};
export const WRITING_JOB_MICRO_USD = priced(WRITING_JOB_REFERENCE);
export const ANSWER_MICRO_USD = priced(ANSWER_REFERENCE);
export const PDF_READ_MICRO_USD = priced(PDF_READ_REFERENCE);


/** Explicit aggregate bounds for one protocol obligation. These are supplied
 * measurements/ceilings, never defaults or evidence that a budget is funded.
 * transferBytes includes all reads, writes and replicas; storageCopies counts
 * every region/replica holding retainedBytes for retentionMonths.
 */
export type ProtocolInfrastructureBounds = {
  functionCalls: number;
  memoryGbMilliseconds: number;
  cpuMilliseconds: number;
  redisCommands: number;
  transferBytes: number;
  retainedBytes: number;
  retentionMonths: number;
  storageCopies: number;
};

/** Price finite, explicit protocol bounds using the same canonical rates as
 * other reservations. Unknown/inherited/computed values fail without running
 * their getters. Permanent or unresolved retention has no implicit free tail.
 * This prices infrastructure only: payment, mail, support, fixed expenses,
 * customer rights and all applicable taxes still need the canonical review.
 * It neither reserves money nor authorizes an operation.
 */
export function protocolInfrastructureMicroUsd(
  input: ProtocolInfrastructureBounds | null,
): { baseMicroUsd: number; providerAllowanceMicroUsd: number; totalMicroUsd: number } | null {
  if (!input || typeof input !== 'object') return null;
  const keys = ['functionCalls', 'memoryGbMilliseconds', 'cpuMilliseconds',
    'redisCommands', 'transferBytes', 'retainedBytes', 'retentionMonths', 'storageCopies'] as const;
  const values: bigint[] = [];
  try {
    // Reject unpriced categories before projecting the known components. A
    // complete profile must survive a plain-data snapshot without omissions.
    if (Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).length !== keys.length) return null;
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (!field || !field.enumerable || !Object.hasOwn(field, 'value') ||
          !Number.isSafeInteger(field.value) || field.value < 0) return null;
      values.push(BigInt(field.value));
    }
    // Native structured serialization rejects Proxy exotic objects even
    // when their reflection traps conceal fields. Only validated numeric
    // data reaches this step, so ordinary accessors are never executed.
    // https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal
    structuredClone(input);
  } catch { return null; }
  const [calls, memory, cpu, commands, transfer, retained, months, copies] = values;
  if (copies < BigInt(1) || (retained > BigInt(0) && months === BigInt(0))) return null;
  const base =
    ceilDiv(calls * BigInt(VERCEL_CALL_MICRO_USD_PER_MILLION), BigInt(1_000_000)) +
    ceilDiv(memory * BigInt(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR), BigInt(3_600_000)) +
    ceilDiv(cpu * BigInt(VERCEL_CPU_MICRO_USD_PER_HOUR), BigInt(3_600_000)) +
    ceilDiv(commands * BigInt(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS), BigInt(1_000_000)) +
    ceilDiv(transfer * BigInt(UPSTASH_MICRO_USD_PER_GB_TRANSFER), BigInt(1_000_000_000)) +
    ceilDiv(retained * months * copies * BigInt(UPSTASH_MICRO_USD_PER_GB_MONTH), BigInt(1_000_000_000));
  const allowance = ceilDiv(base * BigInt(PROVIDER_CHARGES_BPS), BigInt(10_000));
  const total = base + allowance;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { baseMicroUsd: Number(base), providerAllowanceMicroUsd: Number(allowance), totalMicroUsd: Number(total) };
}
