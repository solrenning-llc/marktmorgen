import assert from 'node:assert/strict';
import test from 'node:test';
import {companyMonthlyMarginReport,companyMonthlyMarginPresentation} from '../lib/company-margin-report';
import {COMMERCIAL_PROFIT_SOURCES,type CommercialProfitMixInput,type ProfitSourceAmounts} from '../lib/commercial-margin';
const now=Date.UTC(2026,10,1);
function fixture():CommercialProfitMixInput{return {basis:'reconciled_actual',interval:'month',period:'2026-10',currency:'USD',companyFixedCostsCents:900,sources:Object.fromEntries(COMMERCIAL_PROFIT_SOURCES.map(source=>[source,{revenueCents:1000,variableCostsCents:100,allocatedFixedCostsCents:100,taxesCents:200,refundsCents:50,reservesCents:50,evidence:'SYNTHETIC ONLY'}])) as Record<typeof COMMERCIAL_PROFIT_SOURCES[number],ProfitSourceAmounts>};}
test('hidden and symbol costs at each original container remain unknown',()=>{
 for(const position of ['root','sources',...COMMERCIAL_PROFIT_SOURCES])for(const key of ['unpriced',Symbol('unpriced')]){
  const input=fixture();const target=position==='root'?input:position==='sources'?input.sources:input.sources[position as typeof COMMERCIAL_PROFIT_SOURCES[number]]!;
  Object.defineProperty(target,key,{value:null,enumerable:false});
  assert.equal(companyMonthlyMarginReport(input,now).status,'unknown');
  assert.equal(companyMonthlyMarginPresentation(input,now),null);
 }
});
test('native Proxy rejection occurs before any reflective trap',()=>{
 for(const position of ['root','sources',...COMMERCIAL_PROFIT_SOURCES]){
  const input=fixture();let traps=0;const target=position==='root'?input:position==='sources'?input.sources:input.sources[position as typeof COMMERCIAL_PROFIT_SOURCES[number]]!;
  const proxy=new Proxy(target,{get(){traps++;throw Error('get');},getPrototypeOf(){traps++;throw Error('prototype');},ownKeys(){traps++;throw Error('keys');},getOwnPropertyDescriptor(){traps++;throw Error('descriptor');}});
  let supplied=input;if(position==='root')supplied=proxy as CommercialProfitMixInput;else if(position==='sources')input.sources=proxy as CommercialProfitMixInput['sources'];else input.sources[position as typeof COMMERCIAL_PROFIT_SOURCES[number]]=proxy as ProfitSourceAmounts;
  assert.equal(companyMonthlyMarginReport(supplied,now).status,'unknown');assert.equal(traps,0);
 }
});
test('frozen own evidence remains accepted and detached before auxiliary mutation',()=>{
 const input=fixture();for(const row of Object.values(input.sources))Object.freeze(row);Object.freeze(input.sources);Object.freeze(input);
 const result=companyMonthlyMarginReport(input,now);assert.equal(result.netProfitCents,4500);assert.equal(result.taxesCents,1800);
 const mutable=fixture();const held=new Proxy({month:'2026-10',count:0,peak:0},{ownKeys(target){mutable.companyFixedCostsCents=0;mutable.sources.training=null;return Reflect.ownKeys(target);}});
 const detached=companyMonthlyMarginReport(mutable,now,held);assert.equal(detached.status,'complete');assert.equal(detached.fixedCostsCents,900);assert.equal(detached.netProfitCents,4500);
});
test('representable net with overflowing aggregate revenue cannot present partial totals',()=>{
 const input=fixture();for(const row of Object.values(input.sources)){row!.revenueCents=Number.MAX_SAFE_INTEGER;row!.variableCostsCents=Number.MAX_SAFE_INTEGER;}
 const report=companyMonthlyMarginReport(input,now);assert.equal(report.status,'unknown');assert.equal(report.revenueCents,null);assert.equal(report.netProfitCents,null);assert.equal(companyMonthlyMarginPresentation(input,now),null);
});
