import test from 'node:test';
import assert from 'node:assert/strict';
import * as Margin from '@/lib/net-margin-rules';
import {assessCustomerWorstCase} from '@/lib/net-margin-rules';
import {maximumPretaxCostCents} from '../lib/cost-envelope';
import {PUBLISHED_PLAN_PRICES} from '@/lib/plan';
import {CURRENT_COMMERCIAL_TERMS,commercialMarginReady} from '@/lib/commercial-margin';
import {txCustomerFixture,syntheticTaxEvidence} from './customer-tax-review-fixture';
test('the commercial policy requires explicit TX and no longer publishes a planning tax floor',()=>{
 assert.equal('PLANNING_PROFIT_TAX_FLOOR_BPS' in Margin,false);
 assert.equal('planningProfitTaxFloorBps' in CURRENT_COMMERCIAL_TERMS,false);
 assert.equal(CURRENT_COMMERCIAL_TERMS.customerTaxReview.requirement,'explicit-TX-evidence-required-no-legacy-profit-approval');
 assert.equal(commercialMarginReady(),false);
});
test('a reviewed flag or a large legacy tax allowance cannot replace complete scoped evidence',()=>{
 for(const reserve of [0,1000,2750,9000]){
  const row=txCustomerFixture();delete row.taxReview;delete row.taxContext;row.taxesCeilingCents=reserve;
  assert.equal(assessCustomerWorstCase(row).reason,'tax_review_unknown');
 }
});
test('annual IRPF and incoming exchange use separate explicit bases with reviewed FX',()=>{
 const row=txCustomerFixture();row.taxReview!.books[0].exchanges[0].brlCents=10000;row.taxesCeilingCents=1508;
 assert.deepEqual(assessCustomerWorstCase(row),{approved:true,reason:'approved',netCents:8492,marginBps:8492});
 row.taxesCeilingCents=1507;assert.equal(assessCustomerWorstCase(row).reason,'tax_below_reviewed_ceiling');
});
test('known additional taxes stay fully reserved and can defeat positive unit net',()=>{
 const row=txCustomerFixture();row.taxReview!.components.usStates={status:'ceiling',usdCents:700,evidence:syntheticTaxEvidence()};row.taxesCeilingCents!+=700;
 assert.equal(assessCustomerWorstCase(row).netCents,7762);
 row.taxesCeilingCents=10000;assert.equal(assessCustomerWorstCase(row).reason,'below_floor');
});
test('all six locked prices preserve one exact net cent after the complete absolute tax reserve',()=>{
 for(const prices of Object.values(PUBLISHED_PLAN_PRICES))for(const gross of Object.values(prices)){
  const row=txCustomerFixture(gross,0),maximum=maximumPretaxCostCents(gross,row.taxesCeilingCents)!;
  row.costCeilings.other=maximum;assert.equal(assessCustomerWorstCase(row).netCents,1);
  row.costCeilings.other!++;assert.equal(assessCustomerWorstCase(row).approved,false);
 }
});
test('a loss or free period does not become a paying customer approval',()=>{
 assert.equal(assessCustomerWorstCase(txCustomerFixture(10000,10001)).reason,'below_floor');
 assert.equal(assessCustomerWorstCase(txCustomerFixture(0,1)).approved,false);
});
test('the versioned commercial snapshot and all component facts remain mandatory',()=>{
 const row=txCustomerFixture();assert.equal(assessCustomerWorstCase(row).approved,true);
 row.taxReview!.components.usFederal.evidence.facts='';row.taxesCeilingCents=9000;
 assert.equal(assessCustomerWorstCase(row).reason,'tax_review_unknown');
 assert.equal(CURRENT_COMMERCIAL_TERMS.schemaVersion,29);
 assert.equal(commercialMarginReady(),false);
});
