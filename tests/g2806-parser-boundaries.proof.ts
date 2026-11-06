import {repliesFor}from '@/lib/redis-reply';import {holdLock,deleteIfHeldOnly,releaseLock,setIfHeld,takeLock}from '@/lib/redis-lock';import {store as redis}from './redis-stub';import{is,done}from './check';
async function main(){
 const source=[1,2];const copy=repliesFor(source,2);source[0]=9;is('plain copy keeps first snapshot',copy,[1,2]);is('copy identity separate',copy===source,false);
 for(const value of [null,{},[],Array(1),[1,0]])is('unknown shape stays unknown',repliesFor(value,1),null);
 let called=0;const own:unknown[]=Array(1);Object.defineProperty(own,'0',{get(){called++;throw Error('getter')}});is('throwing getter refused unread',repliesFor(own,1),null);is('getter never called',called,0);
 redis.clear();const held=await takeLock('g:proxy',5,0),real=redis.pipeline.bind(redis);let evals=0,other=0;
 const revoked=Proxy.revocable([1],{});revoked.revoke();const throwing=new Proxy([1],{getOwnPropertyDescriptor(){throw Error('descriptor unavailable')}});
 for(const value of [revoked.proxy,throwing]){
 redis.pipeline=async c=>{if(c[0]?.[0]==='EVAL'){evals++;return value;}other++;return real(c);};
 try{is('unreadable proxy cannot confirm hold',await holdLock(held),false);is('unreadable proxy cannot confirm write',await setIfHeld(held,'g:v','x'),false);is('unreadable proxy cannot confirm delete',await deleteIfHeldOnly(held,['g:v']),false);await releaseLock(held);}
 finally{redis.pipeline=real;}
 }
 is('all four script boundaries for both proxies',evals,8);is('no separate fallback command',other,0);is('actual held key retained',redis.run(['GET',held.key]),held.token);done();
}void main();
