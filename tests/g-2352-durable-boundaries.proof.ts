import test from 'node:test';
import assert from 'node:assert/strict';
import {queuedShipmentMailSender} from '@/lib/email';
import {createResendFallbackFixture} from './resend-fallback-fixture';
const credential='re_SYNTHETIC_TRANSPORT_ONLY';
const message={from:'Synthetic <owner@example.test>',to:'buyer@example.test',subject:'Existing right',text:'Original content',replyTo:'owner@example.test'};
function configure(){process.env.RESEND_API_KEY=credential;for(const k of ['AWS_SES_ROLE_ARN','AWS_SES_REGION','AWS_SES_CONFIGURATION_SET','AWS_SES_TOPIC_ARN','VERCEL_OIDC_TOKEN'])delete process.env[k];}
test('refused or throwing dispatch barriers never make a provider POST',async()=>{
configure();for(const kind of ['false','throw']){const f=await createResendFallbackFixture({credential,fetch:async()=>{throw Error('POST forbidden');}});let barriers=0;const result=await queuedShipmentMailSender(f.runtime)(message,async()=>{barriers++;if(kind==='throw')throw Error('Synthetic barrier failure');return false;},{id:'g-barrier-'+kind});assert.equal(result,'unknown');assert.equal(barriers,1);assert.equal(f.requests.filter(r=>r.method==='POST').length,0);}
});
test('lost provider response is never replayed or certified accepted/refused',async()=>{
configure();const f=await createResendFallbackFixture({credential,fetch:async()=>{throw Error('Synthetic applied POST, lost response');}});let barriers=0;const sender=queuedShipmentMailSender(f.runtime),barrier=async()=>{barriers++;return true;};assert.equal(await sender(message,barrier,{id:'g-lost'}),'unknown');assert.equal(await sender(message,barrier,{id:'g-lost'}),'waiting');assert.equal(f.requests.filter(r=>r.method==='POST').length,1);assert.equal(barriers,1);
});
test('accepted receipt still requires the current callers dispatch barrier, without another POST',async()=>{
configure();const f=await createResendFallbackFixture({credential,fetch:async()=>Response.json({id:'synthetic_g2352'})});let barriers=0;const sender=queuedShipmentMailSender(f.runtime),barrier=async()=>++barriers===1;assert.equal(await sender(message,barrier,{id:'g-receipt'}),'accepted');assert.equal(await sender(message,barrier,{id:'g-receipt'}),'unknown');assert.equal(f.requests.filter(r=>r.method==='POST').length,1);assert.equal(barriers,2);
});
test('an exhausted funded fallback quota refuses before caller allowance or POST',async()=>{
configure();const f=await createResendFallbackFixture({credential,cap:1,sent:1,fetch:async()=>{throw Error('POST forbidden');}});let barriers=0;assert.equal(await queuedShipmentMailSender(f.runtime)(message,async()=>{barriers++;return true;},{id:'g-quota'}),'waiting');assert.equal(f.requests.filter(r=>r.method==='POST').length,0);assert.equal(barriers,0);
});
test('HTTP success with no provider receipt remains unknown and cannot be replayed',async()=>{
configure();const f=await createResendFallbackFixture({credential,fetch:async()=>Response.json({}, {status:202})});let barriers=0;const sender=queuedShipmentMailSender(f.runtime),barrier=async()=>{barriers++;return true;};assert.equal(await sender(message,barrier,{id:'g-no-receipt'}),'unknown');assert.equal(await sender(message,barrier,{id:'g-no-receipt'}),'waiting');assert.equal(f.requests.filter(r=>r.method==='POST').length,1);assert.equal(barriers,1);
});
