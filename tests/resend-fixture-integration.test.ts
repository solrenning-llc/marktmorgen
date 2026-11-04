/** Exact test credential registration, never actual account approval. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {syntheticResendCredential} from './resend-fixture-credentials';
import {prepareResendFallbackFixture} from './resend-fallback-fixture';
import {currentResendFallbackProofIsMissing} from '../lib/resend-fallback-transport';

const keys=['re_test_erasure_asked_only_a_stand_in','re_test_erasure_full_only_a_stand_in','re_test_erasure_scope_all_only_a_stand_in','re_test_erasure_timing_only_a_stand_in','re_test_invite_two_step_only_a_stand_in','re_test_orders_only_a_stand_in','re_test_orders_bounds_only','re_test_reset_notices_only_a_stand_in','re_test_second_step_gate_only','re_test_team_two_step_session_only','re_test_call_lengths_said','re_test_stop_only_a_stand_in','re_test_auto_approve_stand_in','re_test_affiliate_idle_only','re_test_call_cancel_only','re_test_call_place_only','re_test_deposit_rest_only','re_test_inbox_affiliate_only'];
test('new inherited application journeys use only their exact declared synthetic credentials',async()=>{
 for(const key of keys){
  assert.equal(syntheticResendCredential(key),key);
  const f=prepareResendFallbackFixture({credential:key});await f.ready;
  assert.equal(f.review.evidence,'SYNTHETIC ONLY; not a live plan or payment');
  const protection=f.review.protection;assert.ok(protection.kind==='inclusive_provider_hard_cap');
  assert.equal(protection.sentAndReceived,true);assert.equal(protection.overagesDisabled,true);
  assert.equal(f.requests.length,0,'initialization does not send to a provider');
 }
});
test('similar, real-looking, whitespace and executable values cannot enter a synthetic account',()=>{
 let reads=0;const executable={toString(){reads++;throw Error('No coercion');}};
 for(const value of [null,undefined,0,executable,'re_unreviewed_real_looking_key',...keys.flatMap(k=>[k+'x',' '+k,k+' '])]){
  assert.equal(syntheticResendCredential(value),null);
  assert.throws(()=>prepareResendFallbackFixture({credential:value as string}),/Unknown synthetic fixture credential/);
 }
 assert.equal(reads,0);
});
test('registering copy-test credentials does not supply the product review or credential binding',()=>{
 const old=process.env.RESEND_API_KEY;
 try{for(const key of keys){process.env.RESEND_API_KEY=key;assert.equal(currentResendFallbackProofIsMissing(),true);}}
 finally{if(old===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=old;}
});
test('every Redis security journey that sends through Resend receives the reviewed synthetic transport',()=>{
 const root=process.cwd();
 const security=resolve(root,'tests/security');
 const runner=readFileSync(resolve(root,'scripts/security-redis.mjs'),'utf8');
 const sending=readdirSync(security).filter(file=>file.endsWith('.redis-run.ts')&&readFileSync(resolve(security,file),'utf8').includes('RESEND_API_KEY')).sort();
 assert.deepEqual(sending,['access-email-reserve.redis-run.ts','agreement-signature.redis-run.ts','erasure-request-asked.redis-run.ts','payment-request-state.redis-run.ts']);
 for(const file of sending)assert.ok(runner.includes(`"${file}"`),`${file} must use the finite reviewed test transport`);
});
