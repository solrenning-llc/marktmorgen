import assert from 'node:assert/strict';
import {captureOrder} from '@/lib/paypal-sales';
import type {Store} from '@/lib/store';
import {store as redis} from './redis-stub';
process.env.PAYPAL_PARTNER_CLIENT_ID='AZpartnerClientId0123456789';process.env.PAYPAL_PARTNER_SECRET='EPpartnerSecret0123456789';process.env.PAYPAL_PARTNER_MERCHANT_ID='PARTNERMERCH01';process.env.PAYPAL_BN_CODE='Synthetic_SP';delete process.env.PAYPAL_ENV;
const seller='7KNGBPH2U58GQ',id='5O1901PROOF00001',sid='synthetic-pending-count',buyer='buyer@example.com';
globalThis.fetch=(async(input)=>new Response(JSON.stringify(String(input).includes('/oauth2/token')?{access_token:'synthetic',expires_in:3600}:{status:'COMPLETED',payer:{email_address:buyer},purchase_units:[{payee:{merchant_id:seller},payments:{captures:[{id:'CAPTURE00001',status:'COMPLETED',amount:{value:'15.00',currency_code:'USD'}}]}}]}))) as typeof fetch;
async function scenario(reply:number){
 redis.clear();const real=redis.pipeline.bind(redis);await real([['SET',`nl:ppsell:o:${id}`,JSON.stringify({s:sid,h:'proofshop',p:'p1',c:1500,cur:'usd',m:seller,at:Math.floor(Date.now()/1000)})]]);let handed=0;
 redis.pipeline=(async commands=>{const out=await real(commands);return commands.length===2&&commands[0][0]==='ZADD'&&String(commands[0][1]).startsWith('nl:ppsell:pending:')?[reply,out[1]]:out;}) as typeof redis.pipeline;
 try{const result=await captureOrder({statsId:sid,handle:'proofshop',paypalSeller:{merchant:seller}} as Store,id,async()=>{handed++;});return{ok:result.ok,handed};}finally{redis.pipeline=real;}
}
async function main(){const control=await scenario(1);assert.deepEqual(control,{ok:true,handed:1});const invalid=await scenario(2);console.log(JSON.stringify({control,invalid}));assert.deepEqual(invalid,{ok:false,handed:0},'a one-member ZADD reply outside 0/1 must be unknown before hand-over');}
void main().catch(e=>{console.error(e);process.exitCode=1;});
