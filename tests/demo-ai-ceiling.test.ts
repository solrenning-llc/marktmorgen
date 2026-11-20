/**
 * The demo store's own AI ceiling (owner, 20/11/2026, decision 1 to Claude 4; lib/demo-ai-rules.ts).
 *
 * The demo earns nothing, so its AI is a fixed cost of the LLC: it gets its own allowance (visitor answers and
 * store-guide replies, no writing job), priced by the cost table under the owner's cap of US$3.35, taken before each
 * call, and, once used up, a fixed answer labeled as an example instead of an error or a call. The model is played by
 * a stand-in for `fetch`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addProduct, claimHandle, ensureStatsId, setAnswers, setSubscription, storeForEmail } from '@/lib/store';
import { readListing, readListings } from '@/lib/catalog';
import { answerQuestion, answersAllowance, takeAnswer } from '@/lib/answers';
import { guideVisitor } from '@/lib/store-guide';
import { aiAllowance } from '@/lib/ai';
import { HOUSE_OWNER } from '@/lib/house-store';
import { ANSWERS_MONTHLY } from '@/lib/answers-rules';
import { AI_MONTHLY } from '@/lib/ai-rules';
import { AI_ENTITLEMENT_RULES, AI_SLOT_MICRO_USD } from '@/lib/ai-entitlement-rules';
import { DEMO_AI_ANSWERS_MONTHLY, DEMO_AI_CEILING_MICRO_USD, DEMO_AI_OWNER_CAP_MICRO_USD, DEMO_AI_WRITING_JOBS_MONTHLY, DEMO_EXAMPLE_ANSWER, DEMO_EXAMPLE_LABEL, DEMO_EXAMPLE_PICK_WHY } from '@/lib/demo-ai-rules';
import { CURRENT_LLC_FIXED_COST_CEILINGS, FIXED_COST_SOURCE_OBSERVATIONS, LLC_FIXED_COST_IDS } from '@/lib/llc-fixed-costs';
import { store as redis } from './redis-stub';
import { paidPeriod } from './billing-period-fixture';

let calls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === 'api.anthropic.com') {
    calls++;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"known": true, "answer": "A printable PDF."}' }] }));
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

async function storeOf(owner: string, handle: string) {
  await claimHandle(owner, handle, handle, '');
  await setSubscription(owner, { customerId: 'cus_Demo000001', subscriptionId: 'sub_Demo000001', active: true, tier: 'pro', trialEnds: 0, period: paidPeriod() });
  await ensureStatsId(owner);
  for (const [title, about] of [['Meal Planner', 'A week of dinners.'], ['Knife Skills', 'Short lessons.'], ['Batch Cooking', 'One afternoon, five meals.']]) {
    const made = await addProduct(owner, title, about, '27', null);
    if (!made.ok) throw new Error('no product');
  }
  await setAnswers(owner, { on: true, facts: 'Every file is a PDF.' });
  return (await storeForEmail(owner))!;
}

test("the demo's ceiling is computed from the cost table and stays under the owner's cap", () => {
  assert.equal(DEMO_AI_WRITING_JOBS_MONTHLY, 0);
  assert.equal(DEMO_AI_CEILING_MICRO_USD, DEMO_AI_ANSWERS_MONTHLY * AI_ENTITLEMENT_RULES.visitorCallsPerAttempt * AI_SLOT_MICRO_USD.answer);
  assert.ok(DEMO_AI_CEILING_MICRO_USD > 0 && DEMO_AI_CEILING_MICRO_USD <= DEMO_AI_OWNER_CAP_MICRO_USD);
  assert.equal(DEMO_AI_OWNER_CAP_MICRO_USD, 3_350_000);
});

test("the demo's AI is recorded with the LLC's fixed costs, at its computed figure", () => {
  assert.equal(FIXED_COST_SOURCE_OBSERVATIONS.demoStoreAi.monthlyMicroUsd, DEMO_AI_CEILING_MICRO_USD);
  assert.equal(FIXED_COST_SOURCE_OBSERVATIONS.demoStoreAi.boundedPartApproval.monthlyMicroUsd, DEMO_AI_OWNER_CAP_MICRO_USD);
  assert.equal(FIXED_COST_SOURCE_OBSERVATIONS.demoStoreAi.approvedCeiling, false);
});

test("no fixed-cost ceiling is filled while the demo's AI is not one of the company's fixed-cost lines", () => {
  // The demo's AI is a fixed cost of the LLC (FX275), but it is only an observation today: one id more, even a short
  // one, passes the contract restart's 1 MiB encoding bound. Every line is unknown, so the company total and the
  // minimum base are unknown too, and nothing is understated. The day a line gets a reviewed figure, the minimum base
  // would come out finite without the demo's US$3.326 a month: this test fails first, so its line must be added then.
  const filled = CURRENT_LLC_FIXED_COST_CEILINGS.filter((line) => line.fullMonthlyUsdCents !== null || line.fullAnnualUsdCents !== null || line.reserveReviewed);
  if (!(LLC_FIXED_COST_IDS as readonly string[]).some((id) => id.startsWith('demo'))) assert.deepEqual(filled.map((line) => line.id), []);
});

test("the demo has its own allowance; every other store keeps its plan's", async () => {
  redis.clear();
  const demo = await storeOf(HOUSE_OWNER, 'demoaiceiling');
  const other = await storeOf('studio-owner@example.com', 'studioowner');
  assert.equal(answersAllowance(demo), DEMO_AI_ANSWERS_MONTHLY);
  assert.equal(aiAllowance(demo), DEMO_AI_WRITING_JOBS_MONTHLY);
  assert.equal(answersAllowance(other), ANSWERS_MONTHLY.pro);
  assert.equal(aiAllowance(other), AI_MONTHLY.pro);
});

test('a demo whose answers are used up shows labeled examples, asks no model, and never says closed', async () => {
  redis.clear();
  calls = 0;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-only-demo-ceiling-0123456789';
  const demo = await storeOf(HOUSE_OWNER, 'demoaiceiling');
  const products = await readListings(demo);
  const product = (await readListing(demo, products[0].id))!;
  for (let i = 0; i < DEMO_AI_ANSWERS_MONTHLY; i++) assert.equal(await takeAnswer(demo), true);
  assert.equal(await takeAnswer(demo), false);
  const answered = await answerQuestion({ store: demo, product, about: '', page: null, question: 'Is it a PDF file?' });
  assert.deepEqual(answered, { ok: true, answer: DEMO_EXAMPLE_ANSWER, known: false, example: DEMO_EXAMPLE_LABEL });
  const guided = await guideVisitor({ store: demo, products, goal: 'Something for a busy week' });
  assert.ok(guided.ok && guided.example === DEMO_EXAMPLE_LABEL && guided.picks.length > 0 && guided.picks.every((pick) => pick.why === DEMO_EXAMPLE_PICK_WHY));
  assert.equal(calls, 0);
});

test('a demo with answers left asks the model once per question and counts it', async () => {
  redis.clear();
  calls = 0;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-only-demo-ceiling-0123456789';
  const demo = await storeOf(HOUSE_OWNER, 'demoaiceiling');
  const products = await readListings(demo);
  const product = (await readListing(demo, products[0].id))!;
  const answered = await answerQuestion({ store: demo, product, about: '', page: null, question: 'Is it a PDF file?' });
  assert.ok(answered.ok && !('example' in answered && answered.example));
  assert.equal(calls, 1);
  for (let i = 1; i < DEMO_AI_ANSWERS_MONTHLY; i++) assert.equal(await takeAnswer(demo), true, `answer ${i + 1}`);
  assert.equal(await takeAnswer(demo), false);
});

test('any other store whose answers are used up is still closed, with no example', async () => {
  redis.clear();
  calls = 0;
  const other = await storeOf('studio-owner@example.com', 'studioowner');
  const products = await readListings(other);
  const product = (await readListing(other, products[0].id))!;
  for (let i = 0; i < ANSWERS_MONTHLY.pro; i++) await takeAnswer(other);
  assert.deepEqual(await answerQuestion({ store: other, product, about: '', page: null, question: 'Is it a PDF file?' }), { ok: false, reason: 'closed' });
  assert.deepEqual(await guideVisitor({ store: other, products, goal: 'Something for a busy week' }), { ok: false, reason: 'closed' });
  assert.equal(calls, 0);
});

test('example picks are never shown under "These fit best", and the example label is marked as English', () => {
  const guide = readFileSync('components/store-guide-box.tsx', 'utf8');
  assert.match(guide, /\{result\.example \? <p className="mt-2 text-sm font-bold" lang="en">Products in this demo store<\/p> : <p className="mt-2 text-sm font-bold">\{w\.picks\}<\/p>\}/);
  assert.match(guide, /lang="en">\{result\.example\}/);
  assert.match(readFileSync('components/ask-box.tsx', 'utf8'), /lang="en">\{answer\.example\}/);
  assert.doesNotMatch(DEMO_EXAMPLE_LABEL, /used up/);
});

test('the demo rules import nothing that reads the environment, since the fixed costs reach pages drawn in the browser', () => {
  const imports = [...readFileSync('lib/demo-ai-rules.ts', 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['@/lib/ai-entitlement-rules']);
  assert.doesNotMatch(readFileSync('lib/demo-ai-rules.ts', 'utf8'), /process\./);
});
