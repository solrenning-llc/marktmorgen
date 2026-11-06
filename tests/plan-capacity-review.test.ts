import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PLAN_PRICES,TIERS,monthlyEmails} from '@/lib/plan';
import {MOST_CORRECT_READING,receivingOf} from '@/lib/receiving-costs';
import {reviewedUnitUnder} from '@/lib/reviewed-receiving';
import {PAID_STORAGE_BYTES} from '@/lib/storage-rules';
import {STORE_ALLOWANCES} from '@/lib/store-allowance-rules';
import {VISITS_INCLUDED} from '@/lib/traffic-rules';
import {ORDERS_INCLUDED} from '@/lib/order-rules';
import {PAID_VIDEO_HOURS} from '@/lib/video-admission-rules';
import {txCustomerFixture} from './customer-tax-review-fixture';
import {capacityStatus,capacityRows,capacityModelLines,capacityQuantityLines,capacityInputLines,capacityTaxCeilingCents,capacityQuantities,type CapacityInputs,type CapacityKey} from './plan-capacity-review';
const doc=()=>readFileSync('docs/plan-capacity-precheck.md','utf8');
function supplied(key:CapacityKey,usage=100){
 const [tier,cycle]=key.split('_') as ['creator'|'pro'|'scale','month'|'year'];
 const price=PLAN_PRICES[tier][cycle],scope={scenario:key+'_full',from:'2026-10-01',through:cycle==='year'?'2027-10-01':'2026-11-01',months:cycle==='year'?12 as const:1 as const};
 // This review covers even the greater zero-usage pretax base; its tax books
 // are not recomputed to award a credit when full usage is added.
 const row=txCustomerFixture(price,receivingOf(price).totalCents,scope);
 return {taxInput:{taxReview:row.taxReview!,taxContext:row.taxContext!},fullUsageCeilingCents:usage};
}
test('capacity precheck: absent evidence leaves every fiscal/result/maximum unknown, never zero or tax-profile infeasible',()=>{
 const rows=capacityRows();assert.equal(rows.length,6);
 for(const row of rows){assert.equal(row.full,null);assert.equal(row.zeroUsage,null);assert.equal(row.taxCeilingCents,null);assert.equal(row.maximum,null);assert.equal(row.status,'unreviewed');}
 assert.equal(capacityTaxCeilingCents(6900,null,null),null);assert.equal(capacityTaxCeilingCents(0,0,null),null);
 assert.equal(capacityStatus(999000),'unreviewed');
 assert.throws(()=>capacityStatus(Number.NaN));assert.throws(()=>capacityStatus(0));
 const metadata={creator_month:{taxInput:MOST_CORRECT_READING,fullUsageCeilingCents:0}} as unknown as CapacityInputs;
 assert.equal(capacityRows(metadata)[0].zeroUsage,null);assert.equal(capacityRows(metadata)[0].taxCeilingCents,null);
 assert.equal(capacityTaxCeilingCents(6900,0,MOST_CORRECT_READING as never),null);
});
test('capacity precheck uses the actual reviewed adapter with the same complete scoped input and absolute tax amount',()=>{
 const evidence=supplied('creator_month'),row=capacityRows({creator_month:evidence})[0],price=PLAN_PRICES.creator.month;
 assert.deepEqual(row.full,reviewedUnitUnder(price,100,evidence.taxInput));
 assert.deepEqual(row.zeroUsage,reviewedUnitUnder(price,0,evidence.taxInput));
 assert.ok(row.full&&row.zeroUsage);assert.equal(row.full.taxCents,row.zeroUsage.taxCents);assert.equal(row.taxCeilingCents,row.full.taxCents);
 assert.equal(capacityTaxCeilingCents(price,100,evidence.taxInput),row.full.taxCents);
 assert.equal(row.full.netCents,row.zeroUsage.netCents-100);assert.equal(row.maximum,null);assert.equal(row.status,'unreviewed');
 const losing=supplied('creator_month',price*2),loss=capacityRows({creator_month:losing})[0];
 assert.equal(loss.full?.meetsFloor,false);assert.equal(loss.status,'unreviewed');assert.equal(loss.maximum,null);
});
test('wrong scenario, interval, missing calendar book, FX or full-use ceiling cannot supply capacity',()=>{
 for(const change of [
  (v:ReturnType<typeof supplied>)=>{v.taxInput.taxContext.scenario='pro_month_full';},
  (v:ReturnType<typeof supplied>)=>{v.taxInput.taxContext.months=12;},
  (v:ReturnType<typeof supplied>)=>{v.taxInput.taxReview.books=[];},
  (v:ReturnType<typeof supplied>)=>{v.taxInput.taxReview.fx.through='2026-10-15';},
 ]){const value=supplied('creator_month');change(value);const row=capacityRows({creator_month:value})[0];assert.equal(row.full,null);assert.equal(row.zeroUsage,null);assert.equal(row.taxCeilingCents,null);}
 const annual=supplied('creator_year'),rows=capacityRows({creator_year:annual});assert.ok(rows[1].full);assert.deepEqual(annual.taxInput.taxReview.books.map(b=>b.year),[2026,2027]);
 annual.taxInput.taxReview.books.pop();assert.equal(capacityRows({creator_year:annual})[1].full,null);
 const unknown={...supplied('creator_month'),fullUsageCeilingCents:null};const unknownRow=capacityRows({creator_month:unknown})[0];
 assert.equal(unknownRow.full,null);assert.ok(unknownRow.zeroUsage);assert.equal(unknownRow.maximum,null);
 let reads=0;const computed=Object.defineProperty({},'creator_month',{enumerable:true,get(){reads++;return supplied('creator_month');}});
 assert.equal(capacityRows(computed)[0].full,null);assert.equal(reads,0);
});
test('capacity precheck: annual windows cover twelve full months and preserve concurrent storage',()=>{
 assert.throws(()=>capacityQuantities('unknown' as never,'month'));assert.throws(()=>capacityQuantities('creator','unknown' as never));
 for(const tier of TIERS){
  const month=capacityQuantities(tier,'month'),year=capacityQuantities(tier,'year');
  assert.equal(month.emails,monthlyEmails(tier));assert.equal(month.buyerActions,STORE_ALLOWANCES[tier].buyer);
  assert.equal(month.visits,VISITS_INCLUDED[tier]);assert.equal(month.orders,ORDERS_INCLUDED[tier]);assert.equal(month.videoHours,PAID_VIDEO_HOURS[tier]);
  assert.equal(month.storageGiB,PAID_STORAGE_BYTES[tier]/(1024**3));assert.equal(year.windows,12);assert.equal(year.storageGiB,month.storageGiB);
  for(const key of ['emails','buyerActions','visits','orders','storageGiBMonths','videoHours'] as const)assert.equal(year[key],12*month[key]);
 }
});
test('capacity precheck: current unknown results and all unchanged entitlements match the TX document',()=>{
 const text=doc(),current=text.slice(text.indexOf('## MR — Current precheck (27 October2026)'));
 for(const line of [...capacityModelLines(),...capacityQuantityLines(),...capacityInputLines()])assert.ok(current.includes(line),'stale or missing current line: '+line);
 assert.match(current,/not a zero supplier cost/);assert.match(current,/Queue89 remains in progress/);assert.match(current,/annual BRL books/);
 assert.match(text,/Counterfactual ceiling before all non-tax costs: 16\.82%; required: 60\.00%\./,'19October history remains');
});
