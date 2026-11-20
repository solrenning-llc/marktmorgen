/**
 * lib/spend-cost-table.ts is the one source of the supplier rates behind the
 * automatic ceilings. These checks fail when another file repeats a rate that
 * no longer matches it, and show that the hold of a request is a bound worked
 * out from the request itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AI_CALL_INFRA_MICRO_USD, AI_CALL_WAIT_SECONDS, AI_FRAMING_TOKENS, AI_TOKENS_PER_BLOCK, ANSWER_MICRO_USD, ANTHROPIC_RATES, IMAGE_TOKEN_CEILING,
  PDF_READ_MICRO_USD, PROVIDER_CHARGES_BPS, R2_STORAGE_MICRO_USD_PER_GB_MONTH, UPSTASH_MICRO_USD_PER_MILLION_COMMANDS, VERCEL_CALL_MICRO_USD_PER_MILLION,
  VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR, WRITING_JOB_MICRO_USD, aiRequestHoldMicroUsd,
} from '@/lib/spend-cost-table';
import { ANSWER_MODEL, SUPPORTED_AI_MODELS, WRITING_MODEL, boundedAiRequest } from '@/lib/ai-request-rules';
import { READ_PDF_JOBS } from '@/lib/ai-rules';

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const usd = (micro: number) => micro / 1_000_000;

test('every supported model is priced, and nothing else is', () => {
  assert.deepEqual([...SUPPORTED_AI_MODELS].sort(), Object.keys(ANTHROPIC_RATES).sort());
});

test('the models fixed in code are priced, and lib/ai.ts asks only them', () => {
  // 433 [PV3] (b): the models are constants (lib/ai-request-rules.ts), no longer defaults a deployment setting could replace.
  for (const name of [WRITING_MODEL, ANSWER_MODEL]) assert.ok(Object.hasOwn(ANTHROPIC_RATES, name), name);
  assert.deepEqual([WRITING_MODEL, ANSWER_MODEL], ['claude-sonnet-5-5', 'claude-haiku-5-5']);
  const ai = read('lib/ai.ts');
  assert.match(ai, /function model\(\): string \{\n  return WRITING_MODEL;\n\}/);
  assert.match(ai, /export function answerModel\(\): string \{\n  return ANSWER_MODEL;\n\}/);
  assert.doesNotMatch(ai, /process\.env\.AI_(ANSWER_)?MODEL/);
});

test('the model wait priced per call is the model timeout in lib/ai.ts', () => {
  const match = read('lib/ai.ts').match(/const AI_TIMEOUT_MS = ([\d_]+);/);
  assert.ok(match);
  assert.equal(Number(match![1].replace(/_/g, '')), AI_CALL_WAIT_SECONDS * 1000);
});

test('rates repeated elsewhere match the table', () => {
  const answers = read('lib/answers-rules.ts').match(/Haiku 5\.5 at \$([\d.]+) and \$([\d.]+)\s+\*?\s*per million/);
  assert.ok(answers, 'lib/answers-rules.ts states the answering model rate');
  const haiku = ANTHROPIC_RATES['claude-haiku-5-5'].tiers[0];
  assert.equal(Number(answers![1]), usd(haiku.inputMicroUsdPerMTok));
  assert.equal(Number(answers![2]), usd(haiku.outputMicroUsdPerMTok));
  const traffic = read('tests/traffic-cost.ts');
  assert.match(traffic, new RegExp('const CALL = ' + usd(VERCEL_CALL_MICRO_USD_PER_MILLION) + ' / 1_000_000;'));
  assert.match(traffic, new RegExp('const CPU_PER_SECOND = ' + usd(VERCEL_CPU_MICRO_USD_PER_HOUR) + ' / 3600;'));
  assert.match(traffic, new RegExp('const MEMORY_PER_SECOND = \\(' + usd(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR) + ' \\* ' + VERCEL_FUNCTION_GB + '\\) / 3600;'));
  assert.match(traffic, new RegExp('export const COMMAND = ' + usd(UPSTASH_MICRO_USD_PER_MILLION_COMMANDS).toFixed(1) + ' / 1_000_000;'));
  assert.match(read('docs/tier-storage-limits.md'), new RegExp('\\$' + usd(R2_STORAGE_MICRO_USD_PER_GB_MONTH) + ' per decimal GB-month'));
});

test('no rough per-draft figure survives beside the table', () => {
  for (const file of ['tests/plan-margin.test.ts', 'tests/plan-cost-model.ts']) assert.doesNotMatch(read(file), /PER_DRAFT/);
});

test('a hold is input bytes plus framing at the input rate, every output token at the output rate, then charges and hosting', () => {
  const sonnet = ANTHROPIC_RATES['claude-sonnet-5-5'].tiers[0];
  const input = 1_000 + AI_FRAMING_TOKENS + AI_TOKENS_PER_BLOCK;
  const provider = Math.ceil(input * sonnet.inputMicroUsdPerMTok / 1e6) + Math.ceil(500 * sonnet.outputMicroUsdPerMTok / 1e6);
  const expected = Math.ceil(provider * (10_000 + PROVIDER_CHARGES_BPS) / 10_000) + AI_CALL_INFRA_MICRO_USD;
  assert.equal(aiRequestHoldMicroUsd('claude-sonnet-5-5', { inputBytes: 1_000, blocks: 1, media: null, maxTokens: 500 }), expected);
});

test('the hold moves with the request: more bytes, more output, a picture or a document all hold more', () => {
  const base = { inputBytes: 2_000, blocks: 1, media: null, maxTokens: 500 } as const;
  const at = (shape: Parameters<typeof aiRequestHoldMicroUsd>[1]) => aiRequestHoldMicroUsd('claude-sonnet-5-5', shape)!;
  assert.ok(at({ ...base, inputBytes: 4_000 }) > at(base));
  assert.ok(at({ ...base, maxTokens: 1_000 }) > at(base));
  assert.ok(at({ ...base, media: 'image' }) >= at(base) + Math.floor(IMAGE_TOKEN_CEILING * 2));
  assert.ok(at({ ...base, media: 'document' }) > at({ ...base, inputBytes: 500_000 }));
});

test('a Haiku request past 100,000 tokens is priced at the higher rate for all of it', () => {
  const low = aiRequestHoldMicroUsd('claude-haiku-5-5', { inputBytes: 90_000, blocks: 1, media: null, maxTokens: 100 })!;
  const high = aiRequestHoldMicroUsd('claude-haiku-5-5', { inputBytes: 110_000, blocks: 1, media: null, maxTokens: 100 })!;
  assert.ok(high > low * 4, `${low} then ${high}`);
});

test('unknown models and malformed shapes are not priced, so they cannot be reserved', () => {
  assert.equal(aiRequestHoldMicroUsd('claude-unknown', { inputBytes: 1, blocks: 1, media: null, maxTokens: 1 }), null);
  for (const shape of [{ inputBytes: -1, blocks: 1, media: null, maxTokens: 1 }, { inputBytes: 1, blocks: 0, media: null, maxTokens: 1 }, { inputBytes: 1, blocks: 1, media: null, maxTokens: 0 }, { inputBytes: 1.5, blocks: 1, media: null, maxTokens: 1 }, { inputBytes: 1, blocks: 1, media: 'video', maxTokens: 1 }])
    assert.equal(aiRequestHoldMicroUsd('claude-haiku-5-5', shape as never), null);
});

test('a bounded request reports the shape it is held by', () => {
  const text = boundedAiRequest('héllo', 'abc', 200, 'claude-haiku-5-5');
  assert.ok(text.ok);
  assert.deepEqual(text.shape, { inputBytes: 6 + 3, blocks: 1, media: null, maxTokens: 200 });
  const pdf = boundedAiRequest('s', [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' } }, { type: 'text', text: 'pages' }], 300, 'claude-haiku-5-5');
  assert.ok(pdf.ok);
  assert.deepEqual(pdf.shape, { inputBytes: 1 + 5, blocks: 2, media: 'document', maxTokens: 300 });
});

test('the priced units and the PDF reading are what the table works them out to', () => {
  console.log(`writing job $${usd(WRITING_JOB_MICRO_USD).toFixed(6)}, answer $${usd(ANSWER_MICRO_USD).toFixed(6)}, PDF reading $${usd(PDF_READ_MICRO_USD).toFixed(6)}, hosting per call $${usd(AI_CALL_INFRA_MICRO_USD).toFixed(6)}`);
  assert.equal(READ_PDF_JOBS, Math.ceil(PDF_READ_MICRO_USD / WRITING_JOB_MICRO_USD));
  assert.ok(READ_PDF_JOBS * WRITING_JOB_MICRO_USD >= PDF_READ_MICRO_USD);
});
