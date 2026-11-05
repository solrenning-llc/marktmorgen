import assert from 'node:assert/strict';
import {claimHandle,ensureStatsId,setCommunity,setSubscription} from '@/lib/store';
import {createEvent} from '@/lib/community-events';
import {walkCommunity,needsWalk} from '@/lib/community-walk';
import {index} from '@/lib/community-search';
import {searchedConversations} from '@/lib/community-dm';
import {WALK_COMMANDS_PER_UNIT} from '@/lib/community-read-rules';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';
async function main(){
redis.clear();process.env.UPSTASH_REDIS_REST_URL??='http://stub';
const email='i2-review@example.test';await claimHandle(email,'i2-review','Review','');await ensureStatsId(email);
await setSubscription(email,{customerId:'cus_i2review',subscriptionId:'sub_i2review',active:true,tier:'pro',period:paidPeriod()});
const club=(await setCommunity(email,true))!,id=club.community!.id;
for(let i=0;i<2;i++)assert.equal((await createEvent(club,{title:'Bread '+i,about:'Rye and sourdough',start:Date.now()+86400000*(i+1),minutes:60,tz:'UTC',cap:0,where:'room',link:'',meet:null,only:[]})).ok,true);
const original=redis.pipeline,eventKey=new RegExp(`^nl:cm:${id}:wie:(.+)$`);
let failures=0,checks=0;
const check=(label:string,actual:unknown,expected:unknown)=>{checks++;try{assert.deepEqual(actual,expected);console.log('PASS '+label);}catch{failures++;console.log('FAIL '+label+' '+JSON.stringify({actual,expected}));}};
async function measured(raw:unknown,partial=false,race=false){
 await original.call(redis, [['DEL',`nl:cm:${id}:sv`]]);
 let sent=0,allow=3,over=0,writes=0,inserted=false,inside=false,indexReads=0;
 redis.pipeline=async commands=>{
  if(inside)return original.call(redis,commands);
  sent+=commands.length;over=Math.max(over,sent-allow);writes+=commands.filter(c=>['ZADD','ZREM','SADD','SREM'].includes(String(c[0]))).length;
  const replies=await original.call(redis,commands);
  const at=commands.findIndex(c=>['SCARD','SMEMBERS'].includes(String(c[0]))&&eventKey.test(String(c[1])));
  if(at>=0){indexReads++;
   if(race&&!inserted){inserted=true;inside=true;await index(id,'event',eventKey.exec(String(commands[at][1]))![1],1,Array.from({length:600},(_,i)=>`concurrent${i}x`));inside=false;}
   if(!race){if(partial)return replies.slice(0,Math.max(0,at));replies[at]=raw;}
  }
  return replies;
 };
 let result:unknown;
 try{result=await walkCommunity(club,async units=>{sent=0;allow=units*WALK_COMMANDS_PER_UNIT+2;return true;});}catch{result='threw';}finally{redis.pipeline=original;}
 return {result,over,writes,still:await needsWalk(id),indexReads,inserted};
}
for(const raw of [null,undefined,false,0,'',{},['word',null]]){
 const result=await measured(raw);check('unreadable index reply stops without writes '+JSON.stringify(raw),[result.result,result.writes,result.still,result.over],[false,0,true,0]);
}
const partial=await measured(null,true);check('partial reply remains unknown',[partial.result,partial.writes,partial.still,partial.over],[false,0,true,0]);
const race=await measured(null,false,true);check('concurrent index write stays within prior payment',[race.result,race.over,race.still,race.inserted],[true,0,false,true]);
for(const raw of [null,undefined,false,'',-1,NaN,Infinity,{},'bad']){
 redis.pipeline=async commands=>commands[0]?.[0]==='ZCARD'?[raw]:original.call(redis,commands);
 try{check('unreadable inbox count is null '+String(raw),await searchedConversations(id,'person'),null);}finally{redis.pipeline=original;}
}
check('real empty inbox is zero',await searchedConversations(id,'person'),0);
console.log(JSON.stringify({checks,failures}));process.exitCode=failures?1:0;

}
main().catch(error=>{console.error(error);process.exitCode=1;});
