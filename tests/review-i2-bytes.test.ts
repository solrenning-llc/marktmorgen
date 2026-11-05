import assert from 'node:assert/strict';
import {index,INDEXED_WORDS_BYTES,MAX_INDEXED_WORDS,indexedWords} from '@/lib/community-search';
import {walkUnits} from '@/lib/community-read-rules';
import {store as redis} from './redis-stub';
async function main(){
 redis.clear();const original=redis.pipeline;let readers=0;let resume!:()=>void;const barrier=new Promise<void>(r=>{resume=r;});
 redis.pipeline=async commands=>{const result=await original.call(redis,commands);if(commands[0]?.[0]==='SMEMBERS'&&String(commands[0][1]).endsWith(':wie:same')){if(++readers===3)resume();await barrier;}return result;};
 try {await Promise.all(Array.from({length:3},(_,writer)=>index('reviewbytes','event','same',1,Array.from({length:MAX_INDEXED_WORDS},(_,i)=>(`writer${writer}word${i}`).padEnd(24,'x')))));}finally{redis.pipeline=original;}
 const snapshot=(await indexedWords('reviewbytes','event',['same']))!;
 const bytes=Buffer.byteLength(JSON.stringify(snapshot[0]));
 console.log(JSON.stringify({readers,words:snapshot[0].length,bytes,prepaid:INDEXED_WORDS_BYTES,paidBatchUnits:walkUnits(50,50*INDEXED_WORDS_BYTES),neededBatchUnits:walkUnits(50,50*bytes)}));
 assert.ok(bytes<=INDEXED_WORDS_BYTES,'concurrent real index writes must fit the prepaid SMEMBERS envelope');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
