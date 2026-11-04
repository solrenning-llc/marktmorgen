import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalFinancialSnapshot,contractCoverageDays,contractFundingConfiguration,CONTRACT_ADMISSION_COVERAGE,CONTRACT_KEYS,CONTRACT_FUNDING_RULES} from '@/lib/contract-funding-rules';
import {assessCustomerWorstCase} from '@/lib/net-margin-rules';
import {takeRestartRecovery,restartSubmissionOpenNow,recordRestartResult,armRestartSubmission,ownedRestartIntentFromAcknowledgement,claimRestartIntent,activateCheckoutContract,activateSwitchContract,type CheckoutContractActivation,reserveContractFunding,reserveSwitchContractFunding,reserveRestartContractFunding} from '@/lib/contract-funding';
import {contractFixture} from './contract-funding-fixture';
import {reset,seed,ledger,calls,settings} from './contract-funding-redis';
import {txCustomerFixture} from './customer-tax-review-fixture';
import {contractTaxFixture,applyContractTaxCoverage} from './contract-tax-fixture';
import {CUSTOMER_COST_CATEGORIES} from '@/lib/net-margin-rules';
const key='nl:contract-reserve:v1';
function start(){reset();const f=contractFixture(),config=contractFundingConfiguration(f.policy,f.context,f.now)!;assert.ok(config);seed(config);return {...f,config};}
test('TX assessment does not authorize a contract before admission and liability periods are bound',async()=>{
 const f=contractFixture();
 const old=f.review.scenarios.creator_month_full!;
 const gross=old.collectedRevenueCents!,cost=CUSTOMER_COST_CATEGORIES.reduce((n,k)=>n+old.costCeilings[k]!,0);
 const tx=txCustomerFixture(gross,cost,{scenario:'creator_month_full',from:'2026-01-01',through:'2026-02-01',months:1});
 tx.costCeilings={...old.costCeilings};assert.equal(assessCustomerWorstCase(tx).approved,true);
 f.review.scenarios.creator_month_full=tx;f.policy.reservedFundsCents=1e12;
 f.policy.financialSnapshot=canonicalFinancialSnapshot(f.review)!;
 assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);
 assert.equal(contractFundingConfiguration(f.policy,f.context,new Date('2026-11-01T12:00:00.000Z')),null);
 reset();assert.equal(await reserveContractFunding('tx-held','creator','month','checkout',f.policy,f.context,'ctr_tx_hold'),null);
 assert.equal(calls.length,0);
});
test('explicit TX calendar coverage funds and activates the same production contract with every tax cent held',async()=>{
 const f=contractTaxFixture(),config=contractFundingConfiguration(f.policy,f.context,f.now);assert.ok(config);
 const tx=f.review.scenarios.creator_month_full!;
 assert.equal(assessCustomerWorstCase(tx).approved,true);assert.ok(tx.taxReview!.books.length>=2);
 const before=config.grantCents.creator_month;tx.taxesCeilingCents!+=317;f.policy.financialSnapshot=canonicalFinancialSnapshot(f.review)!;f.policy.reservedFundsCents=1e12;
 const more=contractFundingConfiguration(f.policy,f.context,f.now);assert.ok(more);assert.equal(more.grantCents.creator_month-before,317);
 reset();seed(more);
 const grant=await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_activate');assert.ok(grant);
 assert.equal(await activateCheckoutContract(activation(),f.policy,f.context),true);
 assert.equal(ledger.get(key)!.get('reserved'),String(more.grantCents.creator_month));
});
function expandedOnlyWhileCopying(policy:ReturnType<typeof contractTaxFixture>['policy']){
 const last=Reflect.ownKeys(policy).at(-1);let copying=false;
 return new Proxy(policy,{ownKeys(target){copying=true;return Reflect.ownKeys(target);},getOwnPropertyDescriptor(target,key){
  const descriptor=Reflect.getOwnPropertyDescriptor(target,key);if(!descriptor)return descriptor;
  const capture=copying;if(key===last)copying=false;
  if(capture&&key==='reviewedLiabilityTailDays')return {...descriptor,value:descriptor.value+400};
  if(capture&&key==='liabilitiesThrough')return {...descriptor,value:new Date(Date.parse(descriptor.value)+800*86400000).toISOString()};
  return descriptor;
 }});
}
test('contract configuration checks fiscal coverage against the policy actually captured, not an earlier Proxy view',()=>{
 const f=contractTaxFixture();f.policy.reservedFundsCents=1e12;
 assert.ok(contractFundingConfiguration(f.policy,f.context,f.now));
 assert.equal(contractFundingConfiguration(expandedOnlyWhileCopying(f.policy),f.context,f.now),null);
});
test('a policy changing its effective tail during capture cannot reserve outside the tax books or perform Redis IO',async()=>{
 const f=contractTaxFixture();f.policy.reservedFundsCents=1e12;const original=contractFundingConfiguration(f.policy,f.context,f.now)!;assert.ok(original);
 const proxy=expandedOnlyWhileCopying(f.policy),candidate=contractFundingConfiguration(proxy,f.context,f.now);
 reset();seed(candidate??original);const before=[...ledger.get(key)!];
 assert.equal(await reserveContractFunding('tx-proxy-policy','creator','year','checkout',proxy,f.context,'ctr_tx_proxy_policy'),null);
 assert.equal(calls.length,0);assert.deepEqual([...ledger.get(key)!],before);
});
test('a context cannot expose TX before capture and silently downgrade to legacy during an outer snapshot',async()=>{
 const f=contractTaxFixture();f.policy.reservedFundsCents=1e12;
 for(const row of Object.values(f.review.scenarios)){
  const pretax=row!.collectedRevenueCents!-row!.refundableRevenueCents!-CUSTOMER_COST_CATEGORIES.reduce((sum,k)=>sum+row!.costCeilings[k]!,0);
  row!.taxesCeilingCents=Math.ceil(pretax*.4);
 }
 f.policy.financialSnapshot=canonicalFinancialSnapshot(f.review)!;
 assert.ok(contractFundingConfiguration(f.policy,f.context,f.now));
 const legacy=structuredClone(f.review);for(const row of Object.values(legacy.scenarios)){delete row!.taxReview;delete row!.taxContext;}
 const legacySnapshot=canonicalFinancialSnapshot(legacy)!;
 function swapping<T extends object>(target:T,field:string,replacement:unknown):T{
  const last=Reflect.ownKeys(target).at(-1);let copying=false;
  return new Proxy(target,{ownKeys(value){copying=true;return Reflect.ownKeys(value);},getOwnPropertyDescriptor(value,key){
   const d=Reflect.getOwnPropertyDescriptor(value,key);if(!d)return d;const capture=copying;if(key===last)copying=false;
   return capture&&key===field?{...d,value:replacement}:d;
  }});
 }
 const context=swapping(f.context,'review',legacy),policy=swapping(f.policy,'financialSnapshot',legacySnapshot);
 const encoded=canonicalFinancialSnapshot(context);assert.ok(encoded);
 assert.ok(JSON.parse(encoded).review.scenarios.creator_month_full.taxReview,'the first captured TX descriptor is preserved');
 assert.equal(contractFundingConfiguration(policy,context,f.now),null);
 reset();assert.equal(await reserveContractFunding('tx-downgrade','creator','year','checkout',policy,context,'ctr_tx_downgrade'),null);assert.equal(calls.length,0);
});
test('missing TX cannot authorize any paying contract, including descriptor switches after the first read',async()=>{
 for(const txReads of [0,1,2,3]){
  const f=contractTaxFixture();f.policy.reservedFundsCents=1e12;
  for(const row of Object.values(f.review.scenarios)){
   const pretax=row!.collectedRevenueCents!-row!.refundableRevenueCents!-CUSTOMER_COST_CATEGORIES.reduce((sum,k)=>sum+row!.costCeilings[k]!,0);
   row!.taxesCeilingCents=Math.ceil(pretax*.5);
  }
  f.policy.financialSnapshot=canonicalFinancialSnapshot(f.review)!;const valid=contractFundingConfiguration(f.policy,f.context,f.now)!;assert.ok(valid);
  const legacy=structuredClone(f.review);for(const row of Object.values(legacy.scenarios)){delete row!.taxReview;delete row!.taxContext;}
  f.policy.financialSnapshot=canonicalFinancialSnapshot(legacy)!;let reads=0;
  const context=new Proxy(f.context,{getOwnPropertyDescriptor(target,key){const d=Reflect.getOwnPropertyDescriptor(target,key);return key==='review'&&d?{...d,value:++reads<=txReads?f.review:legacy}:d;}});
  reset();seed(valid);const before=[...ledger.get(key)!];
  assert.equal(await reserveContractFunding('tx-descriptor','creator','year','checkout',f.policy,context,'ctr_tx_descriptor'),null);
  assert.equal(calls.length,0);assert.deepEqual([...ledger.get(key)!],before);
 }
});
test('actual contract coverage includes every calendar book across a November admission and its existing liability horizon',t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-01T12:00:00.000Z')});
 try{
  const f=contractTaxFixture(),r=f.review.scenarios.creator_year_full!;
  assert.deepEqual(r.taxReview!.books.map(book=>book.year),[2026,2027,2028]);
  assert.equal(r.taxContext!.months,12);assert.equal(r.taxContext!.from,'2026-11-01');
  assert.equal(r.taxContext!.contract!.liabilitiesThrough,f.policy.liabilitiesThrough);
  assert.ok(r.taxReview!.fx.through>=f.policy.liabilitiesThrough.slice(0,10));
  assert.ok(contractFundingConfiguration(f.policy,f.context,f.now));
  for(const mutate of [
   ()=>{r.taxContext!.through=r.taxReview!.scope.through='2027-11-01';},
   ()=>{r.taxReview!.books.pop();},
  ]){
   const old=structuredClone(r);mutate();f.policy.financialSnapshot=canonicalFinancialSnapshot(f.review)!;
   assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);Object.assign(r,old);
  }
 }finally{t.mock.timers.reset();}
});
test('contract TX cannot authorize expired, future, mismatched or incompletely covered obligations',async()=>{
 for(const mutate of [
  (f:ReturnType<typeof contractTaxFixture>)=>{f.policy.reviewId='another';},
  (f:ReturnType<typeof contractTaxFixture>)=>{f.policy.admissionsUntil=new Date(Date.parse(f.policy.admissionsUntil)+1).toISOString();},
  (f:ReturnType<typeof contractTaxFixture>)=>{f.policy.liabilitiesThrough=new Date(Date.parse(f.policy.liabilitiesThrough)+1).toISOString();},
  (f:ReturnType<typeof contractTaxFixture>)=>{f.review.scenarios.creator_month_full!.taxContext!.contract!.admissionsFrom=new Date(f.now.getTime()+1000).toISOString();},
  (f:ReturnType<typeof contractTaxFixture>)=>{f.review.scenarios.creator_month_full!.taxReview!.fx.through=f.now.toISOString().slice(0,10);},
  (f:ReturnType<typeof contractTaxFixture>)=>{f.review.scenarios.creator_month_full!.taxReview!.books.pop();},
  (f:ReturnType<typeof contractTaxFixture>)=>{f.review.scenarios.creator_month_full!.taxReview!.scope={...f.review.scenarios.creator_month_full!.taxReview!.scope,contract:{...f.review.scenarios.creator_month_full!.taxContext!.contract!,reviewId:'another'}};},
 ]){
  const f=contractTaxFixture();mutate(f);f.policy.financialSnapshot=canonicalFinancialSnapshot(f.review)!;f.policy.reservedFundsCents=1e12;
  assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);
  reset();assert.equal(await reserveContractFunding('tx-invalid-period','creator','month','checkout',f.policy,f.context,'ctr_tx_invalid_period'),null);assert.equal(calls.length,0);
 }
 const f=contractTaxFixture();assert.equal(contractFundingConfiguration(f.policy,f.context,new Date(Date.parse(f.policy.admissionsUntil)+1)),null);
});
test('contract cash still retains every reviewed tax cent',()=>{
 const f=contractFixture();f.policy.reservedFundsCents=1e12;
 const before=contractFundingConfiguration(f.policy,f.context,f.now);assert.ok(before);
 f.review.scenarios.creator_month_full!.taxesCeilingCents!+=317;
 f.policy.financialSnapshot=canonicalFinancialSnapshot(f.review)!;
 const more=contractFundingConfiguration(f.policy,f.context,f.now);assert.ok(more);
 assert.equal(more.grantCents.creator_month-before.grantCents.creator_month,317);
});
test('contract clone cannot discard hidden, inherited or computed TX presence into the legacy path',async()=>{
 let getters=0;
 for(const field of ['taxReview','taxContext'])for(const kind of ['hidden','getter','inherited','proxy']){
  const f=contractFixture();assert.ok(contractFundingConfiguration(f.policy,f.context,f.now));
  const row=f.review.scenarios.creator_month_full!;
  if(kind==='inherited')Object.setPrototypeOf(row,{[field]:null});
  else Object.defineProperty(row,field,kind==='getter'?{enumerable:false,get(){getters++;return null;}}:{value:null,enumerable:false,configurable:true});
  if(kind==='proxy')f.review.scenarios.creator_month_full=new Proxy(row,{has(){return false;}});
  // Even the old enumerable-only binding may have omitted the hidden field.
  const encoded=canonicalFinancialSnapshot(f.review);if(encoded!==null)f.policy.financialSnapshot=encoded;
  assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);
  reset();assert.equal(await reserveContractFunding('tx-hidden','creator','month','checkout',f.policy,f.context,'ctr_tx_hidden'),null);
  assert.equal(calls.length,0);
  assert.equal(await activateCheckoutContract(activation(),f.policy,f.context),false);
  assert.equal(await activateSwitchContract(activation(),f.policy,f.context),false);
  assert.equal(calls.length,0);
 }
 assert.equal(getters,0);
});
test('TX fields in funded exposures stay closed before the contract clone instead of becoming legacy',async()=>{
 for(const field of ['taxReview','taxContext']){
  const f=contractFixture();assert.ok(contractFundingConfiguration(f.policy,f.context,f.now));
  Object.defineProperty(f.review.fundedExposure!.cases.trial.worstCase!,field,{value:null,enumerable:false});
  assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);
  reset();assert.equal(await reserveContractFunding('tx-exposure','creator','month','checkout',f.policy,f.context,'ctr_tx_exposure'),null);
  assert.equal(await activateCheckoutContract(activation(),f.policy,f.context),false);
  assert.equal(await activateSwitchContract(activation(),f.policy,f.context),false);
  assert.equal(calls.length,0);
 }
});
test('annual coverage funds twelve paid months plus the reviewed tail and repeated pause bounds',()=>{assert.equal(contractCoverageDays('month',60),167);assert.equal(contractCoverageDays('year',60),570);assert.equal(contractCoverageDays('year',null as unknown as number),null);assert.equal(contractCoverageDays('month',59),null);});
test('last admitted monthly and annual obligations keep full coverage after the maximum activation delay',()=>{
 for(const cycle of ['month','year'] as const){
  const f=contractFixture(),selected=cycle==='month'?'creator_month':'creator_year';
  f.policy.fundedGrants=Object.fromEntries(CONTRACT_KEYS.map(key=>[key,key===selected?2:0])) as typeof f.policy.fundedGrants;
  const days=contractCoverageDays(cycle,f.policy.reviewedLiabilityTailDays!);assert.ok(days);
  const admission=Date.parse(f.policy.admissionsUntil);
  f.policy.liabilitiesThrough=new Date(admission+days*86400000).toISOString();applyContractTaxCoverage(f);
  assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null,'the old boundary omits the permitted activation delay');
  const through=admission+(days+CONTRACT_FUNDING_RULES.activationDelayDays)*86400000;
  f.policy.liabilitiesThrough=new Date(through-1).toISOString();applyContractTaxCoverage(f);
  assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null,'one millisecond short cannot approve');
  f.policy.liabilitiesThrough=new Date(through).toISOString();applyContractTaxCoverage(f);
  const approved=contractFundingConfiguration(f.policy,f.context,f.now);assert.ok(approved);
  assert.equal(approved.liabilitiesThroughMs,through);
  assert.equal(approved.coverageDays[cycle],days,'activation delay is additional to the complete reviewed tail');
 }
});
test('cash reserve includes the full published refund principal without reducing or changing profit arithmetic',()=>{const f=start();const before=assessCustomerWorstCase(f.review.scenarios.creator_year_full!);assert.equal(f.config.grantCents.creator_month,9316);assert.equal(f.config.grantCents.creator_year,93153);assert.equal(before.netCents,44850);assert.deepEqual(assessCustomerWorstCase(f.review.scenarios.creator_year_full!),before);assert.equal(canonicalFinancialSnapshot(f.review),f.policy.financialSnapshot);});
test('one cent under aggregate grants or a quote covering only the paid year cannot approve',()=>{let f=contractFixture();f.policy.reservedFundsCents--;assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);f=contractFixture();f.policy.liabilitiesThrough=new Date(Date.parse(f.policy.admissionsUntil)+365*86400000).toISOString();assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);f=contractFixture();f.policy.allTermCostsAndLiabilitiesBounded=false;assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);});
test('new trial obligations and missing fixed costs cannot disappear from the quote',()=>{let f=contractFixture();f.policy.fundedGrants.creator_month++;f.policy.reservedFundsCents+=100000;assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);f=contractFixture();f.review.companyBase!.monthlyFixedCostsCeilingCents=null;f.policy.financialSnapshot=canonicalFinancialSnapshot(f.review)!;assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);});
test('canonical review binding refuses accessors, cycles, changed costs and expired admission',()=>{const f=contractFixture();let reads=0;Object.defineProperty(f.policy,'reservedFundsCents',{get(){reads++;return 1e12;}});assert.equal(contractFundingConfiguration(f.policy,f.context,f.now),null);assert.equal(reads,0);const cyclic:{self?:unknown}={};cyclic.self=cyclic;assert.equal(canonicalFinancialSnapshot(cyclic),null);const g=contractFixture();g.review.scenarios.creator_month_full!.costCeilings.other!++;assert.equal(contractFundingConfiguration(g.policy,g.context,g.now),null);const h=contractFixture();h.policy.admissionsUntil=new Date(h.now.getTime()-1).toISOString();assert.equal(contractFundingConfiguration(h.policy,h.context,h.now),null);});
test('canonical snapshots preserve exact enumerable legacy bytes and refuse any information loss',()=>{
 assert.equal(canonicalFinancialSnapshot({z:[3,true,null,{y:'two',a:1}],a:'first'}),'{"a":"first","z":[3,true,null,{"a":1,"y":"two"}]}');
 let reads=0;
 for(const kind of ['hidden-data','hidden-getter','array-extra']){
  const value=kind==='array-extra'?[1,2]:{nested:{}};
  const target=Array.isArray(value)?value:value.nested;
  Object.defineProperty(target,'extra',kind==='hidden-getter'?{enumerable:false,get(){reads++;throw Error('must not execute');}}:{value:null,enumerable:kind==='array-extra'});
  assert.equal(canonicalFinancialSnapshot(value),null);
 }
 for(const field of ['taxReview','taxContext']){
  assert.equal(canonicalFinancialSnapshot(Object.create({[field]:null})),null);
  const raw={safe:1,[field]:null};
  assert.equal(canonicalFinancialSnapshot(new Proxy(raw,{ownKeys(t){return Reflect.ownKeys(t).filter(key=>key!==field);},has(){return false;}})),null);
 }
 assert.equal(reads,0);
});
test('64 concurrent stores cannot reuse two funded grant slots',async()=>{const f=start();const results=await Promise.all(Array.from({length:64},(_,i)=>reserveContractFunding('store'+i,'creator','month','checkout',f.policy,f.context,'ctr_'+i)));assert.equal(results.filter(Boolean).length,2);assert.equal(ledger.get(key)?.get('reserved'),String(f.config.grantCents.creator_month*2));assert.equal(ledger.get(key)?.get('slots:creator_month'),'0');});
test('one pending store cannot open concurrent obligations under different grant IDs',async()=>{const f=start();const results=await Promise.all(Array.from({length:64},(_,i)=>reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_'+i)));assert.equal(results.filter(Boolean).length,1);assert.equal(ledger.get(key)?.get('reserved'),String(f.config.grantCents.creator_month));assert.equal(await reserveContractFunding('one','creator','year','switch',f.policy,f.context,'ctr_other'),null);});
test('lost acknowledgement retains cash, slot, nonce and pending store lock',async()=>{const f=start();settings({lostAck:true});assert.equal(await reserveContractFunding('one','creator','year','checkout',f.policy,f.context,'ctr_lost'),null);assert.equal(ledger.get(key)?.get('reserved'),String(f.config.grantCents.creator_year));settings({lostAck:false});assert.equal(await reserveContractFunding('one','creator','year','checkout',f.policy,f.context,'ctr_retry'),null);assert.equal(await reserveContractFunding('two','creator','year','checkout',f.policy,f.context,'ctr_lost'),null);assert.equal(ledger.get(key)?.get('slots:creator_year'),'1');});
test('carried liabilities cannot be reset or reused to finance new grants',async()=>{const f=contractFixture();f.policy.carryForwardReservedCents=100;f.policy.reservedFundsCents+=100;const c=contractFundingConfiguration(f.policy,f.context,f.now)!;reset();seed(c);assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_carry'));assert.equal(ledger.get(key)?.get('reserved'),String(100+c.grantCents.creator_month));ledger.get(key)!.set('reserved','99');const before=[...ledger.get(key)!];assert.equal(await reserveContractFunding('two','creator','month','checkout',f.policy,f.context,'ctr_other'),null);assert.deepEqual([...ledger.get(key)!],before);});
test('financial review ID alone cannot reuse a changed reserve budget or evidence',async()=>{const f=start();f.policy.reservedFundsCents++;f.policy.reserveEvidence+=' changed';assert.equal(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_changed'),null);assert.equal(ledger.get(key)?.get('reserved'),'0');});
test('corrupt money, slots, policy or storage acknowledgements deny without new rights',async()=>{for(const [field,value] of [['reserved','-1'],['carried','1'],['slots:creator_month','3'],['policy','wrong']]){const f=start();ledger.get(key)!.set(field,value);const before=[...ledger.get(key)!];assert.equal(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_bad'),null);assert.deepEqual([...ledger.get(key)!],before);}const f=start();for(const response of [[],[true],['1'],[1,1]]){settings({response});assert.equal(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_ack'),null);}});
test('absent real approvals and unfinished lifecycle coverage keep admission closed',async()=>{reset();assert.equal(await reserveContractFunding('one','creator','year','checkout'),null);assert.equal(calls.length,0);assert.equal(CONTRACT_ADMISSION_COVERAGE.renewals,false);assert.equal(CONTRACT_ADMISSION_COVERAGE.resourceAllocations,false);assert.equal(CONTRACT_ADMISSION_COVERAGE.settlementAndReserveReconciliation,false);assert.equal(CONTRACT_KEYS.length,6);});

test('computed financial context is not executed or accepted as reserve evidence',async()=>{const f=start();let reads=0;Object.defineProperty(f.context,'review',{get(){reads++;return f.review;}});assert.equal(contractFundingConfiguration(f.policy,f.context),null);assert.equal(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_getter'),null);assert.equal(reads,0);assert.equal(calls.length,0);});

test('missing or primitive financial contexts refuse admission without throwing',async()=>{const f=start();for(const value of [null,0,false,[],{}]){const context=value as unknown as typeof f.context;assert.equal(contractFundingConfiguration(f.policy,context),null);assert.equal(await reserveContractFunding('one','creator','month','checkout',f.policy,context,'ctr_invalid'),null);}assert.equal(calls.length,0);});

function activation(statsId='one',grantId='ctr_activate',createdSeconds=Math.floor(Date.now()/1000)):CheckoutContractActivation{
 return{statsId,grantId,reviewId:'contract_test',subscriptionId:'sub_Activation001',tier:'creator',cycle:'month',createdSeconds,trialing:false,periodStartSeconds:createdSeconds,periodEndSeconds:createdSeconds+30*86400};
}
test('checkout activation binds one receipt and provider subscription without releasing a cent or slot',async()=>{
 const f=start(),g=await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_activate');assert.ok(g);
 const before=ledger.get(key)!,reserved=before.get('reserved'),slots=before.get('slots:creator_month');
 const input=activation();assert.equal(await activateCheckoutContract(input,f.policy,f.context),true);
 assert.equal(before.get('reserved'),reserved);assert.equal(before.get('slots:creator_month'),slots);
 assert.equal(before.has('pending:one'),false);assert.ok(before.get('activated:ctr_activate'));assert.ok(before.get('grant:ctr_activate'));
 assert.equal(await activateCheckoutContract(input,f.policy,f.context),true);
 assert.equal(await activateCheckoutContract({...input,subscriptionId:'sub_Another001'},f.policy,f.context),false);
 assert.equal(await activateCheckoutContract({...input,periodStartSeconds:input.periodStartSeconds+3600,periodEndSeconds:input.periodEndSeconds+3600},f.policy,f.context),false);
 assert.equal(await activateCheckoutContract({...input,trialing:true,periodEndSeconds:input.createdSeconds+7*86400},f.policy,f.context),false);
 assert.equal(before.get('reserved'),reserved);
});
test('lost activation acknowledgement is recoverable only for the identical committed binding',async()=>{
 const f=start();assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_activate'));
 const input=activation();settings({lostAck:true});assert.equal(await activateCheckoutContract(input,f.policy,f.context),false);
 const before=[...ledger.get(key)!];settings({lostAck:false});
 assert.equal(await activateCheckoutContract(input,f.policy,f.context),true);assert.deepEqual([...ledger.get(key)!],before);
 assert.equal(await activateCheckoutContract({...input,statsId:'other'},f.policy,f.context),false);
});
test('activation rejects wrong store, plan, review, missing receipt and reused renewal period',async()=>{
 const f=start();assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_activate'));
 const before=[...ledger.get(key)!],input=activation();
 for(const changes of [{statsId:'other'},{tier:'scale'},{reviewId:'other'},{grantId:'ctr_missing'},{createdSeconds:1},{periodEndSeconds:input.createdSeconds+61*86400},{trialing:true,periodEndSeconds:input.createdSeconds+15*86400}]){
  assert.equal(await activateCheckoutContract({...input,...changes} as CheckoutContractActivation,f.policy,f.context),false);
  assert.deepEqual([...ledger.get(key)!],before);
 }
});
test('activation never treats a switch receipt, corrupt ledger or ambiguous response as rights',async()=>{
 const f=start();assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_source'));
 assert.equal(await activateCheckoutContract(activation('one','ctr_source'),f.policy,f.context),true);
 assert.ok(await reserveSwitchContractFunding('one','sub_Activation001','creator','month',f.policy,f.context,'ctr_activate'));
 assert.equal(await activateCheckoutContract(activation(),f.policy,f.context),false);
 for(const [field,value] of [['reserved','0'],['carried','1'],['slots:creator_month','2'],['policy','wrong']]){
  const g=start();assert.ok(await reserveContractFunding('one','creator','month','checkout',g.policy,g.context,'ctr_activate'));
  ledger.get(key)!.set(field,value);const before=[...ledger.get(key)!];
  assert.equal(await activateCheckoutContract(activation(),g.policy,g.context),false);assert.deepEqual([...ledger.get(key)!],before);
 }
 const g=start();assert.ok(await reserveContractFunding('one','creator','month','checkout',g.policy,g.context,'ctr_activate'));
 for(const response of [[],[1],[[true,9999999999]],[[1,0]],[[1,'9999999999']],[[1,9999999999,1]]]){
  settings({response});assert.equal(await activateCheckoutContract(activation(),g.policy,g.context),false);
 }
});
test('unconfigured or executable activation input makes no Redis request',async()=>{
 reset();assert.equal(await activateCheckoutContract(activation()),false);assert.equal(calls.length,0);
 const f=start(),input=activation();let reads=0;
 Object.defineProperty(input,'statsId',{get(){reads++;return 'one';}});
 assert.equal(await activateCheckoutContract(input,f.policy,f.context),false);assert.equal(reads,0);assert.equal(calls.length,0);
});

test('an active funded store cannot reserve another checkout even after its pending lock is cleared',async()=>{
 const f=start();assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_activate'));
 assert.equal(await activateCheckoutContract(activation(),f.policy,f.context),true);
 const h=ledger.get(key)!,before=[...h],active=h.get('active:one');
 assert.equal(h.has('pending:one'),false);
 const attempts=await Promise.all(Array.from({length:64},(_,i)=>reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_second_'+i)));
 assert.equal(attempts.some(Boolean),false);assert.deepEqual([...h],before);
 assert.ok(await reserveSwitchContractFunding('one','sub_Activation001','creator','month',f.policy,f.context,'ctr_switch_after_active'));
 assert.equal(h.get('active:one'),active);assert.equal(h.get('pending:one'),'ctr_switch_after_active');
 assert.ok(h.get('grant:ctr_activate'));assert.ok(h.get('grant:ctr_switch_after_active'));
 assert.equal(h.get('reserved'),String(f.config.grantCents.creator_month*2));
});

test('the returned grant purpose matches its permanent cash receipt',async()=>{
 for(const action of ['checkout','switch'] as const){
  const f=start();
  if(action==='switch'){
   assert.ok(await reserveContractFunding('purpose','creator','month','checkout',f.policy,f.context,'ctr_source'));
   assert.equal(await activateCheckoutContract(activation('purpose','ctr_source'),f.policy,f.context),true);
  }
  const g=action==='checkout'?await reserveContractFunding('purpose','creator','month',action,f.policy,f.context,'ctr_purpose'):await reserveSwitchContractFunding('purpose','sub_Activation001','creator','month',f.policy,f.context,'ctr_purpose');
  assert.ok(g);assert.equal(g.action,action);
  assert.equal(ledger.get(key)!.get('grant:'+g.id)!.split('|')[3],g.action);
 }
});

async function activeSource(){
 const f=start();assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_source'));
 assert.equal(await activateCheckoutContract(activation('one','ctr_source'),f.policy,f.context),true);return f;
}
test('switch admission requires a source subscription before any Redis operation',async()=>{
 const f=start();for(const id of [null,'','sub_bad','other',123]){
  assert.equal(await reserveContractFunding('one','creator','year','switch',f.policy,f.context,'ctr_unbound',id as string|null),null);
 }
 assert.equal(calls.length,0);
 assert.equal(await reserveContractFunding('one','creator','year','checkout',f.policy,f.context,'ctr_crossed','sub_Activation001'),null);
 assert.equal(calls.length,0);
});
test('64 source-bound switches preserve the original active contract and fund exactly one additional obligation',async()=>{
 const f=await activeSource(),h=ledger.get(key)!,active=h.get('active:one'),oldReceipt=h.get('grant:ctr_source');
 const results=await Promise.all(Array.from({length:64},(_,i)=>reserveSwitchContractFunding('one','sub_Activation001','creator','month',f.policy,f.context,'ctr_switch_'+i)));
 const accepted=results.filter((g):g is NonNullable<typeof g>=>Boolean(g));assert.equal(accepted.length,1);
 const g=accepted[0];assert.equal(g.action,'switch');assert.equal(g.sourceSubscriptionId,'sub_Activation001');
 assert.equal(h.get('active:one'),active);assert.equal(h.get('grant:ctr_source'),oldReceipt);
 assert.equal(h.get('reserved'),String(f.config.grantCents.creator_month*2));assert.equal(h.get('slots:creator_month'),'0');
 const receipt=h.get('grant:'+g.id)!.split('|');assert.equal(receipt.length,10);assert.equal(receipt[9],'ctr_source');
});
test('foreign, missing, corrupt or expired source records refuse a switch without touching any field',async()=>{
 const absent=start(),empty=[...ledger.get(key)!];
 assert.equal(await reserveSwitchContractFunding('one','sub_Activation001','creator','month',absent.policy,absent.context,'ctr_no_source'),null);
 assert.deepEqual([...ledger.get(key)!],empty);
 const changes=[
  ['active:one','ctr_source|sub_Other0001|creator_month|1|paid|1|9999999999'],
  ['activated:ctr_source','wrong'],
  ['grant:ctr_source','missing'],
  ['active:one','ctr_source|sub_Activation001|unknown|1|paid|1|9999999999'],
  ['active:one','ctr_source|sub_Activation001|creator_month|1|paid|1|2'],
 ];
 for(const [field,value] of changes){
  const f=await activeSource(),h=ledger.get(key)!;h.set(field,value);const before=[...h];
  assert.equal(await reserveSwitchContractFunding('one','sub_Activation001','creator','month',f.policy,f.context,'ctr_refused'),null);
  assert.deepEqual([...h],before);
 }
 const f=await activeSource(),h=ledger.get(key)!,before=[...h];
 assert.equal(await reserveSwitchContractFunding('one','sub_Other0001','creator','month',f.policy,f.context,'ctr_foreign'),null);assert.deepEqual([...h],before);
});
test('a lost source-bound switch reply retains both receipts, every cent and the pending lock',async()=>{
 const f=await activeSource(),h=ledger.get(key)!,active=h.get('active:one');settings({lostAck:true});
 assert.equal(await reserveSwitchContractFunding('one','sub_Activation001','creator','month',f.policy,f.context,'ctr_lost_switch'),null);
 assert.equal(h.get('active:one'),active);assert.equal(h.get('pending:one'),'ctr_lost_switch');assert.ok(h.get('grant:ctr_source'));
 assert.equal(h.get('grant:ctr_lost_switch')!.split('|')[9],'ctr_source');
 assert.equal(h.get('reserved'),String(f.config.grantCents.creator_month*2));
 const before=[...h];settings({lostAck:false});
 assert.equal(await reserveSwitchContractFunding('one','sub_Activation001','creator','month',f.policy,f.context,'ctr_retry_switch'),null);assert.deepEqual([...h],before);
});

async function switchSetup(trial=false){
 const f=start();assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_source'));
 const source=activation('one','ctr_source');if(trial){source.trialing=true;source.periodEndSeconds=source.createdSeconds+7*86400;}
 assert.equal(await activateCheckoutContract(source,f.policy,f.context),true);
 assert.ok(await reserveSwitchContractFunding('one','sub_Activation001','creator','month',f.policy,f.context,'ctr_switch'));
 const input={...source,grantId:'ctr_switch'};
 return{...f,input};
}
test('switch activation changes only the active pointer and keeps every prior receipt and reserved cent',async()=>{
 const f=await switchSetup(),h=ledger.get(key)!,old=h.get('active:one'),oldReceipt=h.get('grant:ctr_source'),reserved=h.get('reserved'),slots=h.get('slots:creator_month');
 assert.equal(await activateSwitchContract(f.input,f.policy,f.context),true);
 assert.notEqual(h.get('active:one'),old);assert.equal(h.get('activated:ctr_source'),old);
 assert.equal(h.get('grant:ctr_source'),oldReceipt);assert.ok(h.get('grant:ctr_switch'));assert.ok(h.get('activated:ctr_switch'));
 assert.equal(h.has('pending:one'),false);assert.equal(h.get('reserved'),reserved);assert.equal(h.get('slots:creator_month'),slots);
 const before=[...h];assert.equal(await activateSwitchContract(f.input,f.policy,f.context),true);assert.deepEqual([...h],before);
});
test('64 identical switch observations recover one atomic activation without changing money or slots',async()=>{
 const f=await switchSetup(),h=ledger.get(key)!,money=h.get('reserved'),slots=h.get('slots:creator_month');
 const results=await Promise.all(Array.from({length:64},()=>activateSwitchContract(f.input,f.policy,f.context)));
 assert.equal(results.every(Boolean),true);assert.equal(h.get('reserved'),money);assert.equal(h.get('slots:creator_month'),slots);
 assert.ok(h.get('activated:ctr_source'));assert.ok(h.get('activated:ctr_switch'));
});
test('a lost switch activation reply recovers only the identical committed phase and period',async()=>{
 const f=await switchSetup(),h=ledger.get(key)!;settings({lostAck:true});
 assert.equal(await activateSwitchContract(f.input,f.policy,f.context),false);assert.ok(h.get('activated:ctr_switch'));
 const before=[...h];settings({lostAck:false});
 assert.equal(await activateSwitchContract(f.input,f.policy,f.context),true);
 assert.equal(await activateSwitchContract({...f.input,subscriptionId:'sub_Other0001'},f.policy,f.context),false);
 assert.equal(await activateSwitchContract({...f.input,periodEndSeconds:f.input.periodEndSeconds+1},f.policy,f.context),false);
 assert.deepEqual([...h],before);
});
test('switch activation refuses a foreign identity, new trial, oversized term or corrupt source before writes',async()=>{
 const f=await switchSetup(),h=ledger.get(key)!,before=[...h];
 for(const changes of [{statsId:'other'},{subscriptionId:'sub_Other0001'},{createdSeconds:f.input.createdSeconds+1},{grantId:'ctr_source'},{trialing:true,periodEndSeconds:f.input.createdSeconds+7*86400},{periodEndSeconds:f.input.createdSeconds+32*86400},{reviewId:'other'}]){
  assert.equal(await activateSwitchContract({...f.input,...changes} as CheckoutContractActivation,f.policy,f.context),false);assert.deepEqual([...h],before);
 }
 for(const [field,value] of [['active:one','other'],['activated:ctr_source','other'],['grant:ctr_source','missing'],['reserved',String(f.config.grantCents.creator_month)] ]){
  const g=await switchSetup(),m=ledger.get(key)!;m.set(field,value);const previous=[...m];
  assert.equal(await activateSwitchContract(g.input,g.policy,g.context),false);assert.deepEqual([...m],previous);
 }
});
test('a trial switch cannot extend its source trial',async()=>{
 const f=await switchSetup(true),h=ledger.get(key)!,before=[...h];
 assert.equal(await activateSwitchContract({...f.input,periodEndSeconds:f.input.periodEndSeconds+86400},f.policy,f.context),false);assert.deepEqual([...h],before);
 assert.equal(await activateSwitchContract(f.input,f.policy,f.context),true);
});
test('switch activation rejects executable data and malformed acknowledgements',async()=>{
 reset();assert.equal(await activateSwitchContract(activation()),false);assert.equal(calls.length,0);
 const f=await switchSetup(),input={...f.input};let reads=0;Object.defineProperty(input,'statsId',{get(){reads++;return'one';}});
 const count=calls.length;assert.equal(await activateSwitchContract(input,f.policy,f.context),false);assert.equal(reads,0);assert.equal(calls.length,count);
 for(const response of [[],[1],[[true,9999999999]],[[1,0]],[[1,'9999999999']],[[1,9999999999,1]]]){
  settings({response});assert.equal(await activateSwitchContract(f.input,f.policy,f.context),false);
 }
});

test('committed checkout observations survive the initial deadline only for the exact current period',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-10T12:00:00.000Z')});
 reset();const f=contractFixture();f.policy.admissionsUntil=new Date(Date.now()+10*86400000).toISOString();applyContractTaxCoverage(f);
 const config=contractFundingConfiguration(f.policy,f.context)!;seed(config);
 assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_activate'));
 const input=activation();assert.equal(await activateCheckoutContract(input,f.policy,f.context),true);
 const h=ledger.get(key)!,before=[...h];t.mock.timers.tick(2*86400000);
 assert.equal(await activateCheckoutContract(input,f.policy,f.context),true);assert.deepEqual([...h],before);
 for(const changes of [{subscriptionId:'sub_Other0001'},{trialing:true},{periodStartSeconds:input.periodStartSeconds+1},{periodEndSeconds:input.periodEndSeconds+1}]){
  assert.equal(await activateCheckoutContract({...input,...changes},f.policy,f.context),false);assert.deepEqual([...h],before);
 }
 h.delete('activated:'+input.grantId);const uncommitted=[...h];
 assert.equal(await activateCheckoutContract(input,f.policy,f.context),false);assert.deepEqual([...h],uncommitted);
});
test('committed switch observations retain both principals after its initial deadline and cannot roll into renewal',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-10T12:00:00.000Z')});
 reset();const f=contractFixture();f.policy.admissionsUntil=new Date(Date.now()+10*86400000).toISOString();applyContractTaxCoverage(f);
 const config=contractFundingConfiguration(f.policy,f.context)!;seed(config);
 assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_source'));
 const source=activation('one','ctr_source');assert.equal(await activateCheckoutContract(source,f.policy,f.context),true);
 assert.ok(await reserveSwitchContractFunding('one',source.subscriptionId,'creator','month',f.policy,f.context,'ctr_switch'));
 const input={...source,grantId:'ctr_switch'};assert.equal(await activateSwitchContract(input,f.policy,f.context),true);
 const h=ledger.get(key)!,before=[...h];t.mock.timers.tick(2*86400000);
 assert.equal(await activateSwitchContract(input,f.policy,f.context),true);assert.deepEqual([...h],before);
 assert.equal(await activateCheckoutContract(source,f.policy,f.context),false);
 assert.equal(await activateSwitchContract({...input,periodStartSeconds:input.periodEndSeconds,periodEndSeconds:input.periodEndSeconds+30*86400},f.policy,f.context),false);
 settings({response:[[2,input.periodEndSeconds+1]]});assert.equal(await activateSwitchContract(input,f.policy,f.context),false);
 settings({response:[[1,input.periodEndSeconds]]});assert.equal(await activateSwitchContract(input,f.policy,f.context),false);settings({response:null});
 h.delete('activated:'+input.grantId);const uncommitted=[...h];
 assert.equal(await activateSwitchContract(input,f.policy,f.context),false);assert.deepEqual([...h],uncommitted);
});
test('a committed acknowledgement cannot authorize an ended period or bypass a stale admission policy',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-10T12:00:00.000Z')});
 const f=start();assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_activate'));
 const input=activation();assert.equal(await activateCheckoutContract(input,f.policy,f.context),true);
 const h=ledger.get(key)!,before=[...h];t.mock.timers.tick(2*86400000);
 assert.equal(await activateCheckoutContract(input,f.policy,f.context),false);assert.deepEqual([...h],before);
 settings({response:[[2,input.periodEndSeconds]]});t.mock.timers.tick(30*86400000);
 assert.equal(await activateCheckoutContract(input,f.policy,f.context),false);assert.deepEqual([...h],before);
});

test('a committed reservation acknowledgement cannot outlive admission, its exposure month, or its issuing clock',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-10T12:00:00.000Z')});
 for(const mode of ['admission','month','rollback','policy'] as const){
  t.mock.timers.setTime(new Date(mode==='month'?'2026-10-31T23:59:59.000Z':'2026-10-10T12:00:00.000Z').getTime());
  reset();const f=contractFixture();
  if(mode==='admission')f.policy.admissionsUntil=new Date(Date.now()+1000).toISOString();
  applyContractTaxCoverage(f);const config=contractFundingConfiguration(f.policy,f.context)!;assert.ok(config);seed(config);
  const pending=reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_late_ack');
  const h=ledger.get(key)!;assert.equal(h.get('pending:one'),'ctr_late_ack');
  const committed=[...h];
  if(mode==='admission')t.mock.timers.tick(1001);
  if(mode==='month')t.mock.timers.tick(1001);
  if(mode==='rollback')t.mock.timers.setTime(Date.now()-1);
  if(mode==='policy')f.policy.reserveEvidence+=' changed while awaiting acknowledgement';
  assert.equal(await pending,null,mode);
  assert.deepEqual([...h],committed,mode+' never releases committed cash, slot or lock');
  assert.equal(h.get('reserved'),String(config.grantCents.creator_month));
  assert.equal(h.get('slots:creator_month'),'1');
  assert.equal(calls.length,1,mode+' performs no compensating Redis request');
 }
});

test('checkout and switch acknowledgements revalidate admission, exposure, policy and the issuing clock after committing',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-10T12:00:00.000Z')});
 for(const action of ['checkout','switch'] as const){
  for(const mode of ['admission','month','rollback','policy'] as const){
   t.mock.timers.setTime(new Date(mode==='month'?'2026-10-31T23:59:59.000Z':'2026-10-10T12:00:00.000Z').getTime());
   reset();const f=contractFixture();
   if(mode==='admission')f.policy.admissionsUntil=new Date(Date.now()+1000).toISOString();
   applyContractTaxCoverage(f);const config=contractFundingConfiguration(f.policy,f.context)!;assert.ok(config);seed(config);
   assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_source'));
   let input=activation('one','ctr_source');
   if(action==='switch'){
    assert.equal(await activateCheckoutContract(input,f.policy,f.context),true);
    assert.ok(await reserveSwitchContractFunding('one','sub_Activation001','creator','month',f.policy,f.context,'ctr_switch'));
    input={...input,grantId:'ctr_switch'};
   }
   const beforeCalls=calls.length;
   const pending=action==='checkout'?activateCheckoutContract(input,f.policy,f.context):activateSwitchContract(input,f.policy,f.context);
   const h=ledger.get(key)!;assert.ok(h.get('activated:'+input.grantId));assert.equal(h.has('pending:one'),false);
   const committed=[...h];
   if(mode==='admission'||mode==='month')t.mock.timers.tick(1001);
   if(mode==='rollback')t.mock.timers.setTime(Date.now()-1);
   if(mode==='policy')f.policy.reserveEvidence+=' changed while awaiting activation acknowledgement';
   assert.equal(await pending,false,action+' '+mode);
   assert.deepEqual([...h],committed,action+' '+mode+' preserves all committed proofs and funds');
   assert.equal(calls.length,beforeCalls+1,'no compensating Redis operation');
  }
 }
});

test('unfinished pause-restart coverage refuses before Redis even with a synthetic reviewed policy',async()=>{
 const f=start();assert.equal(CONTRACT_ADMISSION_COVERAGE.pauseRestart,false);
 const before=[...ledger.get(key)!];
 for(const tier of ['creator','pro','scale'] as const){
  assert.equal(await reserveRestartContractFunding('one','sub_RestartSource01',tier,f.policy,f.context,'ctr_restart_'+tier),null);
 }
 assert.equal(await reserveContractFunding('one','creator','year','restart',f.policy,f.context,'ctr_annual','sub_RestartSource01'),null);
 assert.equal(calls.length,0);
 assert.deepEqual([...ledger.get(key)!],before);
});

test('unfinished integrated restart intent refuses before Redis and never opens coverage',async()=>{
 const f=start(),before=[...ledger.get(key)!];
 assert.equal(CONTRACT_ADMISSION_COVERAGE.pauseRestart,false);
 assert.equal(CONTRACT_FUNDING_RULES.restartIntent.status,'intent-only-disabled');
 assert.equal(CONTRACT_FUNDING_RULES.restartIntent.commandCeiling,17);
 assert.equal(CONTRACT_FUNDING_RULES.restartIntent.maxPauseBytes,1536);
 assert.equal(CONTRACT_FUNDING_RULES.restartIntent.maxIntentBytes,4096);
 const grant={sourceSubscriptionId:'sub_RestartSource01',action:'restart' as const,id:'ctr_new',reviewId:'review',statsId:'one',key:'creator_month' as const,reservedCents:50,submitUntilSeconds:Math.floor(Date.now()/1000)+300,checkoutExpiresAtSeconds:Math.floor(Date.now()/1000)+3600,activationUntilSeconds:Math.floor(Date.now()/1000)+86400,liabilitiesThrough:'2030-01-01T00:00:00.000Z'};
 assert.equal(await claimRestartIntent({grant,ref:'one@example.com',handle:'one-store',paused:'{}',claim:'claim_one',sourceGrantId:'ctr_source'},f.policy,f.context),null);
 assert.equal(calls.length,0);
 assert.deepEqual([...ledger.get(key)!],before);
});

test('first-owner acknowledgement carries the exact immutable atomic source and cash snapshot',()=>{
 const now=1800000001;
 const grant={sourceSubscriptionId:'sub_RestartSource01',action:'restart' as const,id:'ctr_restart_new',reviewId:'review',statsId:'restart-store',key:'creator_month' as const,reservedCents:50,submitUntilSeconds:1800000300,checkoutExpiresAtSeconds:1800003600,activationUntilSeconds:1800086400,liabilitiesThrough:new Date(2000000000000).toISOString()};
 const paused=JSON.stringify({subscription:grant.sourceSubscriptionId,customer:'cus_IntentCustomer01',paymentMethod:'pm_IntentCard001',tier:'creator',from:1800000000,until:now,told:0,funding:{version:1,grantId:'ctr_restart_source'}});
 const input={grant,ref:'synthetic-source',handle:'synthetic-store',paused,claim:'claim_first',sourceGrantId:'ctr_restart_source'};
 const budget={cashLimitCents:140,carryForwardCents:0};
 const sourceBinding='ctr_restart_source|sub_RestartSource01|creator_month|1799999000|paid|1799999000|1800000000';
 const sourceReceipt='review|restart-store|creator_month|checkout|40|1799999300|1800000000|1800000200|2000000000000';
 const restartReceipt='review|restart-store|creator_month|restart|50|1800000300|1800003600|1800086400|2000000000000|ctr_restart_source';
 const frame={version:1,grant:grant.id,review:grant.reviewId,statsId:grant.statsId,sourceSubscription:grant.sourceSubscriptionId,sourceGrant:input.sourceGrantId,ref:input.ref,handle:input.handle,paused,claim:input.claim,created:now,deadline:grant.submitUntilSeconds,sourceBinding,sourceReceipt,restartReceipt,reservedCents:90,carriedCents:0,annual:1799999000};
 const decode=(value:unknown)=>ownedRestartIntentFromAcknowledgement(input,now,budget,value);
 for(const action of ['switch','restart']){
  const prior=sourceReceipt.replace('|checkout|','|'+action+'|')+'|ctr_upstream_source';
  const observed=decode([1,JSON.stringify({...frame,sourceReceipt:prior,reservedCents:100})]);assert.ok(observed);
  assert.equal(observed.source.receipt,prior);
 }
 for(const handle of ['a.b','a_b','a-b','abc','a'.repeat(24)]){
  assert.ok(ownedRestartIntentFromAcknowledgement({...input,handle},now,budget,[1,JSON.stringify({...frame,handle})]));
 }
 for(const handle of ['ab','a'.repeat(25),'.abc','abc_','abc.']){
  assert.equal(ownedRestartIntentFromAcknowledgement({...input,handle},now,budget,[1,JSON.stringify({...frame,handle})]),null);
 }
 for(const annual of [undefined,null,0,-1,1.5,1800000001,Number.MAX_SAFE_INTEGER,"1799999000"]){
  assert.equal(decode([1,JSON.stringify({...frame,annual})]),null);
 }
 const owned=decode([1,JSON.stringify(frame)]);assert.ok(owned);
 assert.deepEqual(owned.source,{binding:sourceBinding,receipt:sourceReceipt,restartReceipt,reservedCents:90,carriedCents:0,annual:1799999000});
 assert.equal(owned.claim,input.claim);assert.equal(owned.paused,paused);
 assert.ok(Object.isFrozen(owned)&&Object.isFrozen(owned.source)&&Object.isFrozen(owned.grant));
 for(const ack of [null,[],[1],[1,null],[1,'{'],[1,JSON.stringify(frame),1],[2,JSON.stringify(frame)],[1,JSON.stringify({...frame,claim:'claim_other'})],[1,JSON.stringify({...frame,sourceSubscription:'sub_ForeignIntent01'})],[1,JSON.stringify({...frame,sourceBinding:sourceBinding.replace('|paid|','|trial|')})],[1,JSON.stringify({...frame,sourceReceipt:sourceReceipt.replace('|40|','|41|'),reservedCents:90})],[1,JSON.stringify({...frame,restartReceipt:restartReceipt.replace('|50|','|49|')})],[1,JSON.stringify({...frame,reservedCents:89})],[1,JSON.stringify({...frame,carriedCents:1})],[1,JSON.stringify({...frame,extra:'not an owned field'})],[1,'x'.repeat(4097)]]){
  assert.equal(decode(ack),null);
 }
 assert.equal(ownedRestartIntentFromAcknowledgement(input,now,{cashLimitCents:89,carryForwardCents:0},[1,JSON.stringify(frame)]),null);
 assert.equal(ownedRestartIntentFromAcknowledgement(input,1800000301,budget,[1,JSON.stringify({...frame,created:1800000301})]),null);
 let getters=0;const hostile={...input};Object.defineProperty(hostile,'claim',{enumerable:true,get(){getters++;return input.claim;}});
 assert.equal(ownedRestartIntentFromAcknowledgement(hostile,now,budget,[1,JSON.stringify(frame)]),null);assert.equal(getters,0);
 input.grant.id='ctr_caller_mutated';assert.equal(owned.grant.id,'ctr_restart_new');
});

test('closed submission barrier performs no Redis or provider IO even with a synthetic reviewed policy',async()=>{const f=contractFixture();reset();assert.equal(await armRestartSubmission({intent:null as never,priceId:'price_SyntheticRestart01',bodyHash:'a'.repeat(64)},f.policy,f.context),null);assert.equal(calls.length,0);});

test('closed result retention wrapper cannot perform Redis IO for a fabricated result',async()=>{reset();assert.equal(await recordRestartResult({armed:null as never,subscriptionId:'sub_SyntheticResult01'}),false);assert.equal(calls.length,0);});

test('closed final submission check cannot authorize POST for fabricated ownership',()=>{assert.equal(restartSubmissionOpenNow(null as never),false);});

test('closed recovery wrapper performs no Redis reads or writes for fabricated ownership',async()=>{reset();assert.equal(await takeRestartRecovery(null as never),null);assert.equal(calls.length,0);});

test('actual checkout and switch activation reject non-own ACKs before member traversal',async()=>{
 for(const mode of ['checkout','switch'] as const){
  const f=mode==='switch'?await switchSetup():{...start(),input:activation()};
  if(mode==='checkout')assert.ok(await reserveContractFunding('one','creator','month','checkout',f.policy,f.context,'ctr_activate'));
  // A switch keeps the exact provider subscription and original creation time.
  const input=f.input;
  const invoke=()=>mode==='checkout'?activateCheckoutContract(input,f.policy,f.context):activateSwitchContract(input,f.policy,f.context);
  const snapshot=[...ledger.get(key)!];let getters=0,members=0;
  const outerGetter=Object.defineProperty(new Array(1),'0',{get(){getters++;return [2,input.periodEndSeconds];}});
  const innerGetter=Object.defineProperty([2,0],'1',{get(){getters++;return input.periodEndSeconds;}});
  const inherited=new Array(2),proto=Object.create(Array.prototype);
  Object.defineProperty(proto,'0',{value:2});Object.defineProperty(proto,'1',{value:input.periodEndSeconds});Object.setPrototypeOf(inherited,proto);
  const symbol=[2,input.periodEndSeconds];Object.defineProperty(symbol,Symbol('extra'),{value:1});
  const oversized=(value:unknown[])=>new Proxy(value,{getOwnPropertyDescriptor(target,key){
   if(key==='0'||key==='1'){members++;throw Error('oversized ACK member');}
   return Reflect.getOwnPropertyDescriptor(target,key);
  }});
  const outerLarge=oversized([null,null]),innerLarge=oversized([2,input.periodEndSeconds,0]);
  assert.throws(()=>Object.getOwnPropertyDescriptor(outerLarge,'0'));assert.equal(members,1);members=0;
  for(const response of [outerGetter,[innerGetter],[inherited],[symbol],outerLarge,[innerLarge],new Array(1),[new Array(2)],[[2,input.periodEndSeconds+1]],[[true,input.periodEndSeconds]]]){
   settings({response});assert.equal(await invoke(),false,mode);
   assert.deepEqual([...ledger.get(key)!],snapshot,'unknown ACK retains cash, slots, source and pending receipt');
  }
  assert.equal(getters,0);assert.equal(members,0);
  settings({response:null});assert.equal(await invoke(),true,'normal simulated ledger acknowledgement still works');
  const committed=[...ledger.get(key)!];assert.equal(await invoke(),true,'identical committed binding still observed');
  assert.deepEqual([...ledger.get(key)!],committed);
  assert.equal(ledger.get(key)!.get('reserved'),new Map(snapshot).get('reserved'));
  assert.equal(ledger.get(key)!.get('slots:creator_month'),new Map(snapshot).get('slots:creator_month'));
 }
});
