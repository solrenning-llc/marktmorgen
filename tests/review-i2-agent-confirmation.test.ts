/** Independent review: real proposal/store operations and synthetic Redis replies. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {addProduct,claimHandle,ensureStatsId,setProductTitle,setSubscription,storeForEmail} from '@/lib/store';
import {readListing} from '@/lib/catalog';
import {proposeTitle,proposeSummary} from '@/lib/agent-propose';
import {confirmFor} from '@/lib/agent-confirm';
import {readBook} from '@/lib/agent-book';
import {store as redis} from './redis-stub';
import {paidPeriod} from './billing-period-fixture';

async function setup(){
 redis.clear();await claimHandle('proposal-review@example.test','reviewproposal','Synthetic shop','');
 await ensureStatsId('proposal-review@example.test');
 await setSubscription('proposal-review@example.test',{customerId:'cus_ReviewProposal0001',subscriptionId:'sub_ReviewProposal0001',active:true,period:paidPeriod()});
 const made=await addProduct('proposal-review@example.test','Original title','Original summary','29',null);if(!made.ok)throw Error('Synthetic product refused');
 const shop=(await storeForEmail('proposal-review@example.test'))!;
 return {shop,product:made.product.id,owner:'proposal-review@example.test',book:'nl:agent:book:'+shop.statsId};
}
for(const reply of [[],[undefined]])test('partial book read cannot erase a different waiting proposal: '+reply.length,async()=>{
 const {shop,product,book}=await setup();const first=await proposeTitle(shop,'review-key',{product,title:'Suggested title'});assert.equal(first.isError,false);
 const id=JSON.parse(first.content[0].text).proposal,base=redis.pipeline.bind(redis);let faults=0;
 try{
  redis.pipeline=async commands=>{if(commands.length===1&&commands[0][0]==='GET'&&commands[0][1]===book&&faults++===0)return reply;return base(commands);};
  const second=await proposeSummary(shop,'review-key',{product,summary:'Suggested summary'});console.log(JSON.stringify({case:'partial-read',reply,second}));
 }finally{redis.pipeline=base;}
 assert.equal((await readBook(shop.statsId!)).waiting.some(p=>p.id===id),true,'an unconfirmed read cannot erase existing waiting work');
});
test('a book write without acknowledgement cannot be reported as a kept proposal',async()=>{
 const {shop,product,book}=await setup(),base=redis.pipeline.bind(redis);let result;
 try{
  // The book is written in one step only while its lock is held (lib/agent-book.ts AGENT_BOOK_WRITE, #1856): that write is matched too.
  redis.pipeline=async commands=>{if(commands.length===1&&((commands[0][0]==='SET'&&commands[0][1]===book)||(commands[0][0]==='EVAL'&&String(commands[0][1]).startsWith('-- marktmorgen:agent-book-write:')&&commands[0][4]===book)))return [];return base(commands);};
  result=await proposeTitle(shop,'review-key',{product,title:'Suggested title'});
 }finally{redis.pipeline=base;}
 assert.equal((await readBook(shop.statsId!)).waiting.length,0,'the intercepted write was not applied');
 assert.equal(result.isError,true,'the caller cannot confirm a proposal which was never kept');
});
test('a real product edit between snapshot and book lock is not overwritten by confirmation',async()=>{
 const {shop,product,book,owner}=await setup();const proposal=await proposeTitle(shop,'review-key',{product,title:'Suggested title'});
 const id=JSON.parse(proposal.content[0].text).proposal,base=redis.pipeline.bind(redis);let edited=false;
 try{
  redis.pipeline=async commands=>{
   if(commands.length===1&&commands[0][0]==='SET'&&commands[0][1]===book.replace('book:','book:lock:')&&!edited){edited=true;assert.equal((await setProductTitle(owner,product,'Concurrent creator edit')).ok,true);}
   return base(commands);
  };
  const result=await confirmFor({...shop,statsId:shop.statsId!},owner,[id],owner);console.log(JSON.stringify({case:'concurrent-edit',edited,result}));
 }finally{redis.pipeline=base;}
 assert.equal(edited,true,'the writer barrier was reached');
 assert.equal((await readListing((await storeForEmail(owner))!,product))?.title,'Concurrent creator edit','confirmation must compare against the current field, not the stale pre-lock snapshot');
});
