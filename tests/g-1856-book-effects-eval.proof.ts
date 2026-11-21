/** Boundary-adapted G copy: only SET predicate widened to SET or AGENT_BOOK_WRITE EVAL; every original assertion retained. */
/** Independent current-product schedules, with real confirmation/undo and only Redis reply/order boundaries controlled. */
import { addProduct, claimHandle, ensureStatsId, setProductAbout, setSubscription, storeForEmail } from "@/lib/store";
import { readAbout, writeAbout } from "@/lib/product-about";
import { proposeDescription } from "@/lib/agent-propose";
import { confirmFor, undoFor } from "@/lib/agent-confirm";
import { readBook } from "@/lib/agent-book";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
let serial=0;
const base=redis.pipeline.bind(redis);
async function fixture(two=false){
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
 for(const id of ids){const marked=await setProductAbout(owner,id,true);if(!marked.ok)throw Error("mark missing");await writeAbout(statsId,id,"Original "+id,marked.store);}
 const proposals:string[]=[];
 for(const id of ids){const r=await proposeDescription((await storeForEmail(owner))!,"key-g",{product:id,description:"Agent "+id});const p=JSON.parse(r.content[0].text).proposal;if(typeof p!=="string")throw Error("proposal missing");proposals.push(p);}
 const fresh={...(await storeForEmail(owner))!,statsId};
 return{owner,store:fresh,statsId,ids,proposals,book:`nl:agent:book:${statsId}`,lock:`nl:agent:book:lock:${statsId}`};
}
async function outcome<T>(fn:()=>Promise<T>){try{return{value:await fn(),error:""};}catch(e){return{value:null,error:e instanceof Error?e.name:"unknown"};}}
async function main(){
 part("Normal product confirmation and undo keep their durable history");
 {
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];
  const r=await confirmFor(f.store,f.owner,[p],f.owner);
  is("normal confirmation effect and history agree",[r.done,await readAbout(f.statsId,id),(await readBook(f.statsId)).history.map(x=>x.id)],[[p],"Agent "+id,[p]]);
  const u=await undoFor(f.store,f.owner,p,f.owner);
  is("normal undo effect and history agree",[u,await readAbout(f.statsId,id),Boolean((await readBook(f.statsId)).history[0].undone)],[{ok:true},"Original "+id,true]);
 }
 for(const mode of ["throw-before","empty-before","empty-after"] as const){
  part("Confirmation's product effect must have a durable history: "+mode);
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];let injected=0;
  redis.pipeline=(async commands=>{
   if(injected===0&&commands.length===1&&((commands[0][0]==="SET"&&commands[0][1]===f.book)||(commands[0][0]==="EVAL"&&String(commands[0][1]).startsWith("-- marktmorgen:agent-book-write:v1")&&commands[0][4]===f.book))){injected++;if(mode==="throw-before")throw Error("G final book write failed before application");if(mode==="empty-after")await base(commands);return[];}
   return base(commands);
  }) as typeof redis.pipeline;
  let r:Awaited<ReturnType<typeof outcome>>;
  try{r=await outcome(()=>confirmFor(f.store,f.owner,[p],f.owner));}finally{redis.pipeline=base;}
  const value=await readAbout(f.statsId,id),book=await readBook(f.statsId);
  console.log("G confirmation boundary",mode,r.error,{value,waiting:book.waiting.length,history:book.history.length});
  is(mode+": final book boundary actually reached",injected,1);
  is(mode+": effect is absent or durably recorded",value==="Original "+id||book.history.some(x=>x.id===p),true);
 }
 part("An undo whose final history write fails cannot leave an unrecorded undo");
 {
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];await confirmFor(f.store,f.owner,[p],f.owner);let injected=0;
  redis.pipeline=(async commands=>{if(commands.length===1&&((commands[0][0]==="SET"&&commands[0][1]===f.book)||(commands[0][0]==="EVAL"&&String(commands[0][1]).startsWith("-- marktmorgen:agent-book-write:v1")&&commands[0][4]===f.book))){injected++;throw Error("G undo history write failed");}return base(commands);}) as typeof redis.pipeline;
  try{await outcome(()=>undoFor(f.store,f.owner,p,f.owner));}finally{redis.pipeline=base;}
  const value=await readAbout(f.statsId,id),book=await readBook(f.statsId);
  is("undo failure was reached",injected,1);
  is("restored text is durably marked undone",value!=="Original "+id||Boolean(book.history.find(x=>x.id===p)?.undone),true);
 }
 part("A slow real confirmation cannot erase a successor's real history after the lease expires");
 {
  const f=await fixture(true),[pa,pb]=f.proposals;let paused=false,release!:()=>void,reached!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{reached=r;});
  redis.pipeline=(async commands=>{if(!paused&&commands.length===1&&((commands[0][0]==="SET"&&commands[0][1]===f.book)||(commands[0][0]==="EVAL"&&String(commands[0][1]).startsWith("-- marktmorgen:agent-book-write:v1")&&commands[0][4]===f.book))){paused=true;reached();await gate;}return base(commands);}) as typeof redis.pipeline;
  const first=confirmFor(f.store,f.owner,[pa],f.owner);
  try{
   await Promise.race([ready,first.then(()=>{throw Error("first confirmation never reached final book write");})]);
   redis.advance(61_000);
   const second=await confirmFor(f.store,f.owner,[pb],f.owner);
   const during=await readBook(f.statsId);
   is("successor really confirmed the other product",[second.done,during.history.map(x=>x.id)],[[pb],[pb]]);
   release();await first;
  }finally{release();redis.pipeline=base;}
  const book=await readBook(f.statsId);
  console.log("G expired lease",{waiting:book.waiting.map(x=>x.id),history:book.history.map(x=>x.id),successor:pb});
  is("both actual product changes landed",await Promise.all(f.ids.map(id=>readAbout(f.statsId,id))),f.ids.map(id=>"Agent "+id));
  is("successor history remains after late writer",book.history.some(x=>x.id===pb),true);
  is("a confirmed successor never returns to waiting",book.waiting.some(x=>x.id===pb),false);
 }
 part("Unknown SET NX is never ownership of somebody else's book lock");
 for(const mode of ["native-busy","empty-reply"] as const){
  const f=await fixture(),p=f.proposals[0],id=f.ids[0];await base([["SET",f.lock,"another-holder","EX",60]]);let injected=0;
  if(mode==="empty-reply")redis.pipeline=(async commands=>{if(commands.length===1&&commands[0][0]==="SET"&&commands[0][1]===f.lock){injected++;return[];}return base(commands);}) as typeof redis.pipeline;
  try{await outcome(()=>confirmFor(f.store,f.owner,[p],f.owner));}finally{redis.pipeline=base;}
  is(mode+": control or one unknown reply",injected,mode==="native-busy"?0:1);
  is(mode+": another holder remains owner",(await base([["GET",f.lock]]))[0],"another-holder");
  is(mode+": product never changes without confirmed ownership",await readAbout(f.statsId,id),"Original "+id);
 }
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
