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
import {SIZING_READING,unitUnder as archivedUnitUnder} from './historical-receiving-model';
import {allUnits,evaluate,floorPriceCents,renderMarginAlignment,roomKept,unitUnder,CURRENT_PROFIT_TAX_BPS,CURRENT_TAX_NOTICE} from './margin-alignment-table';
import {reviewedUnitUnder} from '@/lib/reviewed-receiving';
import {gateReading} from '@/lib/tax-gate';
import {reviewedReceivingTaxInput} from './reviewed-receiving-fixture';
import {syntheticTaxContext} from './customer-tax-review-fixture';
import {netOf} from './plan-cost-model';
import {worstMonthKept} from './worst-month-kept';

test('the dated report holds the worst month each plan keeps under the LC reading, exactly (Claude 4 LOW on #4854)',()=>{
 const doc=readFileSync('docs/margin-alignment-2026-10-18.md','utf8');
 for(const cycle of ['month','year'] as const){
  const label=cycle==='month'?'Monthly plan':'A month of a yearly plan';
  const row=['',label,...worstMonthKept(cycle).map((v)=>'US$'+v),''].join(' | ').trim();
  assert.ok(doc.includes(row),'the document lists '+row);
 }
});
test('the report uses the TX reading and matches its reproducible figures',()=>{
 const generated=renderMarginAlignment(PLANS_ON_SALE,ASSISTANT_ON_SALE);
 assert.ok(generated.startsWith(CURRENT_TAX_NOTICE));
 assert.equal(readFileSync('docs/margin-alignment-2026-10-18.md','utf8'),generated);
 // Owner, 19 November 2026: the legally correct reading only; the old 27.5% floor, the most-tax reading and ISS are gone.
 assert.doesNotMatch(generated,/Binding reading: most-tax|78\.18%|ISS ?5%|most onerous/);
});
test('the unit tax is IRPF 15% plus IOF 0.38% on the profit, with no 27.5% floor and no revenue tax',()=>{
 assert.equal(CURRENT_PROFIT_TAX_BPS,MOST_CORRECT_READING.profitTaxBps+MOST_CORRECT_READING.incomingExchangeIofBps);
 assert.equal(CURRENT_PROFIT_TAX_BPS,1_538);assert.equal(MOST_CORRECT_READING.revenueTaxBps,0);
 for(const [price,usage] of [[6900,595],[44900,2754],[99900,5791],[690000,6789]]){
  const u=unitUnder(price,usage),r=receivingOf(price);
  assert.equal(u.pretaxCents,r.revenueCents-r.totalCents-usage);
  // IRPF and IOF each rounded up on its own, as lib/receiving-costs.ts rounds them (Claude 2's LEVE on #4916).
  assert.equal(u.taxCents,Math.ceil(u.pretaxCents*1500/10000)+Math.ceil(u.pretaxCents*38/10000));
  assert.ok(u.taxCents<Math.ceil(u.pretaxCents*2750/10000),'below the old 27.5% floor');
 }
 assert.equal(unitUnder(6900,100_000).taxCents,0);assert.equal(unitUnder(6900,100_000).meetsFloor,false);
 for(const price of [3600,6900,69000]){
  const room=unitUnder(price,0).usageRoomCents;
  assert.equal(unitUnder(price,room).meetsFloor,true);assert.equal(unitUnder(price,room+1).meetsFloor,false);
  // The smallest pretax profit that keeps a net cent: 3 (1 IRPF cent and 1 IOF cent), not 2 as one 15.38% rounding gave.
  assert.equal(unitUnder(price,room).pretaxCents,3);assert.equal(unitUnder(price,room).taxCents,2);assert.equal(unitUnder(price,room).netCents,1);
 }
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
test('current thresholds hold every current price without proposing prices or rights',()=>{
 for(const unit of allUnits(PLANS_ON_SALE,ASSISTANT_ON_SALE)){
  assert.ok(evaluate(unit).netCents>0,unit.id);if(unit.id.startsWith('captions'))continue;
  const floor=floorPriceCents(unit.usageCents);assert.equal(unitUnder(floor,unit.usageCents).meetsFloor,true);
  assert.equal(unitUnder(floor-1,unit.usageCents).meetsFloor,false);
  assert.ok(unit.priceCents>=floorPriceCents(unit.usageCents,roomKept(unit)));
 }
 for(const tier of TIERS)assert.equal(PRICES_WITH_COMMISSION[tier].year,PRICES_WITH_COMMISSION[tier].month*10);
});
test('the value presentation retains owner quotations; its current rows live only in the generated table',()=>{
 const doc=readFileSync('docs/value-presentation-2026-10-18.md','utf8');
 // The current-price rows are no longer copied here (BROADCAST-282): tests/value-presentation-pointer.test.ts holds the
 // pointer, that no row is copied, and that docs/margin-alignment-2026-10-18.md has every one.
 assert.match(doc,/preço: o que maximiza o meu lucro/);assert.doesNotMatch(doc,/\bsmall\b|unlimited (visits|orders|emails|storage) on (Store|Studio|Scale)/i);
});
