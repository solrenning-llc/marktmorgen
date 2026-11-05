import {test} from 'node:test';
import assert from 'node:assert/strict';
import {saveLanding,readLandings,dropLandings} from '../lib/campaign-landing-store';
import {dataKey,dataUsed,needData} from '../lib/store-data';
import {dataBytes,contentRoomFor} from '../lib/store-data-rules';
import {store as redis} from './redis-stub';
import {ROOM} from './data-room';

const stats='g'.repeat(16),product='g-product';
const key=`nl:product:landing:${stats}:${product}`;
const room={...ROOM,sid:'g-landing-room'};
const landing=(campaign:string,headline='A practical cooking course',sub='Learn knife skills',button='See the course')=>({campaign,headline,sub,button});
const slot=()=>Number(redis.run(['HGET',dataKey(room)!,'al:'+product])??0);
const stored=()=>redis.run(['GET',key]);

test('G explicit empty GET remains a valid first save control',async()=>{
 redis.clear();assert.equal(await saveLanding(stats,product,landing('first'),room),'saved');
 assert.deepEqual(await readLandings(stats,product),[landing('first')]);
});
for(const shape of ['empty','undefined','malformed-json'] as const) {
 test(`G ${shape} read must not erase an already saved campaign`,async()=>{
  redis.clear();await saveLanding(stats,product,landing('existing'),room);
  const prior=stored(),pipeline=redis.pipeline;
  let intercepted=false;
  redis.pipeline=async commands=>{
   if(!intercepted&&commands.length===1&&commands[0][0]==='GET'&&commands[0][1]===key){
    intercepted=true;return shape==='empty'?[]:shape==='undefined'?[undefined]:['{broken'];
   }
   return pipeline(commands);
  };
  let outcome:unknown;
  try {outcome=await saveLanding(stats,product,landing('new'),room);}catch(e){outcome=e;}
  finally {redis.pipeline=pipeline;}
  assert.equal(intercepted,true);
  assert.equal(stored(),prior,`unconfirmed old record was overwritten; reported ${String(outcome)}`);
 });
}
test('G a SET with no confirmed application cannot report saved',async()=>{
 redis.clear();const pipeline=redis.pipeline;let intercepted=false;
 redis.pipeline=async commands=>{
  if(commands.some(c=>c[0]==='SET'&&c[1]===key)){intercepted=true;return [];}
  return pipeline(commands);
 };
 let outcome:unknown;try{outcome=await saveLanding(stats,product,landing('first'),room);}catch(e){outcome=e;}
 finally{redis.pipeline=pipeline;}
 assert.equal(intercepted,true);assert.equal(stored(),null);
 assert.notEqual(outcome,'saved','saved was returned while no landing was stored');
});
test('G unconfirmed DEL cannot free the charged room of a retained record',async()=>{
 redis.clear();await saveLanding(stats,product,landing('existing'),room);
 const prior=stored(),pipeline=redis.pipeline;let intercepted=false;
 redis.pipeline=async commands=>{
  if(commands.some(c=>c[0]==='DEL'&&c[1]===key)){intercepted=true;return [];}
  return pipeline(commands);
 };
 try{await dropLandings(stats,product,room);}catch{/* Retain conservative accounting on unknown. */}
 finally{redis.pipeline=pipeline;}
 assert.equal(intercepted,true);assert.equal(stored(),prior);
 assert.ok(slot()>=dataBytes([String(prior)],1),`stored record retained but charged slot=${slot()}`);
});
test('G a delayed large write cannot overwrite a newer small write after its reservation shrinks',async()=>{
 redis.clear();const pipeline=redis.pipeline;
 const big=landing('large','H'.repeat(120),'S'.repeat(300),'B'.repeat(40));
 let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 redis.pipeline=async commands=>{
  if(commands.some(c=>c[0]==='SET'&&c[1]===key&&String(c[2]).includes(big.headline))){enter();await gate;}
  return pipeline(commands);
 };
 let pending:Promise<unknown>|undefined;
 try{
  pending=saveLanding(stats,product,big,room);await entered;
  assert.equal(await saveLanding(stats,product,landing('small','Small','',''),room),'saved');
  const used=(await dataUsed(room))!.used,limit=contentRoomFor(room,Date.now()/1000);
  await needData(room,[{slot:'other-valid-content',bytes:limit-used-64,set:true}]);
  release();assert.equal(await pending,'saved');
  const raw=String(stored()),actual=dataBytes([raw],1),charged=slot();
  assert.ok(actual<=charged,`valid stored bytes ${actual} exceed slot ${charged}; total already fills ${limit}`);
 }finally{release();if(pending)await pending;redis.pipeline=pipeline;}
});
