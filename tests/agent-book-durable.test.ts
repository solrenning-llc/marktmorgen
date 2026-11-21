/**
 * The agent book is written only while its writer holds the store's lock, in one step
 * (lib/agent-book.ts AGENT_BOOK_WRITE), and a change already carried out whose book
 * write is not confirmed is written again on the book as it is now (recordAgain).
 * Codex G's schedules on #1856 (tests/g-1856-book-effects.proof.ts), with the failure
 * put on the book's write as it is now made: the EVAL of agent-book-write.
 * Synthetic only, through the real confirmation and undo.
 */
import { addProduct, claimHandle, ensureStatsId, setProductAbout, setSubscription, storeForEmail } from "@/lib/store";
import { readAbout, writeAbout } from "@/lib/product-about";
import { proposeDescription } from "@/lib/agent-propose";
import { confirmFor, undoFor } from "@/lib/agent-confirm";
import { readBook, undoDone } from "@/lib/agent-book";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
let serial=0;
const base=redis.pipeline.bind(redis);
async function fixture(two=false,before=(id:string)=>"Original "+id){
 redis.clear();serial++;
 const owner=`gagent${serial}@example.test`,handle=`gagent${serial}`;
 await claimHandle(owner,handle,"Agent Review","");await ensureStatsId(owner);
 await setSubscription(owner,{customerId:"cus_GAgent0000001",subscriptionId:"sub_GAgent0000001",active:true,period:paidPeriod()});
 const a=await addProduct(owner,"Guide A","A guide.","29",null);
 if(!a.ok)throw Error("synthetic A missing");
 const ids=[a.product.id];
 if(two){const b=await addProduct(owner,"Guide B","Another guide.","29",null);if(!b.ok)throw Error("synthetic B missing");ids.push(b.product.id);}
 const store=(await storeForEmail(owner))!;if(!store.statsId)throw Error("no stats id");
 const statsId=store.statsId;
 for(const id of ids){const marked=await setProductAbout(owner,id,true);if(!marked.ok)throw Error("mark missing");await writeAbout(statsId,id,before(id),marked.store);}
 const proposals:string[]=[];
 for(const id of ids){const r=await proposeDescription((await storeForEmail(owner))!,"key-g",{product:id,description:"Agent "+id});const p=JSON.parse(r.content[0].text).proposal;if(typeof p!=="string")throw Error("proposal missing");proposals.push(p);}
 const fresh={...(await storeForEmail(owner))!,statsId};
 return{owner,store:fresh,statsId,ids,proposals,book:`nl:agent:book:${statsId}`,lock:`nl:agent:book:lock:${statsId}`};
}
async function outcome<T>(fn:()=>Promise<T>){try{return{value:await fn(),error:""};}catch(e){return{value:null,error:e instanceof Error?e.name:"unknown"};}}
const isBookWrite=(commands:(string|number)[][],book:string)=>commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).startsWith("-- marktmorgen:agent-book-write:v1")&&commands[0][4]===book;
async function main(){
 part("Normal product confirmation and undo keep their history");
 {
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];
  const r=await confirmFor(f.store,f.owner,[p],f.owner);
  is("confirmation: effect and history agree",[r.done,await readAbout(f.statsId,id),(await readBook(f.statsId)).history.map(x=>x.id)],[[p],"Agent "+id,[p]]);
  const u=await undoFor(f.store,f.owner,p,f.owner);
  is("undo: effect and history agree",[u,await readAbout(f.statsId,id),Boolean((await readBook(f.statsId)).history[0].undone)],[{ok:true},"Original "+id,true]);
 }
 for(const mode of ["throw-before","empty-before","empty-after","zero-before"] as const){
  part("A confirmation whose book write is not confirmed is recorded again: "+mode);
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];let injected=0;
  redis.pipeline=(async commands=>{
   if(injected===0&&isBookWrite(commands,f.book)){injected++;if(mode==="throw-before")throw Error("book write failed");if(mode==="zero-before")return[0];if(mode==="empty-after")await base(commands);return[];}
   return base(commands);
  }) as typeof redis.pipeline;
  let r:Awaited<ReturnType<typeof outcome>>;
  try{r=await outcome(()=>confirmFor(f.store,f.owner,[p],f.owner));}finally{redis.pipeline=base;}
  const value=await readAbout(f.statsId,id),book=await readBook(f.statsId);
  is(mode+": the book write was reached once",injected,1);
  is(mode+": the change is applied and in the history, once, and no longer waiting",[r.error,value,book.history.filter(x=>x.id===p).length,book.waiting.some(x=>x.id===p)],["","Agent "+id,1,false]);
 }
 part("An undo is marked in the history before anything is put back: a mark that cannot be written puts nothing back");
 for(const mode of ["throw","zero","empty"] as const){
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];await confirmFor(f.store,f.owner,[p],f.owner);let injected=0;
  redis.pipeline=(async commands=>{if(injected===0&&isBookWrite(commands,f.book)){injected++;if(mode==="throw")throw Error("undo book write failed");return mode==="zero"?[0]:[];}return base(commands);}) as typeof redis.pipeline;
  let u:Awaited<ReturnType<typeof outcome>>;
  try{u=await outcome(()=>undoFor(f.store,f.owner,p,f.owner));}finally{redis.pipeline=base;}
  is(mode+": the mark's write was reached once, and nothing written after it",injected,1);
  is(mode+": nothing put back and the history does not say undone",[u.error===""&&(u.value as {ok:boolean}|null)?.ok===true,await readAbout(f.statsId,id),Boolean((await readBook(f.statsId)).history.find(x=>x.id===p)?.undone)],[false,"Agent "+id,false]);
  const again=await outcome(()=>undoFor(f.store,f.owner,p,f.owner));
  is(mode+": tried again, it is put back and marked undone",[(again.value as {ok:boolean}|null)?.ok===true,await readAbout(f.statsId,id),Boolean((await readBook(f.statsId)).history.find(x=>x.id===p)?.undone)],[true,"Original "+id,true]);
 }
 part("A restore whose answer is lost: what the store holds decides, and a made restore keeps its mark");
 for(const mode of ["empty-after","throw-after","throw-before"] as const){
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];await confirmFor(f.store,f.owner,[p],f.owner);let injected=0;
  redis.pipeline=(async commands=>{
   if(injected===0&&commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).startsWith("-- marktmorgen:about-write-if:")){injected++;if(mode==="throw-before")throw Error("lost before");await base(commands);if(mode==="throw-after")throw Error("lost after");return[];}
   return base(commands);
  }) as typeof redis.pipeline;
  let u:Awaited<ReturnType<typeof outcome>>;
  try{u=await outcome(()=>undoFor(f.store,f.owner,p,f.owner));}finally{redis.pipeline=base;}
  const value=await readAbout(f.statsId,id),undone=Boolean((await readBook(f.statsId)).history.find(x=>x.id===p)?.undone);
  is(mode+": the restore's write was reached once",injected,1);
  is(mode+": the history says undone exactly when the text was put back",[value==="Original "+id,undone],mode==="throw-before"?[false,false]:[true,true]);
  is(mode+": answered as the store holds it",(u.value as {ok:boolean}|null)?.ok===true,mode!=="throw-before");
 }
 part("A lost restore read back in an unknown shape is never taken for a value, the description before it empty or not");
 for(const [shape,empty] of [[[],false],[[17],false],[[{}],false],[[],true],[[17],true],[[{}],true]] as [unknown[],boolean][]){
  const f=await fixture(false,empty?()=>"":undefined),p=f.proposals[0],id=f.ids[0];await confirmFor(f.store,f.owner,[p],f.owner);let wrote=0,read=0;
  const about=`nl:product:about:${f.statsId}:${id}`;
  redis.pipeline=(async commands=>{
   const c=commands[0];
   if(wrote===0&&commands.length===1&&c[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:about-write-if:")){wrote++;throw Error("refused before");}
   if(wrote===1&&read===0&&commands.length===1&&c[0]==="GET"&&c[1]===about){read++;return shape;}
   return base(commands);
  }) as typeof redis.pipeline;
  let u:Awaited<ReturnType<typeof outcome>>;
  try{u=await outcome(()=>undoFor(f.store,f.owner,p,f.owner));}finally{redis.pipeline=base;}
  is(`${empty?"empty before, ":""}read back as ${JSON.stringify(shape)}: never answered done; the mark kept, said as not confirmed; the text unchanged`,[read,u.error,(u.value as {ok:boolean}|null)?.ok===true,Boolean((await readBook(f.statsId)).history.find(x=>x.id===p)?.undone),await readAbout(f.statsId,id)],[1,"BookWriteUnconfirmed",false,true,"Agent "+id]);
 }
 part("A restore whose outcome stays unknown keeps the mark and is said as not confirmed");
 {
  const f=await fixture(),p=f.proposals[0];await confirmFor(f.store,f.owner,[p],f.owner);
  const u=await outcome(()=>undoDone(f.store,p,()=>"Agent "+f.ids[0],async()=>{throw Error("unknown");},f.owner));
  is("not confirmed, and the mark kept",[u.error,Boolean((await readBook(f.statsId)).history.find(x=>x.id===p)?.undone)],["BookWriteUnconfirmed",true]);
 }
 part("Every write of the book failing: an undo never leaves the text put back without the history saying so");
 {
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];await confirmFor(f.store,f.owner,[p],f.owner);let injected=0;
  redis.pipeline=(async commands=>{if(isBookWrite(commands,f.book)){injected++;throw Error("book unwritable");}return base(commands);}) as typeof redis.pipeline;
  let u:Awaited<ReturnType<typeof outcome>>;
  try{u=await outcome(()=>undoFor(f.store,f.owner,p,f.owner));}finally{redis.pipeline=base;}
  is("the write was tried",injected>=1,true);
  is("not done, the text as the history says",[u.error===""&&(u.value as {ok:boolean}|null)?.ok===true,await readAbout(f.statsId,id),Boolean((await readBook(f.statsId)).history.find(x=>x.id===p)?.undone)],[false,"Agent "+id,false]);
 }
 part("Every write of the book failing after a confirmation carried out: confirmed again, it is recorded once, never carried out twice");
 {
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];let applies=0;
  redis.pipeline=(async commands=>{if(isBookWrite(commands,f.book))throw Error("book unwritable");if(commands.length===1&&commands[0][0]==="EVAL"&&String(commands[0][1]).startsWith("-- marktmorgen:about-write-if:"))applies++;return base(commands);}) as typeof redis.pipeline;
  let r:Awaited<ReturnType<typeof outcome>>;
  try{r=await outcome(()=>confirmFor(f.store,f.owner,[p],f.owner));}finally{redis.pipeline=base;}
  const stuck=await readBook(f.statsId);
  is("carried out, said as not confirmed, still waiting in the book",[r.error!=="",await readAbout(f.statsId,id),stuck.waiting.some(x=>x.id===p)],[true,"Agent "+id,true]);
  const again=await confirmFor(f.store,f.owner,[p],f.owner);
  const book=await readBook(f.statsId);
  is("confirmed again: recorded as done, once, not waiting, and not carried out a second time",[again.done,book.history.filter(x=>x.id===p).length,book.waiting.some(x=>x.id===p),applies],[[p],1,false,1]);
 }
 part("A slow confirmation whose lock ran out never writes over a successor's book");
 {
  const f=await fixture(true),[pa,pb]=f.proposals;let paused=false,release!:()=>void,reached!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;});
  redis.pipeline=(async commands=>{if(!paused&&isBookWrite(commands,f.book)){paused=true;reached();await gate;}return base(commands);}) as typeof redis.pipeline;
  const first=outcome(()=>confirmFor(f.store,f.owner,[pa],f.owner));
  try{
   await Promise.race([ready,first.then(()=>{throw Error("the first confirmation never reached its book write");})]);
   redis.advance(61_000);
   const second=await confirmFor(f.store,f.owner,[pb],f.owner);
   is("the successor confirmed the other product",[second.done,(await readBook(f.statsId)).history.map(x=>x.id)],[[pb],[pb]]);
   release();
   is("the first confirmation still answers done",(await first).error,"");
  }finally{release();redis.pipeline=base;}
  const book=await readBook(f.statsId);
  is("both product changes landed",await Promise.all(f.ids.map(id=>readAbout(f.statsId,id))),f.ids.map(id=>"Agent "+id));
  is("both are in the history, once each, and neither is waiting",[book.history.filter(x=>x.id===pa).length,book.history.filter(x=>x.id===pb).length,book.waiting.length],[1,1,0]);
 }
 part("An unknown answer to SET NX is never the store's lock");
 for(const mode of ["native-busy","empty-reply","null-in-list"] as const){
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];await base([["SET",f.lock,"another-holder","EX",60]]);let injected=0;
  if(mode!=="native-busy")redis.pipeline=(async commands=>{if(commands.length===1&&commands[0][0]==="SET"&&commands[0][1]===f.lock){injected++;return mode==="empty-reply"?[]:[[null]];}return base(commands);}) as typeof redis.pipeline;
  let r:Awaited<ReturnType<typeof outcome>>;
  try{r=await outcome(()=>confirmFor(f.store,f.owner,[p],f.owner));}finally{redis.pipeline=base;}
  is(mode+": control or one unknown reply",injected,mode==="native-busy"?0:1);
  is(mode+": the other holder still owns the lock, and the product is unchanged",[(await base([["GET",f.lock]]))[0],await readAbout(f.statsId,id)],["another-holder","Original "+id]);
  is(mode+": answered busy",r.error,"BookBusy");
 }
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
