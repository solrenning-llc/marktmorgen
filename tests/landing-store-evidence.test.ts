// Codex G2's proof on PR #1947 (branch codex/g2-review-1947-landing-boundaries-red, ad5734a50), kept as permanent tests:
// a partly unreadable record never authorizes a save to drop entries, an unconfirmed delete never resolves as done,
// and a save that started before the page was dropped never recreates its landings.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {saveLanding,dropLandings,readLandings,DROP_LANDINGS,WRITE_LANDINGS} from '@/lib/campaign-landing-store';
import {dropPage} from '@/lib/sales-page-store';import {dataKey} from '@/lib/store-data';
import {store as redis} from './redis-stub';import {ROOM} from './data-room';
const stats='G2LandingBoundary',product='g2-landing',room={...ROOM,sid:'g2-landing-boundary-room'},key=`nl:product:landing:${stats}:${product}`;
const landing=(campaign:string)=>({campaign,headline:'Known headline',sub:'Known subheading',button:'Read more'});
globalThis.fetch=async()=>{throw Error('No external services in G2 review');};
test('control: a valid campaign survives another save and a confirmed deletion removes all',async()=>{
 redis.clear();await saveLanding(stats,product,landing('original'),room);await saveLanding(stats,product,landing('next'),room);
 assert.deepEqual((await readLandings(stats,product)).map(x=>x.campaign),['original','next']);await dropLandings(stats,product,room);assert.equal(redis.run(['GET',key]),null);
});
test('a malformed campaign inside a JSON array is not permission to discard it on the next save',async()=>{
 redis.clear();await saveLanding(stats,product,landing('original'),room);
 const raw=JSON.stringify([landing('original'),{...landing('unconfirmed-existing'),sub:null}]);await redis.pipeline([['SET',key,raw]]);
 let outcome:unknown;try{outcome=await saveLanding(stats,product,landing('new'),room);}catch(e){outcome=e;}
 console.log('G2_PARTIAL_LANDING',JSON.stringify({outcome:String(outcome),before:raw,after:redis.run(['GET',key])}));
 assert.equal(redis.run(['GET',key]),raw,'the save erased a pre-existing campaign it could not confirm');assert.notEqual(outcome,'saved');
});
for(const throughPage of [false,true])test('an unapplied unknown delete must not report completed cleanup '+String(throughPage),async()=>{
 redis.clear();await saveLanding(stats,product,landing('original'),room);const base=redis.pipeline.bind(redis);let reached=false;
 redis.pipeline=async batch=>{if(batch.some(c=>c[0]==='EVAL'&&c[1]===DROP_LANDINGS)){reached=true;return [];}return base(batch);};
 try{
  let completed=false;try{if(throughPage)await dropPage(stats,product,room);else await dropLandings(stats,product,room);completed=true;}catch{}
  assert.equal(reached,true);assert.equal(typeof redis.run(['GET',key]),'string');
  console.log('G2_DROP_ACK',JSON.stringify({throughPage,completed,recordRetained:true}));assert.equal(completed,false,'the deletion resolved successfully with its campaign record still present');
 }finally{redis.pipeline=base;}
});
test('an older save must not recreate campaign data after the page deletion completes',async()=>{
 redis.clear();await saveLanding(stats,product,landing('original'),room);const base=redis.pipeline.bind(redis);let held=false;let arrived!:()=>void,release!:()=>void;
 const seen=new Promise<void>(r=>arrived=r),gate=new Promise<void>(r=>release=r);
 redis.pipeline=async batch=>{if(!held&&batch.some(c=>c[0]==='EVAL'&&c[1]===WRITE_LANDINGS)){held=true;arrived();await gate;}return base(batch);};
 let pending:Promise<unknown>|undefined;
 try{
  pending=saveLanding(stats,product,landing('stale-request'),room).catch(e=>e);await seen;
  await dropPage(stats,product,room);assert.equal(redis.run(['GET',key]),null,'the real deletion completed');
  release();const result=await pending;console.log('G2_LANDING_RESURRECTION',JSON.stringify({result:String(result),record:redis.run(['GET',key]),slot:redis.run(['HGET',dataKey(room)!,'al:'+product])}));
  assert.equal(redis.run(['GET',key]),null,'the older request recreated campaign data after deletion');
 }finally{release();if(pending)await pending;redis.pipeline=base;}
});
