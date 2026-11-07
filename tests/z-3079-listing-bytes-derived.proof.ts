import { readSetup } from '@/lib/call-setup';
import { parseProduct, productWrites, readListingsBatched, LISTINGS_PER_MGET, MAX_PRODUCT_BYTES, type Listing } from '@/lib/catalog';
import type { Store } from '@/lib/store';
import { LISTING_READ_BYTES } from '@/lib/read-ceilings';
import { store as redis } from './redis-stub';
import { done, is } from './check';
async function main(){
 redis.clear();
 const catalog='c'.repeat(32);
 const now=Math.ceil(Date.now()/60000)*60000;
 const room='https://example.com/'+ 'a'.repeat(480);
 const call=readSetup({kind:'live',tz:'UTC',noticeHours:0,sessions:Array.from({length:50},(_,i)=>({id:`session${String(i).padStart(5,'0')}`,start:now+(i+1)*86400000,minutes:30,seats:10,room}))});
 if(typeof call==='string')throw Error('invalid setup '+call);
 const listings:Listing[]=[];const raws:string[]=[];
 for(let i=0;i<50;i++){
  const p=parseProduct({id:`call${String(i).padStart(5,'0')}`,title:'Valid dated calls',priceCents:5000,call});
  if(!p?.call || p.call.sessions.length!==50)throw Error('invalid product');
  const writes=productWrites(catalog,p);
  for(const c of writes)redis.run(c);
  raws.push(String(writes[0][2]));listings.push(p);
 }
 const store={catalog:{id:catalog,head:[],items:listings.map(p=>({id:p.id,kind:8}))}} as unknown as Store;
 const pipe=redis.pipeline.bind(redis);let wireBytes=0;let mgets=0;
 redis.pipeline=async commands=>{const reply=await pipe(commands);if(commands[0]?.[0]==='MGET'){mgets++;wireBytes=Math.max(wireBytes,Buffer.byteLength(JSON.stringify([{result:reply[0]}])));}return reply;};
 const values=await readListingsBatched(store,listings.map(p=>p.id));
 is('healthy writer accepted all valid 50-session call products, and batched reader returns all50',[values.length,values.every(p=>p.call?.sessions.length===50),mgets],[50,true,Math.ceil(50/LISTINGS_PER_MGET)]);
 const raw=raws.reduce((n,r)=>n+Buffer.byteLength(r),0);
 console.log('OBSERVED_BYTES',JSON.stringify({perListing:Buffer.byteLength(raws[0]),rawBatch:raw,restJSONBytes:wireBytes,pricedBatch:LISTINGS_PER_MGET*LISTING_READ_BYTES,claimedReplyCeiling:1048576}));
 is('valid stored listing bytes fit the writer cap for50 products',raw<=50*MAX_PRODUCT_BYTES,true);
 is('real returned50-key MGET JSON fits the PR one-MiB claim before any check',wireBytes<=1048576,true);
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
