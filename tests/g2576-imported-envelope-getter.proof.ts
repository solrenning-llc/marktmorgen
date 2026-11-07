import {grantImported,importedKey} from '@/lib/imported-purchases';
import {dataUsed} from '@/lib/store-data';
import {ROOM} from './data-room';
import {store as redis} from './redis-stub';
import {done,is} from './check';
let commands=0,fetches=0,reads=0,injections=0;
globalThis.fetch=async()=>{fetches++;throw Error('No external request');};
const raw=redis.pipeline.bind(redis);
const counted:typeof redis.pipeline=async cs=>{commands+=cs.length;if(commands>200)throw Error('Synthetic ceiling');return raw(cs);};
async function main(){
 redis.clear();redis.pipeline=counted;
 try{
  const sid='g-imported-proof',pid='synthetic-product';
  const initial=(await dataUsed(ROOM))!.used;
  is('healthy grant is written',await grantImported(sid,'api:proof',[{email:'healthy@example.test',productId:pid,items:null}],1800000000,'',ROOM),[true]);
  const before=(await dataUsed(ROOM))!.used;
  is('healthy grant takes room',before>initial,true);
  redis.pipeline=async cs=>{
   const replies=await counted(cs);
   if(cs.length===1&&cs[0][0]==='HSETNX'&&cs[0][1]===importedKey(sid,'changed@example.test')){
    injections++;const answer=Array(1);
    Object.defineProperty(answer,'0',{get(){reads++;return reads===1?0:1;}});
    return answer;
   }
   return replies;
  };
  const outcome=await grantImported(sid,'api:proof',[{email:'changed@example.test',productId:pid,items:null}],1800000000,'',ROOM).catch(e=>e.name);
  redis.pipeline=counted;
  const after=(await dataUsed(ROOM))!.used;
  const [kept]=await counted([['HEXISTS',importedKey(sid,'changed@example.test'),pid]]);
  is('one applied write response replaced',injections,1);
  is('new grant still exists',kept,1);
  is('kept new grant remains counted',after>before,true);
  is('an executable reply slot is never read',reads,0);
  is('no outside request',fetches,0);
  console.log('G_IMPORTED_GETTER',JSON.stringify({before,after,outcome,kept,reads,injections,commands,fetches}));done();
 }finally{redis.pipeline=raw;}
}
void main();
