import {test} from 'node:test';
import assert from 'node:assert/strict';
import {commercialProfitMix, COMMERCIAL_PROFIT_SOURCES, CURRENT_COMMERCIAL_PROFIT_MIX_INPUT, CURRENT_COMMERCIAL_MARGIN_REVIEW, commercialPlansMayOpen, type CommercialProfitMixInput, type ProfitSourceAmounts} from '../lib/commercial-margin';
function fixture():CommercialProfitMixInput {
 return {basis:'worst_case',interval:'month',period:'2026-10',currency:'USD',companyFixedCostsCents:900,
  sources:Object.fromEntries(COMMERCIAL_PROFIT_SOURCES.map(source=>[source,{revenueCents:1000,variableCostsCents:100,allocatedFixedCostsCents:100,taxesCents:200,refundsCents:50,reservesCents:50,evidence:'synthetic reviewed all costs and most onerous taxes; equal fixed allocation'}])) as Record<typeof COMMERCIAL_PROFIT_SOURCES[number],ProfitSourceAmounts>};
}
test('profit mix deducts every category and allocates the whole LLC cost',()=>{
 const result=commercialProfitMix(fixture());
 assert.equal(result.reason,'known');assert.equal(result.totalNetProfitCents,4500);
 assert.equal(result.rows.length,9);
 for(const row of result.rows){assert.equal(row.netProfitCents,500);assert.equal(row.shareOfNetProfitBps,1111);}
});
test('every missing amount is unknown, never zero; missing source and evidence also fail',()=>{
 for(const key of ['revenueCents','variableCostsCents','allocatedFixedCostsCents','taxesCents','refundsCents','reservesCents'] as const){
  const input=fixture();input.sources.captions![key]=null;
  const result=commercialProfitMix(input);assert.equal(result.reason,'unknown');assert.equal(result.totalNetProfitCents,null);
  assert.equal(result.rows.find(row=>row.source==='captions')!.netProfitCents,null);
  assert.ok(result.rows.every(row=>row.shareOfNetProfitBps===null));
 }
 const input=fixture();input.sources.captions=null;assert.equal(commercialProfitMix(input).reason,'unknown');
 input.sources=Object.create(fixture().sources);assert.equal(commercialProfitMix(input).reason,'unknown');
 const empty=fixture();empty.sources.captions!.evidence=' ';assert.equal(commercialProfitMix(empty).reason,'unknown');
});
test('fixed costs cannot disappear, be counted twice, or use another period total',()=>{
 for(const fixed of [0,899,901,10800]){const input=fixture();input.companyFixedCostsCents=fixed;const result=commercialProfitMix(input);
  assert.equal(result.reason,'fixed_cost_allocation_mismatch');assert.equal(result.totalNetProfitCents,null);
  assert.ok(result.rows.every(row=>row.shareOfNetProfitBps===null));}
});
test('losses remain visible, with no invented percentage for a nonpositive total',()=>{
 const input=fixture();for(const source of COMMERCIAL_PROFIT_SOURCES)input.sources[source]!.revenueCents=0;
 const result=commercialProfitMix(input);assert.equal(result.totalNetProfitCents,-4500);assert.equal(result.reason,'nonpositive_total');
 assert.ok(result.rows.every(row=>row.netProfitCents===-500&&row.shareOfNetProfitBps===null));
 for(const source of COMMERCIAL_PROFIT_SOURCES)input.sources[source]!.revenueCents=500;
 assert.equal(commercialProfitMix(input).totalNetProfitCents,0);assert.equal(commercialProfitMix(input).reason,'nonpositive_total');
});
test('known losses can have negative shares while a positive total remains',()=>{
 const input=fixture();input.sources.captions!.revenueCents=0;
 const result=commercialProfitMix(input);assert.equal(result.totalNetProfitCents,3500);
 assert.equal(result.rows.find(row=>row.source==='captions')!.shareOfNetProfitBps,-1428);
});
test('arithmetic overflow and unsafe amounts fail closed',()=>{
 const input=fixture();for(const source of COMMERCIAL_PROFIT_SOURCES)input.sources[source]!.revenueCents=Number.MAX_SAFE_INTEGER;
 assert.equal(commercialProfitMix(input).totalNetProfitCents,null);
 for(const amount of [-1,.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity]){
  const value=fixture();value.sources.captions!.taxesCents=amount;assert.equal(commercialProfitMix(value).reason,'unknown');
 }
});
test('report data cannot execute getters, and never grants commercial approval',()=>{
 let called=0;const input=fixture();Object.defineProperty(input.sources.captions,'revenueCents',{get(){called++;return 1000;}});
 assert.equal(commercialProfitMix(input).reason,'unknown');assert.equal(called,0);
 assert.equal(CURRENT_COMMERCIAL_PROFIT_MIX_INPUT,null);assert.equal(CURRENT_COMMERCIAL_MARGIN_REVIEW,null);
 assert.equal(commercialPlansMayOpen(true),false);assert.equal(commercialProfitMix(null).reason,'unknown');
 const actual=fixture();actual.basis='reconciled_actual';actual.interval='year';actual.period='2026';
 assert.equal(commercialProfitMix(actual).basis,'reconciled_actual');assert.equal(commercialProfitMix(actual).interval,'year');
 assert.equal(commercialPlansMayOpen(true),false);
});

test('an additional source-row category cannot disappear from known company profit',()=>{
 for(const source of COMMERCIAL_PROFIT_SOURCES){
  for(const cost of [null,0,100_000]){
   const input=fixture();
   Object.assign(input.sources[source]!,{unreviewedSupplierCents:cost});
   const result=commercialProfitMix(input);
   assert.equal(result.reason,'unknown',`${source}: extra cost ${cost} requires reconciliation`);
   assert.equal(result.totalNetProfitCents,null);
   assert.equal(result.rows.find(row=>row.source===source)!.netProfitCents,null);
   assert.ok(result.rows.every(row=>row.shareOfNetProfitBps===null));
  }
 }
});

test('source-row shape is exact even when the additional field looks harmless',()=>{
 for(const extra of ['supplierInvoiceCents','notes','__proto__','constructor','toString']){
  const input=fixture();
  Object.defineProperty(input.sources.captions!,extra,{value:0,enumerable:true,configurable:true});
  const result=commercialProfitMix(input);
  assert.equal(result.reason,'unknown',extra);
  assert.equal(result.totalNetProfitCents,null);
  assert.equal(result.rows.find(row=>row.source==='captions')!.netProfitCents,null);
 }
});

test('explicit evidenced zero and null-prototype source rows retain their exact totals',()=>{
 const input=fixture();
 for(const source of COMMERCIAL_PROFIT_SOURCES){
  input.sources[source]=Object.assign(Object.create(null),input.sources[source]);
  input.sources[source]!.variableCostsCents=0;
 }
 const result=commercialProfitMix(input);
 assert.equal(result.reason,'known');assert.equal(result.totalNetProfitCents,5400);
 for(const row of result.rows){assert.equal(row.netProfitCents,600);assert.equal(row.shareOfNetProfitBps,1111);}
});

test('a Proxy cannot hide an additional source cost before the accounting snapshot',()=>{
 for(const location of ['root','sources','row'] as const){
  const input=fixture();
  const row=Object.assign(input.sources.captions!,{unreviewedSupplierCents:null});
  input.sources.captions=new Proxy(row,{
   ownKeys(target){return Reflect.ownKeys(target).filter(key=>key!=='unreviewedSupplierCents');},
  });
  const wrapped=location==='root'?new Proxy(input,{}):input;
  if(location==='sources')input.sources=new Proxy(input.sources,{});
  const result=commercialProfitMix(wrapped);
  assert.equal(result.reason,'unknown',location);
  assert.equal(result.totalNetProfitCents,null);
 }
});

test('transparent proxies at each accounting boundary are not financial evidence',()=>{
 for(const location of ['root','sources','row'] as const){
  const input=fixture();
  if(location==='sources')input.sources=new Proxy(input.sources,{});
  if(location==='row')input.sources.captions=new Proxy(input.sources.captions!,{});
  const result=commercialProfitMix(location==='root'?new Proxy(input,{}):input);
  assert.equal(result.reason,'unknown',location);
  assert.equal(result.totalNetProfitCents,null);
 }
});

test('a cost-hiding Proxy cannot remove itself from the input before the native check',()=>{
 const input=fixture();
 const row=Object.assign(input.sources.captions!,{unreviewedSupplierCents:null});
 input.sources.captions=new Proxy(row,{
  ownKeys(target){
   input.sources.captions={...target};
   return Reflect.ownKeys(target).filter(key=>key!=='unreviewedSupplierCents');
  },
 });
 const result=commercialProfitMix(input);
 assert.equal(result.reason,'unknown');assert.equal(result.totalNetProfitCents,null);
});

test('a source-map Proxy cannot detach while concealing another unreconciled source',()=>{
 const input=fixture();
 const sources=Object.assign(input.sources,{unreviewedSupplier:null});
 input.sources=new Proxy(sources,{
  ownKeys(target){
   input.sources={...target};
   return Reflect.ownKeys(target).filter(key=>key!=='unreviewedSupplier');
  },
 });
 const result=commercialProfitMix(input);
 assert.equal(result.reason,'unknown');assert.equal(result.totalNetProfitCents,null);
});

test('an inherited amount cannot replace a required own cost category',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(Object.prototype,'taxesCents');
 let calls=0;
 try{
  Object.defineProperty(Object.prototype,'taxesCents',{get(){calls++;return 200;},configurable:true});
  const input=fixture();
  const row=input.sources.captions! as unknown as Record<string,unknown>;
  delete row.taxesCents;
  Object.assign(row,{unreviewedSupplierCents:null});
  const result=commercialProfitMix(input);
  assert.equal(result.reason,'unknown');assert.equal(result.totalNetProfitCents,null);
  assert.equal(result.rows.find(item=>item.source==='captions')!.netProfitCents,null);
  assert.equal(calls,0);
 }finally{
  if(descriptor)Object.defineProperty(Object.prototype,'taxesCents',descriptor);
  else Reflect.deleteProperty(Object.prototype,'taxesCents');
 }
});

test('hidden, symbolic and executable source categories are rejected without reads',()=>{
 let calls=0;
 for(const kind of ['hidden','symbol','getter'] as const){
  const input=fixture();
  if(kind==='symbol')Object.defineProperty(input.sources.captions!,Symbol('cost'),{value:null,enumerable:true});
  else Object.defineProperty(input.sources.captions!,'unreviewedSupplierCents',kind==='hidden'
   ?{value:null,enumerable:false}
   :{get(){calls++;return 0;},enumerable:true});
  assert.equal(commercialProfitMix(input).reason,'unknown',kind);
 }
 assert.equal(calls,0);
});

test('additional root financial categories are unknown even when zero or labelled as metadata',()=>{
 for(const key of ['unreviewedSupplierCents','privateContext','notes']){
  for(const amount of [null,0,100_000]){
   const input=Object.assign(fixture(),{[key]:amount});
   assert.equal(commercialProfitMix(input).reason,'unknown',`${key}: ${amount}`);
  }
 }
});

test('an auxiliary root Proxy cannot erase an unpriced cost while the encoder reads metadata',()=>{
 const base=fixture();
 const row=Object.assign(base.sources.training!,{unreviewedSupplierCents:null});
 let reads=0;
 const input:CommercialProfitMixInput&{aux?:object}={
  aux:new Proxy({}, {ownKeys(){reads++;delete (row as Partial<typeof row>).unreviewedSupplierCents;delete input.aux;return [];}}),...base,
 };
 const result=commercialProfitMix(input);
 assert.equal(result.reason,'unknown');
 assert.equal(result.totalNetProfitCents,null);
 assert.equal(reads,0,'extra root fields are refused before their values are traversed');
 assert.equal(Object.hasOwn(row,'unreviewedSupplierCents'),true);
});

test('a late-row Proxy cannot execute a getter installed on an earlier row (CX-119)',()=>{
 for(const throws of [false,true]){
  const input=fixture();let reads=0;
  input.sources.training=new Proxy(input.sources.training!,{
   ownKeys(target){
    Object.defineProperty(input.sources.plan_subscriptions!,'evidence',{
     enumerable:true,configurable:true,get(){reads++;if(throws)throw new Error('synthetic getter');return 'SYNTHETIC ONLY';},
    });
    return Reflect.ownKeys(target);
   },
  });
  const result=commercialProfitMix(input);
  assert.equal(result.reason,'unknown');assert.equal(result.totalNetProfitCents,null);
  assert.equal(reads,0,'neither returning nor throwing getters may execute');
 }
});
