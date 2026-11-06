import {takeLock,holdLock,setIfHeld,deleteIfHeldOnly} from '@/lib/redis-lock';
import {store as redis} from './redis-stub';
import {done,is} from './check';
async function main(){
 for(const mode of ['extra','accessor','inherited']){
 redis.clear();const held=await takeLock('g:lease',1,100);const clock=Date.now;Date.now=()=>clock()+1001;
 await redis.pipeline([['SET',held.key,'legitimate-successor','NX','EX',300],['SET','g:target','before']]);
 const real=redis.pipeline.bind(redis);let getters=0,evals=0;
 redis.pipeline=async commands=>{if(commands[0]?.[0]==='EVAL'){
 evals++;if(mode==='extra')return [1,0];
 const reply:unknown[]=Array(1);
 if(mode==='accessor')Object.defineProperty(reply,'0',{get(){getters++;return 1;}});
 else Object.setPrototypeOf(reply,Object.assign(Object.create(Array.prototype),{'0':1}));
 return reply;
 }return real(commands)};
 let kept=false,wrote=false,gone=false;
 try{kept=await holdLock(held);wrote=await setIfHeld(held,'g:target','after');gone=await deleteIfHeldOnly(held,['g:target']);}finally{redis.pipeline=real;Date.now=clock;}
 console.log('G_LOCK_ENVELOPE',JSON.stringify({mode,evals,kept,wrote,gone,getters,owner:redis.run(['GET',held.key]),target:redis.run(['GET','g:target'])}));
 is(mode+': exactly three actual script boundaries reached',evals,3);
 is(mode+': unknown receipt cannot confirm lease held by successor',kept,false);
 is(mode+': unknown receipt cannot confirm unwritten record',wrote,false);
 is(mode+': unknown receipt cannot confirm unapplied deletion',gone,false);
 is(mode+': no getter invoked',getters,0);
 is(mode+': actual successor and record unchanged',[redis.run(['GET',held.key]),redis.run(['GET','g:target'])],['legitimate-successor','before']);
 }
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1});
