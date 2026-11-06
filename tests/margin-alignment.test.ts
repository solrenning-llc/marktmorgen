import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PRICES_WITH_COMMISSION,TIERS} from '@/lib/plan';
import {ASSISTANT_ON_SALE,PLANS_ON_SALE} from '@/lib/opening';
import {commercialMarginReady} from '@/lib/commercial-margin';
import {maximumPretaxCostCents} from '@/lib/cost-envelope';
import {ASSISTANT_PRICE_CENTS,addOnFeeCents,assistantMeetsFloor,assistantMonthWorst} from '@/lib/store-assistant-rules';
import * as Receiving from '@/lib/receiving-costs';
import {MOST_CORRECT_READING,providerFeeCents,receivingOf} from '@/lib/receiving-costs';
import {MOST_TAX_READING,SIZING_READING,unitUnder as archivedUnitUnder} from './historical-receiving-model';
import {allUnits,evaluate,floorPriceCents,renderMarginAlignment,roomKept,currentPriceMarginRows,HISTORICAL_TAX_NOTICE} from './margin-alignment-table';
import {reviewedUnitUnder} from '@/lib/reviewed-receiving';
import {gateReading} from '@/lib/tax-gate';
import {reviewedReceivingTaxInput} from './reviewed-receiving-fixture';
import {syntheticTaxContext} from './customer-tax-review-fixture';
import {netOf} from './plan-cost-model';

test('the dated report remains explicitly historical and matches its reproducible figures',()=>{
 const generated=renderMarginAlignment(PLANS_ON_SALE,ASSISTANT_ON_SALE);
 assert.ok(generated.startsWith(HISTORICAL_TAX_NOTICE));
 assert.equal(readFileSync('docs/margin-alignment-2026-10-18.md','utf8'),generated);
});
test('the unchanged dearest receiving fee and every reserve use the whole amount charged',()=>{
 const r=receivingOf(2200);assert.deepEqual([r.revenueCents,r.chargedCents,r.feeCents,r.remittanceCents,r.refundReserveCents,r.disputeReserveCents],[2200,2794,216,33,22,58]);
 assert.equal(providerFeeCents(10000,false),660);
 assert.equal(addOnFeeCents(),providerFeeCents(receivingOf(ASSISTANT_PRICE_CENTS).chargedCents));
 const month=assistantMonthWorst();assert.equal(month.totalCents,receivingOf(ASSISTANT_PRICE_CENTS).totalCents+month.aiCents);
 for(const tier of TIERS)for(const cycle of ['month','year'] as const){
  const received=receivingOf(PRICES_WITH_COMMISSION[tier][cycle]);
  assert.ok(Math.abs(netOf(tier,cycle,PRICES_WITH_COMMISSION)*100*(cycle==='year'?12:1)-(received.revenueCents-received.totalCents))<1e-6);
 }
});
test('current TX cost budgets reserve the absolute evidence-bound tax and the final net cent',()=>{
 for(const price of [2200,2900,4900,14900,149000,349000]){
  const input=reviewedReceivingTaxInput(price,0,syntheticTaxContext());
  const result=reviewedUnitUnder(price,0,input)!;assert.ok(result);
  const budget=maximumPretaxCostCents(result.revenueCents,result.taxCents)!;
  assert.equal(result.usageRoomCents+result.totalCents,budget);
  assert.equal(reviewedUnitUnder(price,result.usageRoomCents,input)!.netCents,1);
  assert.equal(reviewedUnitUnder(price,result.usageRoomCents+1,input)!.meetsFloor,false);
 }
});
test('old tax math is available only in the explicitly archived model, never a live fallback',()=>{
 assert.equal('unitUnder' in Receiving,false);assert.equal('STRESS_PROFIT_TAX_BPS' in Receiving,false);
 assert.equal(gateReading(),MOST_CORRECT_READING);
 assert.equal(reviewedUnitUnder(14900,0,null),null);
 assert.equal(archivedUnitUnder(14900,0,{...SIZING_READING,profitTaxBps:1000}).taxCents,archivedUnitUnder(14900,0,SIZING_READING).taxCents);
});
test('every full-use unit keeps its existing cost room under complete synthetic TX evidence',()=>{
 for(const unit of allUnits(PLANS_ON_SALE,ASSISTANT_ON_SALE)){
  const usage=unit.usageCents+roomKept(unit),scope=syntheticTaxContext(unit.id.replaceAll('-','_'),unit.id.includes('-year-')?12:1);
  const result=reviewedUnitUnder(unit.priceCents,usage,reviewedReceivingTaxInput(unit.priceCents,usage,scope,unit.ownTransaction),unit.ownTransaction);
  assert.ok(result!==null&&result.netCents>0&&result.meetsFloor,unit.id);
 }
});
test('unknown real review cannot be replaced by a positive model or a zero tax allowance',()=>{
 assert.equal(PLANS_ON_SALE,false);assert.equal(ASSISTANT_ON_SALE,false);assert.equal(commercialMarginReady(),false);
 const month=assistantMonthWorst();assert.equal(month.review.taxesCeilingCents,null);assert.equal(month.allowedCents,null);assert.equal(month.roomCents,null);assert.equal(assistantMeetsFloor(),false);
});
test('archived thresholds preserve historical figures without proposing current prices or rights',()=>{
 for(const unit of allUnits(PLANS_ON_SALE,ASSISTANT_ON_SALE)){
  assert.ok(evaluate(unit).netCents>0,unit.id);if(unit.id.startsWith('captions'))continue;
  const floor=floorPriceCents(unit.usageCents);assert.equal(archivedUnitUnder(floor,unit.usageCents,MOST_TAX_READING).meetsFloor,true);
  assert.equal(archivedUnitUnder(floor-1,unit.usageCents,MOST_TAX_READING).meetsFloor,false);
  assert.ok(unit.priceCents>=floorPriceCents(unit.usageCents,roomKept(unit)));
 }
 for(const tier of TIERS)assert.equal(PRICES_WITH_COMMISSION[tier].year,PRICES_WITH_COMMISSION[tier].month*10);
});
test('the value presentation retains owner quotations and its dated tax-model rows',()=>{
 const doc=readFileSync('docs/value-presentation-2026-10-18.md','utf8');
 for(const row of currentPriceMarginRows(PLANS_ON_SALE,ASSISTANT_ON_SALE))assert.ok(doc.includes(row));
 assert.match(doc,/preço: o que maximiza o meu lucro/);assert.doesNotMatch(doc,/\bsmall\b|unlimited (visits|orders|emails|storage) on (Store|Studio|Scale)/i);
});
