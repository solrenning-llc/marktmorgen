/** Read-only S review: actual catalog serializer + bounded synthetic transport; no provider is contacted. */
import assert from 'node:assert/strict';
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, storeForEmail, type Store } from '@/lib/store';
import { KIND, parseProduct, productWrites } from '@/lib/catalog';
import { readSetup, MAX_SESSIONS, MAX_ROOM_LENGTH, SESSION_LENGTHS } from '@/lib/call-setup';
import { salesCsv } from '@/lib/stats';
import { store as redis } from './redis-stub';
process.env.NIMBUS_DATA_KEY='a-local-key-for-tests-only-0123456789abcdef';
process.env.STRIPE_SECRET_KEY='sk_test_s3101_synthetic_only';
const count=500, limit=10*1024*1024;
const ids=Array.from({length:count},(_,i)=>`p${String(i).padStart(5,'0')}`);
const rows=ids.map((id,i)=>({id:`cs_s3101_${i}`,object:'checkout.session',status:'complete',payment_status:'paid',mode:'payment',created:1791417600-i,amount_total:1000,currency:'usd',metadata:{store:'sbytes3101',product:id,title:`Class ${i}`,kind:'call'}}));
globalThis.fetch=(async(input:string|URL|Request)=>{const u=new URL(String(input));if(u.pathname!=='/v1/checkout/sessions')return new Response(JSON.stringify({object:'list',data:[],has_more:false}));const after=u.searchParams.get('starting_after');const from=after?rows.findIndex(r=>r.id===after)+1:0;return new Response(JSON.stringify({object:'list',data:rows.slice(from,from+100),has_more:from+100<rows.length}));}) as typeof fetch;
async function main(){
 redis.clear();await claimHandle('sbytes3101@example.test','sbytes3101','Byte-bound review','');await ensureStatsId('sbytes3101@example.test');await setStripeAccount('sbytes3101@example.test','acct_1SBytes3101',true);
 const added=await addProduct('sbytes3101@example.test','Class','', '10',null);assert(added.ok);
 const base=(await storeForEmail('sbytes3101@example.test'))!,catalog=base.catalog.id!;
 const [raw]=await redis.pipeline([['GET',`nl:catalog:${catalog}:l:${added.product.id}`]]);
 const room='https://example.test/'+ 'r'.repeat(MAX_ROOM_LENGTH-'https://example.test/'.length);
 const call=readSetup({kind:'live',tz:'UTC',noticeHours:0,sessions:Array.from({length:MAX_SESSIONS},(_,i)=>({id:`s${String(i).padStart(10,'0')}`,start:1893456000000+i*86400000,minutes:SESSION_LENGTHS[0],seats:1,room}))});assert.equal(typeof call,'object');
 const writes=ids.flatMap((id,i)=>{const p=parseProduct({...JSON.parse(String(raw)),id,title:`Class ${i}`,call,fields:[],funnel:null});assert(p);assert.equal(p.call?.sessions.length,50);return productWrites(catalog,p);});
 await redis.pipeline(writes);
 const store:Store={...base,catalog:{...base.catalog,head:[],items:ids.map(id=>({id,kind:KIND.paid|KIND.call,options:[]}))}};
 const original=redis.pipeline;let largest=0,productReads=0;
 redis.pipeline=(async commands=>{const answer=await original.call(redis,commands);if(commands.some(c=>(c[0]==='MGET'||c[0]==='GET')&&c.slice(1).some(k=>String(k).startsWith(`nl:catalog:${catalog}:l:`)))){productReads++;const bytes=Buffer.byteLength(JSON.stringify(answer.map(result=>({result}))));largest=Math.max(largest,bytes);if(bytes>limit)throw Error(`synthetic transport: ${bytes} response bytes exceed ${limit}`);}return answer;}) as typeof redis.pipeline;
 let got:Awaited<ReturnType<typeof salesCsv>>|undefined,failure='';try{got=await salesCsv(store,0);}catch(e){failure=String(e);}finally{redis.pipeline=original;}
 console.log('S_BATCH_BYTES',JSON.stringify({products:count,sessionsPerProduct:50,roomCharacters:room.length,serializedListingBytes:Buffer.byteLength(String(writes[0][2])),largestResponseBytes:largest,syntheticLimitBytes:limit,productReads,rows:got?.rows,failure}));
 assert.equal(failure,'','a catalog accepted by productWrites must still export');assert.equal(got?.rows,count);assert.equal(got?.partial,false);assert(got?.csv.includes('Class 499'));console.log('4 checks, all passing.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
