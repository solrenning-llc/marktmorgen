import {reserveContractFunding,activateCheckoutContract} from '@/lib/contract-funding';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {NextRequest} from 'next/server';
import {POST as checkout} from '../app/api/billing/checkout/route';
import {POST as change} from '../app/api/billing/switch/route';
import {contractFundingConfiguration} from '@/lib/contract-funding-rules';
import {contractFixture} from './contract-funding-fixture';
import {setContractFundingPolicy} from './contract-funding-approved-policy';
import {setContractFinancialReview} from './contract-commercial-context';
import {reset,seed,ledger} from './contract-funding-redis';
import {setRouteStore} from './contract-route-studio';
import {observations,resetBilling} from './contract-route-billing';
function start(fund=true){reset();resetBilling();setRouteStore({});const f=contractFixture();setContractFinancialReview(f.review);setContractFundingPolicy(fund?f.policy:null);if(fund)seed(contractFundingConfiguration(f.policy,f.context)!);return f;}
const request=(path:string,cycle='year')=>new Request('https://marktmorgen.test/api/billing/'+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({tier:'creator',cycle})}) as unknown as NextRequest;
const result=(r:Response)=>new URL(r.headers.get('Location')!).searchParams.get('billing');
test('no actual reserve cannot create a checkout even with a mocked open sales gate',async()=>{start(false);assert.equal(result(await checkout(request('checkout'))),'not-open');assert.equal(observations.checkout.length,0);assert.equal(ledger.size,0);});
test('new checkout receives its full annual grant before the provider call',async()=>{const f=start();const response=await checkout(request('checkout'));assert.equal(response.headers.get('Location'),'https://checkout.stripe.test/session');assert.equal(observations.checkout.length,1);const grant=observations.checkout[0];assert.equal(grant.key,'creator_year');assert.equal(grant.reservedCents,contractFundingConfiguration(f.policy,f.context)!.grantCents.creator_year);assert.equal(ledger.get('nl:contract-reserve:v1')?.get('pending:route-one'),grant.id);});
test('a provider failure holds the reservation and refuses another pending obligation',async()=>{start();observations.fail=true;assert.equal(result(await checkout(request('checkout'))),'error');const reserved=ledger.get('nl:contract-reserve:v1')?.get('reserved');assert.equal(result(await checkout(request('checkout'))),'not-open');assert.equal(observations.checkout.length,1);assert.equal(ledger.get('nl:contract-reserve:v1')?.get('reserved'),reserved);});
test('a plan switch needs a fresh annual grant before payment confirmation is offered',async()=>{
 const f=start();
 const source=await reserveContractFunding('route-one','creator','month','checkout',f.policy,f.context,'ctr_route_source');assert.ok(source);
 const created=Math.floor(Date.now()/1000);
 assert.ok(created>=source.submitUntilSeconds-300,'provider creation follows its completed reservation');
 assert.equal(await activateCheckoutContract({statsId:'route-one',grantId:source.id,reviewId:source.reviewId,subscriptionId:'sub_Test000001',tier:'creator',cycle:'month',createdSeconds:created,trialing:false,periodStartSeconds:created,periodEndSeconds:created+30*86400},f.policy,f.context),true);
setRouteStore({subscriptionId:'sub_Test000001',subscriptionActive:true});const response=await change(request('switch'));assert.equal(response.headers.get('Location'),'https://invoice.stripe.test/confirm');assert.equal(observations.switches[0]?.key,'creator_year');assert.equal(ledger.get('nl:contract-reserve:v1')?.get('pending:route-one'),observations.switches[0].id);});
test('an existing active subscription is not intercepted as a new funded obligation',async()=>{start(false);setRouteStore({subscriptionActive:true,subscriptionId:'sub_Test000001'});assert.equal(result(await checkout(request('checkout'))),'already');assert.equal(observations.checkout.length,0);assert.equal(observations.find,0);});

test('an unmigrated subscription retains existing rights but cannot create an unbound switch obligation',async()=>{
 start();setRouteStore({subscriptionId:'sub_Test000001',subscriptionActive:true});
 const before=[...ledger.get('nl:contract-reserve:v1')!];
 assert.equal(result(await change(request('switch'))),'not-open');assert.equal(observations.switches.length,0);
 assert.deepEqual([...ledger.get('nl:contract-reserve:v1')!],before);
});

test('an unreadable subscription search cannot reserve cash or create a second checkout; recovery stays possible',async()=>{
 for(const cycle of ['month','year']){
  start();
  const before=JSON.stringify([...ledger].map(([key,value])=>[key,[...value]]));
  observations.findFail=true;
  for(let attempt=0;attempt<2;attempt++){
   assert.equal(result(await checkout(request('checkout',cycle))),'error');
   assert.equal(observations.find,attempt+1,'one search per request, no automatic retry');
   assert.equal(observations.checkout.length,0,'no new provider checkout on unknown existing subscriptions');
   assert.equal(JSON.stringify([...ledger].map(([key,value])=>[key,[...value]])),before,'no cash reservation or pending obligation on unknown search');
  }
  observations.findFail=false;
  const recovered=await checkout(request('checkout',cycle));
  assert.equal(recovered.headers.get('Location'),'https://checkout.stripe.test/session');
  assert.equal(observations.find,3);
  assert.equal(observations.checkout.length,1);
  assert.equal(observations.checkout[0].key,'creator_'+cycle);
 }
});
test('an already active plan remains accessible while subscription search is unavailable',async()=>{
 start(false);observations.findFail=true;
 setRouteStore({subscriptionActive:true,subscriptionId:'sub_Test000001'});
 const before=JSON.stringify([...ledger]);
 assert.equal(result(await checkout(request('checkout'))),'already');
 assert.equal(observations.find,0);
 assert.equal(observations.checkout.length,0);
 assert.equal(JSON.stringify([...ledger]),before);
});
