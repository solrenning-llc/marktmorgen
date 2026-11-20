/**
 * 433 [PV3] (b), moved by the owner to Claude 4 (20 November 2026): every AI right a paid plan publishes is funded by
 * its own monthly ceiling, at the worst request its own feature can send, from the cost table (lib/spend-cost-table.ts),
 * never at a figure typed by hand. A writing job's two calls are held at the dearest text request of either fixed model;
 * a visitor answer at the answer model's dearest text request; a PDF read, the only document request, at the answer
 * model's whole context, once per run that took the PDF's jobs. The models are fixed in code, and a document request
 * outside a run that paid for it never reaches the provider (lib/ai.ts refuses it before the reservation; these tests
 * count the provider calls). Every caller of the model is held to the kind of call its price assumes (last test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AI_REQUEST_LIMITS, ANSWER_MODEL, WRITING_MODEL } from '@/lib/ai-request-rules';
import { AI_ENTITLEMENT_RULES, AI_SLOT_MICRO_USD, aiEntitlementsFunded, requiredAiRightsMicroUsd } from '@/lib/ai-entitlement-rules';
import { AUTOMATIC_AI_STORE_MICRO_USD, currentAiSpendPolicy, isAiSpendPolicyValid } from '@/lib/ai-spend-policy';
import { aiRequestHoldMicroUsd } from '@/lib/spend-cost-table';
import { AI_MONTHLY, READ_PDF_JOBS } from '@/lib/ai-rules';
import { ANSWERS_MONTHLY } from '@/lib/answers-rules';
import { consumeAiDocumentRead, withAiCallBudget } from '@/lib/ai-call-budget';
import { answerModel, askModel, writingModel } from '@/lib/ai';
import type { Store } from '@/lib/store';

const textMax = { inputBytes: AI_REQUEST_LIMITS.systemBytes + AI_REQUEST_LIMITS.textBytes, blocks: AI_REQUEST_LIMITS.contentBlocks, media: 'image' as const, maxTokens: AI_REQUEST_LIMITS.outputTokens };
const documentMax = { ...textMax, media: 'document' as const };
const hold = (model: string, shape: typeof textMax | typeof documentMax) => {
  const value = aiRequestHoldMicroUsd(model, shape);
  assert.ok(value !== null && value > 0, `${model} has no price in the cost table`);
  return value;
};

test('the models are fixed in code: Sonnet 5.5 writes, Haiku 5.5 answers and reads PDFs', () => {
  assert.equal(WRITING_MODEL, 'claude-sonnet-5-5');
  assert.equal(ANSWER_MODEL, 'claude-haiku-5-5');
  const saved = { writing: process.env.AI_MODEL, answer: process.env.AI_ANSWER_MODEL };
  try {
    // A deployment setting can no longer move a feature to a model its ceiling was not computed for.
    process.env.AI_MODEL = 'claude-haiku-5-5';
    process.env.AI_ANSWER_MODEL = 'claude-sonnet-5-5';
    assert.equal(writingModel(), WRITING_MODEL);
    assert.equal(answerModel(), ANSWER_MODEL);
  } finally {
    if (saved.writing === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = saved.writing;
    if (saved.answer === undefined) delete process.env.AI_ANSWER_MODEL; else process.env.AI_ANSWER_MODEL = saved.answer;
  }
});

test('the price of each kind of call comes from the cost table, at its worst request', () => {
  const writing = Math.max(hold(WRITING_MODEL, textMax), hold(ANSWER_MODEL, textMax));
  assert.deepEqual(AI_SLOT_MICRO_USD, { writing, answer: hold(ANSWER_MODEL, textMax), document: hold(ANSWER_MODEL, documentMax) });
  // The dearest text request an answer can send stays in Haiku's lower price tier (prompts up to 100,000 tokens).
  assert.ok(AI_SLOT_MICRO_USD.answer < AI_SLOT_MICRO_USD.writing);
  assert.ok(AI_SLOT_MICRO_USD.document > AI_SLOT_MICRO_USD.writing);
});

test("every paid plan's AI ceiling funds all its published writing jobs, PDF reads and answers at once", () => {
  for (const tier of ['creator', 'pro', 'scale'] as const) {
    const jobs = AI_MONTHLY[tier], answers = ANSWERS_MONTHLY[tier];
    // A PDF run takes 1 + READ_PDF_JOBS jobs and may give one back after reading: a read can net READ_PDF_JOBS jobs.
    const pdfRuns = jobs >= 1 + READ_PDF_JOBS ? Math.floor((jobs - 1) / READ_PDF_JOBS) : 0;
    const expected = jobs * AI_ENTITLEMENT_RULES.writingCallsPerJob * AI_SLOT_MICRO_USD.writing
      + pdfRuns * (AI_SLOT_MICRO_USD.document - AI_SLOT_MICRO_USD.writing)
      + answers * AI_ENTITLEMENT_RULES.visitorCallsPerAttempt * AI_SLOT_MICRO_USD.answer;
    assert.equal(Number(requiredAiRightsMicroUsd(tier)), expected, `${tier}: the required ceiling`);
    assert.equal(AUTOMATIC_AI_STORE_MICRO_USD[tier], expected, `${tier}: the automatic ceiling is the required one`);
  }
  assert.equal(AUTOMATIC_AI_STORE_MICRO_USD.creator, 0);
  const policy = currentAiSpendPolicy();
  assert.ok(policy);
  assert.equal(aiEntitlementsFunded(policy), true);
  // One microdollar less on either plan with AI leaves a published right unfunded.
  for (const tier of ['pro', 'scale'] as const) assert.equal(aiEntitlementsFunded({ ...policy, storeMicroUsd: { ...policy.storeMicroUsd, [tier]: policy.storeMicroUsd[tier] - 1 } }), false);
});

test('a run reads at most the PDFs it took the jobs for; an uncounted call reads none', async () => {
  assert.equal(await withAiCallBudget('rights_test', 2, async () => consumeAiDocumentRead('rights_test')), false);
  assert.deepEqual(await withAiCallBudget('rights_test', 20, async () => [consumeAiDocumentRead('rights_test'), consumeAiDocumentRead('rights_test')], undefined, 1), [true, false]);
  assert.equal(await withAiCallBudget('rights_test', 20, async () => consumeAiDocumentRead('another_store'), undefined, 1), false);
  assert.equal(consumeAiDocumentRead('rights_test'), false);
});

test('a document request outside a run that paid for it, or on the writing model, never reaches the provider', async () => {
  const statsId = 'rights_test';
  const store = { statsId, tier: 'creator', trialEnds: 0 } as unknown as Store;
  const pdf = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' } }, { type: 'text', text: 'Read this' }];
  const oldFetch = globalThis.fetch, key = process.env.ANTHROPIC_API_KEY;
  let calls = 0;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-only-funded-rights-0123456789';
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })); }) as typeof fetch;
  try {
    assert.equal(await askModel(store, 'facts', pdf, 20, ANSWER_MODEL), null);
    assert.equal(await withAiCallBudget(statsId, 20, () => askModel(store, 'facts', pdf, 20, WRITING_MODEL), undefined, 1), null);
    assert.equal(calls, 0);
    // The same PDF inside a run that took its jobs, on the answer model, is read; text needs no PDF allowance.
    assert.equal(await withAiCallBudget(statsId, 20, () => askModel(store, 'facts', pdf, 20, ANSWER_MODEL), undefined, 1), 'ok');
    assert.equal(await askModel(store, 'facts', 'hello', 20, ANSWER_MODEL), 'ok');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = oldFetch;
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key;
  }
});

/** Each top-level function of a file, by name, with its body (a function ends where the next top-level one starts). */
function functionsOf(source: string): { name: string; body: string }[] {
  const starts = [...source.matchAll(/\n(?:export )?(?:async )?function (\w+)|\nexport const (\w+) *=/g)].map(m => ({ at: m.index!, name: m[1] ?? m[2] }));
  return starts.map((start, i) => ({ name: start.name, body: source.slice(start.at, starts[i + 1]?.at ?? source.length) }));
}
function sourcesUnder(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir)).flatMap(name => {
    const path = join(dir, name);
    return statSync(join(process.cwd(), path)).isDirectory() ? sourcesUnder(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('every caller of the model is a kind of call its price assumes: a counted writing job, or an answer on the answer model', () => {
  // A visitor answer and the store guide take one answer each (takeAnswer) and ask the answer model with text. The
  // affiliate kit's posts take one writing job (lib/affiliate-kit.ts) before writeAffiliatePosts asks. A PDF read runs
  // inside writePage's counted run, which took its jobs. Every other caller runs inside counted or countedRun.
  const answerFiles = new Set(['lib/answers.ts', 'lib/store-guide.ts']);
  const countedElsewhere = new Map([['lib/ai.ts', new Set(['ask', 'askModel', 'readPdfFacts', 'writeAffiliatePosts'])]]);
  const callers: string[] = [];
  for (const file of [...sourcesUnder('lib'), ...sourcesUnder('app')]) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    for (const fn of functionsOf(source)) {
      const calls = [...fn.body.matchAll(/\b(askModel|ask)\(store\b([\s\S]*?)\);/g)];
      if (!calls.length || countedElsewhere.get(file)?.has(fn.name)) continue;
      callers.push(`${file} ${fn.name}`);
      if (answerFiles.has(file)) {
        assert.match(fn.body, /takeAnswer\(/, `${file} ${fn.name}: an answer is taken before the model is asked`);
        for (const call of calls) assert.match(call[2], /answerModel\(\)/, `${file} ${fn.name}: an answer is priced at the answer model`);
        assert.doesNotMatch(fn.body, /type:\s*["']document["']/, `${file} ${fn.name}: an answer sends no document`);
      } else if (/\bdeps\.count\(/.test(fn.body)) {
        // Injected for tests (lib/csv-map-ai.ts): the live wiring must count the job and ask through askModel.
        assert.match(source, /count:\s*counted\b/, `${file} ${fn.name}: its live job count is counted`);
        assert.match(source, /ask:\s*(askModel\b|\([^)]*\)\s*=>\s*askModel\()/, `${file} ${fn.name}: its live call is askModel`);
      } else {
        assert.match(fn.body, /\bcounted(Run)?\(/, `${file} ${fn.name}: a call outside a counted writing job is funded by no right`);
      }
    }
  }
  assert.ok(callers.length > 20, `the sweep found the model's callers (${callers.length})`);
  // The PDF read is the only document request, inside writePage, which says it reads one.
  const ai = readFileSync(join(process.cwd(), 'lib/ai.ts'), 'utf8');
  const documentSenders = functionsOf(ai).filter(fn => /type:\s*["']document["']/.test(fn.body)).map(fn => fn.name);
  assert.deepEqual(documentSenders, ['readPdfFacts']);
  const writePage = functionsOf(ai).find(fn => fn.name === 'writePage')!.body;
  assert.match(writePage, /readPdfFacts\(/);
  assert.match(writePage, /pdf \? 1 \+ READ_PDF_JOBS : 1, unrun, pdf \? DOCUMENT_READS_PER_PDF_RUN : 0\)/);
  for (const file of [...sourcesUnder('lib'), ...sourcesUnder('app')].filter(f => f !== 'lib/ai.ts')) {
    assert.doesNotMatch(readFileSync(join(process.cwd(), file), 'utf8'), /media_type:\s*["']application\/pdf["'][\s\S]{0,400}askModel|askModel[\s\S]{0,400}media_type:\s*["']application\/pdf["']/, `${file} sends a document to the model`);
  }
});

test('a policy cannot name a price per kind of call below the cost table, and one without prices keeps the largest request for every call', () => {
  const policy = currentAiSpendPolicy();
  assert.ok(policy && isAiSpendPolicyValid(policy));
  assert.deepEqual(policy.slotMicroUsd, AI_SLOT_MICRO_USD);
  for (const kind of ['writing', 'answer', 'document'] as const) assert.equal(isAiSpendPolicyValid({ ...policy, slotMicroUsd: { ...AI_SLOT_MICRO_USD, [kind]: AI_SLOT_MICRO_USD[kind] - 1 } }), false, kind);
  const unnamed = { ...policy };
  delete unnamed.slotMicroUsd;
  // Every call at the largest request (a whole-context document on Sonnet) is far above these ceilings: unfunded.
  assert.equal(aiEntitlementsFunded(unnamed), false);
});
