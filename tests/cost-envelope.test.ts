import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PUBLISHED_PLAN_PRICES} from '../lib/plan';
import {maximumPretaxCostCents,remainingResourceCostCents} from '../lib/cost-envelope';
import {assessCustomerWorstCase} from '../lib/net-margin-rules';
import {txCustomerFixture} from './customer-tax-review-fixture';
test('each locked price reserves the complete absolute reviewed tax and one whole net cent',()=>{
 for(const revenue of Object.values(PUBLISHED_PLAN_PRICES).flatMap(prices=>Object.values(prices))){
  const row=txCustomerFixture(revenue,0),maximum=maximumPretaxCostCents(revenue,row.taxesCeilingCents)!;
  assert.equal(maximum,revenue-row.taxesCeilingCents!-1);
  row.costCeilings.other=maximum;assert.equal(assessCustomerWorstCase(row).netCents,1);
  row.costCeilings.other!++;assert.equal(assessCustomerWorstCase(row).approved,false);
 }
});
test('absolute taxes are not basis points and unknown taxes never become a zero reserve',()=>{
 assert.equal(maximumPretaxCostCents(1,null),null);
 assert.equal(maximumPretaxCostCents(1,0),0,'explicit arithmetic zero is not a fiscal approval');
 assert.equal(maximumPretaxCostCents(22000,2750),19249);
 assert.equal(maximumPretaxCostCents(22000,10000),11999);
 assert.equal(maximumPretaxCostCents(22000,22000),null);
 for(const value of [undefined,NaN,Infinity,-1,.5,Number.MAX_SAFE_INTEGER+1])assert.equal(maximumPretaxCostCents(22000,value as number),null);
 const unknown=txCustomerFixture();delete unknown.taxReview;delete unknown.taxContext;unknown.taxesCeilingCents=0;
 assert.equal(assessCustomerWorstCase(unknown).reason,'tax_review_unknown');
});
test('missing, invalid and overflowing non-resource costs never become free',()=>{
 for(const costs of [[],[null],[NaN],[-1],[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER]])assert.equal(remainingResourceCostCents(22000,2750,costs),null);
 const cap=maximumPretaxCostCents(22000,2750)!;
 assert.equal(remainingResourceCostCents(22000,2750,[cap]),0);
 assert.equal(remainingResourceCostCents(22000,2750,[cap+1]),null);
});
