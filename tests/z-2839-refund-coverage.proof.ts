/** Independent #2839 consumer proof. Only synthetic persisted rows; no provider calls. */
import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {creditPayPalSale, readBook} from '@/lib/affiliates';
import {NO_AFFILIATES} from '@/lib/affiliate-setting';
import {readPayPalRefundsWithCoverage, readPayPalRefunds, type Paid} from '@/lib/paypal-sales';
import {payableLines} from '@/lib/paypal-payouts';
import type {Store} from '@/lib/store';
import {store as redis} from '@/tests/redis-stub';

const AT=Math.floor(Date.now()/1000)-60;
const SID='synthetic-z-refund-coverage';
const AFF='aaaaaaaaaaaa';
const ORDER='5O190127TN3647101';
let external=0;
globalThis.fetch=(async()=>{external++;throw new Error('No provider transport in this proof');}) as typeof fetch;
const store={sid:'synthetic-z-store',statsId:SID,handle:'synthetic-z-shop',name:'Synthetic shop',email:'owner@example.com',currency:'usd',previousHandles:[],releasedHandles:[],affiliates:{...NO_AFFILIATES,enabled:true,percent:20,hold:0}} as unknown as Store;
const paid:Paid={store:SID,order:ORDER,capture:'3C679366HH908701',email:'buyer@example.com',product:'course',cents:5000,currency:'usd',at:AT-3600,via:{aff:AFF,rate:20}};
async function setup(){
 redis.clear();external=0;
 await redis.pipeline([['HSET',`nl:aff:${SID}:people`,AFF,JSON.stringify({id:AFF,email:'affiliate@example.com',code:'synthetic',status:'approved',appliedAt:1,decidedAt:1,note:''})]]);
 await creditPayPalSale(store,paid,'Synthetic course');
 await redis.pipeline([['SET',`nl:ppsell:paid:${ORDER}`,JSON.stringify(paid),'NX','EX',86400]]);
}
async function observe(label:string){
 const covered=await readPayPalRefundsWithCoverage(SID,0);
 const wrapped=await readPayPalRefunds(SID,0);
 let commands=0,replyBytes=0;
 const original=redis.pipeline;
 redis.pipeline=(async function(batch:(string|number)[][]){commands+=batch.length;const replies=await original.call(redis,batch);replyBytes+=Buffer.byteLength(JSON.stringify(replies),'utf8');return replies;}) as typeof redis.pipeline;
 let book;
 try{book=await readBook(store);}finally{redis.pipeline=original;}
 const offered=payableLines(book,new Set()).reduce((sum,line)=>sum+line.cents,0);
 const throughRefundGate=book.refundsChecked?offered:0;
 const row=book.lines.find(line=>line.ref===`paypal:${ORDER}`);
 console.log(JSON.stringify({label,partial:covered.partial,coveredRows:covered.rows.length,wrappedRows:wrapped.length,targetIncluded:covered.rows.some(r=>r.order===ORDER),refundsChecked:book.refundsChecked,commission:row?.commission,offered,throughRefundGate,bookCommands:commands,bookReplyJsonBytes:replyBytes,external}));
 assert.equal(external,0);
 return{covered,wrapped,book,row,throughRefundGate};
}
test('control: an unrefunded sale is confirmed payable',async()=>{
 await setup();const x=await observe('no-refund');
 assert.equal(x.covered.partial,false);assert.equal(x.book.refundsChecked,true);assert.equal(x.throughRefundGate,1000);
});
test('control: a confirmed full refund removes the commission',async()=>{
 await setup();await redis.pipeline([['ZADD',`nl:ppsell:refunded:${SID}`,String(AT),ORDER]]);
 const x=await observe('confirmed-refund');
 assert.equal(x.covered.partial,false);assert.equal(x.book.refundsChecked,true);assert.equal(x.row?.commission,0);assert.equal(x.throughRefundGate,0);
});
test('a refund with a missing paid record cannot certify the affiliate book',async()=>{
 await setup();await redis.pipeline([['ZADD',`nl:ppsell:refunded:${SID}`,String(AT),ORDER],['DEL',`nl:ppsell:paid:${ORDER}`]]);
 const x=await observe('missing-paid-record');
 assert.equal(x.covered.partial,true);assert.equal(x.covered.rows.length,0);assert.equal(x.wrapped.length,0);
 assert.equal(x.book.refundsChecked,false,'partial refund coverage must not become a checked payable book');
 assert.equal(x.throughRefundGate,0);
});
test('the 501st healthy refund cannot be omitted from a checked payable book',async()=>{
 await setup();
 const commands:(string|number)[][]=[];
 for(let i=0;i<500;i++){
  const order=`7O190127TN3${String(i).padStart(6,'0')}`;
  commands.push(['SET',`nl:ppsell:paid:${order}`,JSON.stringify({...paid,order,capture:`8C679366HH${String(i).padStart(6,'0')}`,via:undefined})],['ZADD',`nl:ppsell:refunded:${SID}`,String(AT),order]);
 }
 commands.push(['ZADD',`nl:ppsell:refunded:${SID}`,String(AT+1),ORDER]);
 await redis.pipeline(commands);
 const x=await observe('501-healthy-refunds');
 assert.equal(x.covered.rows.length,500);assert.equal(x.covered.partial,true);assert.equal(x.covered.rows.some(r=>r.order===ORDER),false);
 assert.equal(x.book.refundsChecked,false,'a healthy LIMIT cut must not certify all refunds checked');
 assert.equal(x.throughRefundGate,0);
});
