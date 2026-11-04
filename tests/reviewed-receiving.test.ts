import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedUnitUnder } from '../lib/reviewed-receiving';
import { MOST_CORRECT_READING, READINGS, receivingOf, mostCorrectTaxesOf } from '../lib/receiving-costs';
import { txCustomerFixture, syntheticTaxEvidence } from './customer-tax-review-fixture';
import type { CustomerTaxInput } from '../lib/customer-tax-review';

function fixture(price = 10_000, usage = 100): CustomerTaxInput {
  const received = receivingOf(price);
  const row = txCustomerFixture(price, received.totalCents + usage);
  return { taxReview: row.taxReview!, taxContext: row.taxContext! };
}

test('reviewed receiving includes the unchanged dearest provider, whole reserves and explicit full usage', () => {
  const input = fixture(), result = reviewedUnitUnder(10_000, 100, input);
  assert.ok(result);
  const receiving = receivingOf(10_000, MOST_CORRECT_READING, true);
  for (const [field, value] of Object.entries(receiving)) assert.equal(result[field as keyof typeof receiving], value);
  assert.equal(result.costCents, receiving.totalCents + 100);
  assert.equal(result.netCents, result.revenueCents - result.costCents - result.taxCents);
  assert.equal(result.usageRoomCents, result.revenueCents - result.taxCents - 1 - receiving.totalCents);
  assert.equal(result.meetsFloor, true);
  const renewal = reviewedUnitUnder(10_000, 100, input, false);
  assert.ok(renewal === null, 'a lower-cost payment needs a review covering its larger pretax base');
  const renewalCost = receivingOf(10_000, MOST_CORRECT_READING, false).totalCents;
  const row = txCustomerFixture(10_000, renewalCost + 100);
  const renewed = reviewedUnitUnder(10_000, 100, { taxReview: row.taxReview!, taxContext: row.taxContext! }, false);
  assert.ok(renewed);
  assert.equal(renewed.totalCents, renewalCost);
  assert.deepEqual(READINGS, [MOST_CORRECT_READING]);
});

test('the same absolute reviewed tax remains reserved when usage increases; every added tax cent reduces the room', () => {
  const input = fixture(), first = reviewedUnitUnder(10_000, 100, input)!;
  const moreUsage = reviewedUnitUnder(10_000, 125, input)!;
  assert.equal(moreUsage.taxCents, first.taxCents);
  assert.equal(moreUsage.netCents, first.netCents - 25);
  assert.equal(moreUsage.usageRoomCents, first.usageRoomCents);
  input.taxReview!.components.usFederal = { status: 'ceiling', usdCents: 317, evidence: syntheticTaxEvidence() };
  const moreTax = reviewedUnitUnder(10_000, 100, input)!;
  assert.equal(moreTax.taxCents, first.taxCents + 317);
  assert.equal(moreTax.netCents, first.netCents - 317);
  assert.equal(moreTax.usageRoomCents, first.usageRoomCents - 317);
  const edge = reviewedUnitUnder(10_000, moreTax.usageRoomCents, input)!;
  assert.equal(edge.netCents, 1); assert.equal(edge.meetsFloor, true);
  const beyond = reviewedUnitUnder(10_000, moreTax.usageRoomCents + 1, input)!;
  assert.equal(beyond.netCents, 0); assert.equal(beyond.meetsFloor, false);
});

test('unknown costs, review, operations, FX and mismatched amounts never become zero or a fixed rate', () => {
  for (const [price, usage] of [[NaN, 1], [10_000, NaN], [Infinity, 1], [10_000, -1], [10_000, 0.1], [Number.MAX_SAFE_INTEGER, 1], [1, Number.MAX_SAFE_INTEGER]]) {
    assert.equal(reviewedUnitUnder(price, usage, fixture()), null);
  }
  assert.equal(reviewedUnitUnder(10_000, undefined as unknown as number, fixture()), null);
  assert.equal(reviewedUnitUnder(10_000, 100, null), null);
  for (const change of [
    (input: CustomerTaxInput) => { input.taxReview = null; },
    (input: CustomerTaxInput) => { input.taxContext = null; },
    (input: CustomerTaxInput) => { input.taxReview!.books[0].exchanges = new Array(1); },
    (input: CustomerTaxInput) => { input.taxReview!.fx.brlToUsd.denominator = 0; },
    (input: CustomerTaxInput) => { input.taxReview!.fx.through = '2026-10-15'; },
    (input: CustomerTaxInput) => { input.taxReview!.revenueCents++; },
    (input: CustomerTaxInput) => { input.taxReview!.books = []; },
    (input: CustomerTaxInput) => { input.taxReview!.books[0].exchangeCoverage.facts = ''; },
  ]) { const input = fixture(); change(input); assert.equal(reviewedUnitUnder(10_000, 100, input), null); }
  assert.equal(reviewedUnitUnder(10_001, 100, fixture()), null);
});

test('hidden, inherited, executable and extra evidence is refused without executing a getter', () => {
  let reads = 0;
  const source = fixture();
  const inherited = Object.create(source);
  assert.equal(reviewedUnitUnder(10_000, 100, inherited), null);
  const getter = Object.defineProperty({ ...source }, 'taxReview', { get() { reads++; return source.taxReview; } });
  assert.equal(reviewedUnitUnder(10_000, 100, getter), null);
  const hidden = Object.defineProperty({ ...source }, 'taxContext', { value: source.taxContext, enumerable: false });
  assert.equal(reviewedUnitUnder(10_000, 100, hidden), null);
  assert.equal(reviewedUnitUnder(10_000, 100, { ...source, extra: 0 } as CustomerTaxInput), null);
  assert.equal(reads, 0);
});

test('unpaid units have no invented profit percentage while the primitive retains IOF without current profit', () => {
  const row = txCustomerFixture(0, 0), input = { taxReview: row.taxReview!, taxContext: row.taxContext! };
  input.taxReview.books[0].exchanges[0].brlCents = 1_000_000;
  const result = reviewedUnitUnder(0, 0, input);
  assert.equal(result,null,'paid unit adapter refuses revenue zero rather than inventing netBps0');
  assert.equal(mostCorrectTaxesOf({ currency: 'BRL', annualProfitCents: 0, incomingExchangeCents: [1_000_000] })?.iofCents, 3800);
  const noEntry = structuredClone(input); noEntry.taxReview.books[0].exchanges = [];
  assert.equal(reviewedUnitUnder(0,0,noEntry),null);
  assert.equal(mostCorrectTaxesOf({currency:'BRL',annualProfitCents:0,incomingExchangeCents:[]})?.totalTaxCents,0,'explicit complete empty operations differ from unknown');
});

test('BRL primitive retains annual profit, operation rounding and bounded unknown refusal', () => {
  assert.equal(mostCorrectTaxesOf({ currency: 'BRL', annualProfitCents: 1_000_000, incomingExchangeCents: [] })?.totalTaxCents, 150_000);
  assert.equal(mostCorrectTaxesOf({ currency: 'BRL', annualProfitCents: 1, incomingExchangeCents: [1, 1] })?.totalTaxCents, 3);
  for (const entries of [null, new Array(1), [null], [Number.MAX_SAFE_INTEGER, 1]]) {
    assert.equal(mostCorrectTaxesOf({ currency: 'BRL', annualProfitCents: 1, incomingExchangeCents: entries }), null);
  }
});
