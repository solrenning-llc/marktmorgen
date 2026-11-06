import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_TAX_REVIEW_POLICY, OTHER_CUSTOMER_TAX_COMPONENTS, customerTaxCeiling, customerTaxScenarioMatches, captureCustomerTaxInput } from '../lib/customer-tax-review';
import { assessCustomerWorstCase, type CustomerWorstCase } from '../lib/net-margin-rules';
import { assessMinimumCustomerBase } from '../lib/customer-base-rules';
import { txCustomerFixture, syntheticTaxEvidence } from './customer-tax-review-fixture';
const evaluate = (r: CustomerWorstCase) => assessCustomerWorstCase(r);
test('a complete scoped TX review reaches the real assessor below the historical 27.5% floor', () => {
  const r = txCustomerFixture();
  assert.equal(r.taxesCeilingCents, 1538);
  assert.deepEqual(evaluate(r), { approved: true, reason: 'approved', netCents: 8462, marginBps: 8462 });
  r.taxesCeilingCents!--;
  assert.equal(evaluate(r).reason, 'tax_below_reviewed_ceiling');
  assert.equal(CUSTOMER_TAX_REVIEW_POLICY.allocation, 'whole-scoped-calendar-books-no-tax-credit-for-extra-cost-room');
});
test('monthly and twelve-month periods bind the scenario and every calendar book', () => {
  for (const scope of [
    { scenario: 'creator_month_full', from: '2026-12-01', through: '2027-01-01', months: 1 as const },
    { scenario: 'creator_year_full', from: '2026-10-01', through: '2027-10-01', months: 12 as const },
  ]) {
    const r = txCustomerFixture(10000, 0, scope);
    assert.equal(evaluate(r).approved, true);
    assert.equal(customerTaxScenarioMatches(r, scope.scenario), true);
    assert.equal(customerTaxScenarioMatches(r, 'scale_year_full'), false);
    r.taxReview!.books.pop();
    assert.equal(evaluate(r).reason, 'tax_review_unknown');
  }
});
test('monthly anniversaries refuse overflow rather than calling January 31 to March 3 one month',()=>{
 const r=txCustomerFixture();
 r.taxContext!.from=r.taxReview!.scope.from='2026-01-31';
 r.taxContext!.through=r.taxReview!.scope.through='2026-03-03';
 assert.equal(evaluate(r).reason,'tax_review_unknown');
});
test('missing scope, period, accounting, FX, source and applicable facts never authorize a lower tax', () => {
  const mutations: ((r: CustomerWorstCase) => void)[] = [
    r => { r.taxReview = null; }, r => { r.taxContext = null; },
    r => { Object.assign(r.taxReview!,{currency:'EUR'}); },
    r => { Reflect.deleteProperty(r.taxReview!,'accountingCurrency'); },
    r => { r.taxContext!.from = '2026-02-31'; }, r => { r.taxContext!.through = '2026-12-01'; },
    r => { r.taxReview!.scope.scenario = 'another-unit'; },
    r => { r.taxReview!.revenueCents++; }, r => { r.taxReview!.refundableCents++; },
    r => { r.taxReview!.pretaxCeilingCents--; },
    r => { r.taxReview!.fx.from = '2026-10-02'; }, r => { r.taxReview!.fx.through = '2026-10-31'; },
    r => { r.taxReview!.fx.brlToUsd.numerator = 0; }, r => { r.taxReview!.fx.usdToBrl.numerator = 4; },
    r => { r.taxReview!.books[0].year--; }, r => { r.taxReview!.books[0].annualProfitCents--; },
    r => { r.taxReview!.books[0].exchanges[0].at = '2026-11-01'; },
    r => { r.taxReview!.books[0].exchanges[0].evidence.facts = ''; },
    r => { r.taxReview!.irpf.source = ''; }, r => { r.taxReview!.iof.date = '2026-02-31'; },
    r => { r.taxReview!.coverage.facts = ''; },
  ];
  for (const mutate of mutations) {
    const r = txCustomerFixture(); mutate(r); r.taxesCeilingCents = 9000;
    assert.equal(evaluate(r).reason, 'tax_review_unknown');
  }
  for (const key of OTHER_CUSTOMER_TAX_COMPONENTS) {
    const r = txCustomerFixture(); Reflect.deleteProperty(r.taxReview!.components,key);
    assert.equal(evaluate(r).reason, 'tax_review_unknown');
    const missingFacts = txCustomerFixture(); missingFacts.taxReview!.components[key].evidence.facts = '';
    assert.equal(evaluate(missingFacts).reason, 'tax_review_unknown');
  }
});
test('known other taxes are added in full and cannot be replaced with unsubstantiated zero', () => {
  const r = txCustomerFixture();
  r.taxReview!.components.usStates = { status: 'ceiling', usdCents: 700, evidence: syntheticTaxEvidence() };
  assert.equal(evaluate(r).reason, 'tax_below_reviewed_ceiling');
  r.taxesCeilingCents! += 700; assert.equal(evaluate(r).approved, true);
  r.taxReview!.components.usStates.usdCents = 0;
  assert.equal(evaluate(r).reason, 'tax_review_unknown');
});
test('each exchange retains its own rounded IOF and unknown incoming coverage is refused', () => {
  const r = txCustomerFixture(10000, 0);
  r.taxReview!.books[0].exchanges = [1, 1].map(brlCents => ({ at: '2026-10-01', brlCents, evidence: syntheticTaxEvidence() }));
  assert.equal(customerTaxCeiling(r.taxReview, r.taxContext, { revenueCents: 10000, refundableCents: 0, pretaxCents: BigInt(10000) }), 1501);
  Object.assign(r.taxReview!.books[0], { exchanges: null });
  assert.equal(evaluate(r).reason, 'tax_review_unknown');
  const empty=txCustomerFixture();empty.taxReview!.books[0].exchanges=[];
  assert.equal(evaluate(empty).approved,true);
  empty.taxReview!.books[0].exchangeCoverage.facts='';
  assert.equal(evaluate(empty).reason,'tax_review_unknown');
});
test('explicit invalid, inherited and computed TX evidence cannot silently become legacy', () => {
  let getters = 0;
  for (const value of [undefined, null, {}, false]) {
    const r = txCustomerFixture(); Object.assign(r, { taxReview: value }); r.taxesCeilingCents = 9000;
    assert.equal(evaluate(r).reason, 'tax_review_unknown');
  }
  const inherited = txCustomerFixture(), held = inherited.taxReview;
  delete inherited.taxReview; Object.setPrototypeOf(inherited, { taxReview: held });
  assert.equal(evaluate(inherited).reason, 'tax_review_unknown');
  for (const key of ['taxReview', 'taxContext']) {
    const r = txCustomerFixture(); Object.defineProperty(r, key, { get() { getters++; return {}; } });
    assert.equal(evaluate(r).reason, 'tax_review_unknown');
  }
  const r = txCustomerFixture(); Object.defineProperty(r.taxReview!.iof, 'facts', { get() { getters++; return 'unsafe'; } });
  assert.equal(evaluate(r).reason, 'tax_review_unknown'); assert.equal(getters, 0);
  const hidden=txCustomerFixture();hidden.taxReview=null;hidden.taxesCeilingCents=9000;
  const proxy=new Proxy(hidden,{has(){return false;}});
  assert.equal(evaluate(proxy).reason,'tax_review_unknown');
  assert.equal(customerTaxScenarioMatches(proxy,'creator_month_full'),true);
});
test('oversize, sparse and executable review books are refused without walking an unbounded array', () => {
  let walks = 0;
  const r = txCustomerFixture();
  r.taxReview!.books[0].exchanges = new Proxy(new Array(4294967295), { ownKeys() { walks++; throw Error('not bounded'); } }) as never;
  assert.equal(evaluate(r).reason, 'tax_review_unknown'); assert.equal(walks, 0);
  const sparse = txCustomerFixture(); sparse.taxReview!.books[0].exchanges = new Array(1);
  assert.equal(evaluate(sparse).reason, 'tax_review_unknown');
  const hook = txCustomerFixture(); Object.assign(hook.taxReview!, { toJSON() { walks++; return {}; } });
  assert.equal(evaluate(hook).reason, 'tax_review_unknown'); assert.equal(walks, 0);
  let descriptors=0;
  const wide=txCustomerFixture();wide.taxReview=new Proxy(Object.fromEntries(Array.from({length:33},(_,i)=>['k'+i,i])),{
    getOwnPropertyDescriptor(){descriptors++;throw Error('oversize object must refuse before descriptors');},
  }) as never;
  assert.equal(evaluate(wide).reason,'tax_review_unknown');assert.equal(descriptors,0);
});
test('the minimum company base uses the actual assessed net; positive net and fixed costs are still required', () => {
  const r = txCustomerFixture();
  const fixed = { monthlyFixedCostsCeilingCents: 8463, monthlyFixedTaxesCeilingCents: 0,
    allFixedCostsBounded: true, allFixedTaxesReviewed: true, fixedCostsEvidence: 'TEST ONLY', fixedTaxEvidence: 'TEST ONLY', reviewedPayingCustomers: 2 };
  assert.equal(assessMinimumCustomerBase([{ months: 1, scenario: r }], fixed).minimumCustomers, 2);
  const invalid = txCustomerFixture(); invalid.taxReview!.coverage.source = '';
  assert.equal(assessMinimumCustomerBase([{ months: 1, scenario: invalid }], fixed).minimumCustomers, null);
  r.costCeilings.other = 8462; assert.equal(evaluate(r).reason, 'below_floor');
  r.costCeilings.other++; assert.equal(evaluate(r).approved, false);
});

test('oversize fiscal strings still refuse with exact commercial snapshot binding supported',()=>{
 const r=txCustomerFixture();r.taxReview!.coverage.facts='x'.repeat(32769);
 assert.equal(evaluate(r).reason,'tax_review_unknown');
});

test('the shared TX input capture detaches exactly the two own evidence fields without executing hooks',()=>{
 const source=txCustomerFixture(),pair={taxReview:source.taxReview!,taxContext:source.taxContext!};
 const captured=captureCustomerTaxInput(pair);assert.ok(captured);assert.notEqual(captured.taxReview,pair.taxReview);
 const original=customerTaxCeiling(captured.taxReview,captured.taxContext,{revenueCents:10000,refundableCents:0,pretaxCents:BigInt(10000)});
 assert.equal(original,1538);pair.taxReview.iof.facts='';
 assert.equal(customerTaxCeiling(captured.taxReview,captured.taxContext,{revenueCents:10000,refundableCents:0,pretaxCents:BigInt(10000)}),original);
 let reads=0;const hostile={taxContext:source.taxContext};Object.defineProperty(hostile,'taxReview',{enumerable:true,get(){reads++;throw Error('must not execute');}});
 for(const value of [null,{},Object.create(pair),{...pair,extra:true},{taxReview:null,taxContext:null},hostile])assert.equal(captureCustomerTaxInput(value),null);
 assert.equal(reads,0);
});
