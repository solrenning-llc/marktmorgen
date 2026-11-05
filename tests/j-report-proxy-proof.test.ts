import assert from 'node:assert/strict';
import {test} from 'node:test';
import {companyMonthlyMarginReport} from '../lib/company-margin-report';
import {commercialProfitMix,COMMERCIAL_PROFIT_SOURCES,type CommercialProfitMixInput,type ProfitSourceAmounts} from '../lib/commercial-margin';
const fixture=():CommercialProfitMixInput=>({basis:'reconciled_actual',interval:'month',period:'2026-10',currency:'USD',companyFixedCostsCents:900,sources:Object.fromEntries(COMMERCIAL_PROFIT_SOURCES.map(s=>[s,{revenueCents:1000,variableCostsCents:100,allocatedFixedCostsCents:100,taxesCents:200,refundsCents:50,reservesCents:50,evidence:'SYNTHETIC ONLY; no actual cost approval'}])) as Record<typeof COMMERCIAL_PROFIT_SOURCES[number],ProfitSourceAmounts>});
test('monthly report preserves refusal of a supplier cost hidden by a Proxy',()=>{
 const input=fixture();
 input.sources.training=new Proxy(Object.assign(input.sources.training!,{unreviewedSupplierCents:null}),{ownKeys(target){return Reflect.ownKeys(target).filter(k=>k!=='unreviewedSupplierCents');}});
 assert.equal(commercialProfitMix(input).reason,'unknown','direct boundary refuses the unpriced cost');
 const report=companyMonthlyMarginReport(input,Date.UTC(2026,10,1));
 console.log('WRAPPED_ACCOUNTING',JSON.stringify(report));
 assert.equal(report.status,'unknown','wrapper cannot erase the unpriced cost before the checked boundary');
});
