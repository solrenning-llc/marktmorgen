/** Independent reproduction of Revisor 1's #2854 paid-but-never-delivered finding. Synthetic transports only. */
import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {captureOrder,readPaid,watchPayPal,type Paid,type CaptureResult} from '@/lib/paypal-sales';
import {addressHash} from '@/lib/imported-purchases';
import {plainAmount} from '@/lib/money';
import type {Store} from '@/lib/store';
import {store as redis} from '@/tests/redis-stub';

const SID='synthetic-z-paid-delivery',SELLER='7KNGBPH2U58GQ',EMAIL='buyer@example.com';
const shop={statsId:SID,handle:'zpaidrecovery',paypalSeller:{merchant:SELLER}} as unknown as Store;
process.env.PAYPAL_PARTNER_CLIENT_ID='AZpartnerClientId0123456789';
process.env.PAYPAL_PARTNER_SECRET='EPsyntheticSecret0123456789';
process.env.PAYPAL_PARTNER_MERCHANT_ID='PARTNERMERCH01';
process.env.PAYPAL_BN_CODE='Synthetic_SP';
delete process.env.PAYPAL_ENV;delete process.env.PAYPAL_API_BASE;
let captures=0,unexpected=0;
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const url=new URL(String(input));
 assert.equal(url.hostname,'api-m.paypal.com','only the synthetic PayPal endpoint may be requested');
 const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
 if(url.pathname==='/v1/oauth2/token')return json({access_token:'synthetic-token',expires_in:3600});
 const order=/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/.exec(url.pathname);
 if(order){
  if(init?.method==='POST'&&order[2])captures++;
  return json({id:order[1],status:'COMPLETED',payer:{email_address:EMAIL},purchase_units:[{payee:{merchant_id:SELLER},payments:{captures:[{id:'CAPSYNTHETIC001',status:'COMPLETED',amount:{value:plainAmount(1500,'usd'),currency_code:'USD'}}]}}]});
 }
 unexpected++;throw new Error('No synthetic response for this request');
}) as typeof fetch;
let serial=0;
async function flow(fault:'none'|'paid-ack-lost'|'indexes-refused'){
 redis.clear();captures=0;unexpected=0;
 const order=`5O1901ZPROOF${String(++serial).padStart(4,'0')}`;
 const at=Math.floor(Date.now()/1000);
 await redis.pipeline([['SET',`nl:ppsell:o:${order}`,JSON.stringify({s:SID,h:shop.handle,p:'p1',c:1500,cur:'usd',m:SELLER,at}),'EX',86400],['ZADD',`nl:ppsell:pending:${SID}`,String(at),order]]);
 const original=redis.pipeline;let injected=false;
 redis.pipeline=(async function(commands:(string|number)[][]){
  if(!injected&&fault==='indexes-refused'&&commands[0]?.[0]==='ZADD'&&commands[0]?.[1]===`nl:ppsell:watch:${SID}`){injected=true;throw new Error('Synthetic index pipeline refused after SET OK');}
  const answer=await original.call(redis,commands);
  if(!injected&&fault==='paid-ack-lost'&&commands[0]?.[0]==='SET'&&commands[0]?.[1]===`nl:ppsell:paid:${order}`){injected=true;return [undefined];}
  return answer;
 }) as typeof redis.pipeline;
 const handed:Paid[]=[];const handOver=async(p:Paid)=>{handed.push(p);};
 let first:CaptureResult|{threw:true};
 try{
  first=await captureOrder(shop,order);
  // Exact eligibility condition used by app/api/store/paypal/return/route.ts:24; actual delivery is a counted callback.
  if(first.ok&&first.fresh)await handOver(first.paid);
 }catch{first={threw:true};}finally{redis.pipeline=original;}
 for(let i=0;i<2;i++)await watchPayPal(shop,Date.now()+10000,{handOver,dropStart:async()=>{}});
 const again=await captureOrder(shop,order);if(again.ok&&again.fresh)await handOver(again.paid);
 const paid=await readPaid(order);
 const [owns,sales,pending,watched]=await redis.pipeline([['SMEMBERS',`nl:ppsell:own:${SID}:${addressHash(EMAIL)}:p1`],['ZCARD',`nl:ppsell:sales:${SID}`],['ZSCORE',`nl:ppsell:pending:${SID}`,order],['ZSCORE',`nl:ppsell:watch:${SID}`,order]]);
 const safe=(r:typeof first)=>'threw' in r?{threw:true}:r.ok?{ok:true,fresh:r.fresh}:{ok:false,reason:r.reason};
 console.log(JSON.stringify({fault,injected,first:safe(first),again:safe(again),syntheticCaptures:captures,paidRecorded:Boolean(paid),handOvers:handed.length,owns,sales,pending,watched,unexpected}));
 assert.equal(unexpected,0);assert.equal(captures,1,'the synthetic provider captured exactly once');assert.equal(Boolean(paid),true);
 assert.equal(handed.length,1,'a recorded captured payment must recover exactly one hand-over');
 assert.deepEqual(owns,[order]);assert.equal(sales,1);assert.notEqual(watched,null);
}
test('control: a healthy captured payment is handed over once across two sweeps and a retry',()=>flow('none'));
test('R1 regression: SET applied with its response lost still recovers one hand-over',()=>flow('paid-ack-lost'));
test('R1 inherited case: SET OK followed by a refused index pipeline still recovers one hand-over',()=>flow('indexes-refused'));
