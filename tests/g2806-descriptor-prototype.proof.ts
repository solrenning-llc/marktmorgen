import { takeLock, holdLock, setIfHeld, deleteIfHeldOnly } from '@/lib/redis-lock';
import { repliesFor } from '@/lib/redis-reply';
import {store as redis} from './redis-stub';import {is,done}from './check';
async function main(){
 redis.clear(); const h=await takeLock('g:pollution',1,100);const clock=Date.now;Date.now=()=>clock()+1001;
 await redis.pipeline([['SET',h.key,'next','NX','EX',300],['SET','g:record','before']]);
 const real=redis.pipeline.bind(redis);let calls=0;const reply:unknown[]=Array(1);Object.defineProperty(reply,'0',{get(){calls++;return 1;}});
 redis.pipeline=async c=>c[0]?.[0]==='EVAL'?reply:real(c);
 let renewed=false,written=false,deleted=false,parsed:unknown=null;
 const prior=Object.getOwnPropertyDescriptor(Object.prototype,'value');
 try{Object.defineProperty(Object.prototype,'value',{value:1,configurable:true});parsed=repliesFor(reply,1);renewed=await holdLock(h);written=await setIfHeld(h,'g:record','after');deleted=await deleteIfHeldOnly(h,['g:record']);}
 finally{if(prior)Object.defineProperty(Object.prototype,'value',prior);else Reflect.deleteProperty(Object.prototype,'value');redis.pipeline=real;Date.now=clock;}
 console.log('DESCRIPTOR_PROTOTYPE',JSON.stringify({parsed,renewed,written,deleted,calls,owner:redis.run(['GET',h.key]),record:redis.run(['GET','g:record'])}));
 is('accessor descriptor cannot inherit data value from Object.prototype',parsed,null);
 is('unknown polluted receipt does not confirm renew',renewed,false);is('unknown polluted receipt does not confirm write',written,false);is('unknown polluted receipt does not confirm delete',deleted,false);
 is('getter stays uncalled',calls,0);is('actual successor and record survive',[redis.run(['GET',h.key]),redis.run(['GET','g:record'])],['next','before']);done();
}void main();
