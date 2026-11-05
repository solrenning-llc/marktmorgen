/** Nominal Z return: original evidence remains byte-identical; bounded GETRANGE/unknown behavior and one same-length critical ACK vector are added. */
import assert from "node:assert/strict";
import {NextRequest} from "next/server";
import {SESSION_COOKIE,openSession} from "@/lib/auth";
import {addProduct,addOption,claimHandle,ensureStatsId,setProductLink,setStripeAccount,storeForEmail} from "@/lib/store";
import {readProduct,readListing} from "@/lib/catalog";
import {membershipCacheKey,numbersFrom,type Sub} from "@/lib/membership-numbers";
import {PAGE_INCLUDED_BYTES} from "@/lib/sent-bytes";
import {KEPT_READINGS_SHAPE} from "@/lib/read-ceilings";
import {STUDIO_PAGE_UNITS} from "@/lib/studio-allowance-rules";
import {sellableOptions} from "@/lib/product-option";
import {confirmsOptionWrite} from "@/lib/option-confirmation";
import {POST} from "@/app/api/store/option/route";
import {store as redis} from "./redis-stub";
process.env.UPSTASH_REDIS_REST_URL="http://stub";
process.env.STRIPE_SECRET_KEY="sk_test_z2690_review_only";
const owner="z2690@example.test";
const origin="https://marktmorgen.com";
type Command=(string|number)[];
const trace:{command:Command,reply:unknown}[]=[];
let passed=0,failed=0,stripeCalls=0,dropListing="",dropped=0,sameLengthUnknown=false;
async function check(name:string,run:()=>Promise<void>){try{await run();passed++;console.log(`PASS ${name}`);}catch(error){failed++;console.error(`FAIL ${name}`,error);}}
async function post(session:string,body:unknown){const r=await POST(new NextRequest(origin+"/api/store/option",{method:"POST",headers:{"Content-Type":"application/json",cookie:`${SESSION_COOKIE}=${session}`},body:JSON.stringify(body)}));return{status:r.status,httpOk:r.ok,body:await r.json() as Record<string,unknown>};}
async function main(){
 const originalFetch=globalThis.fetch,originalPipeline=redis.pipeline.bind(redis);
 globalThis.fetch=async()=>{stripeCalls++;throw new Error("External provider forbidden in this review");};
 redis.pipeline=async(commands:Command[])=>{if(dropListing&&commands.some(c=>c[0]==="SET"&&c[1]===dropListing)){dropped++;for(const command of commands)trace.push({command:[...command],reply:undefined});return sameLengthUnknown?commands.map(c=>c[0]==="SET"?null:0):[];}const reply=await originalPipeline(commands);commands.forEach((command,i)=>trace.push({command:[...command],reply:reply[i]}));return reply;};
 try{
  redis.clear();await claimHandle(owner,"z2690review","Synthetic financial review","");await ensureStatsId(owner);
  const ids:string[]=[];for(let i=0;i<25;i++){const made=await addProduct(owner,`Membership ${i}`,"","10",{interval:"month",trialDays:0,payments:0});assert.ok(made.ok);ids.push(made.product.id);}
  const before=(await storeForEmail(owner))!;
  const pid=ids.find(id=>!before.catalog.head.some(p=>p.id===id));assert.ok(pid,"A product outside the first-page head is needed");
  assert.ok((await addOption(owner,pid,"Basic","10")).ok);assert.ok((await addOption(owner,pid,"Plus","20")).ok);
  let store=(await storeForEmail(owner))!;let product=(await readProduct(store,pid))!;
  const [basic,plus]=product.options.map(o=>o.id);await setProductLink(owner,basic,"https://example.com/basic");await setProductLink(owner,plus,"https://example.com/plus");
  await setStripeAccount(owner,"acct_TestZ2690",true);store=(await storeForEmail(owner))!;product=(await readProduct(store,pid))!;
  const session=await openSession(owner),cache=membershipCacheKey(store.statsId!);
  const sub=(i:number):Sub=>({id:`sub_Z2690_${i}`,status:"active",product:i===0?pid:`p${String(i).padStart(9,"0")}`,option:i===0?basic:"opt_synthetic",amount:1000,currency:"usd",interval:"month",count:1,start:Math.floor(Date.now()/1000)-60*86400,ended:0,trialEnd:0,channel:"direct",canceledAt:0,cancelCause:"",feedback:"",comment:""});
  await check("small actual producer cache is read without contacting Stripe",async()=>{redis.run(["SET",cache,JSON.stringify(numbersFrom([sub(0)],"usd",Date.now(),true)),"EX",600]);trace.length=0;const r=await post(session,{action:"count",id:pid});assert.equal(r.status,200);assert.equal((r.body.members as Record<string,unknown>)[basic],1);assert.equal(stripeCalls,0);assert.equal(trace.filter(x=>x.command[0]==="GETRANGE"&&x.command[1]===cache).length,1);});
  await check("a complete 2000-subscription cache is bounded before transfer and remains unknown",async()=>{
   const json=JSON.stringify(numbersFrom(Array.from({length:2000},(_,i)=>sub(i)),"usd",Date.now(),true));assert.ok(Buffer.byteLength(json)<512000,"Within the existing 512KB cache room");redis.run(["SET",cache,json,"EX",600]);trace.length=0;
   const r=await post(session,{action:"count",id:pid});assert.equal(r.status,200);
   const at=trace.findIndex(x=>["GET","GETRANGE"].includes(String(x.command[0]))&&x.command[1]===cache);assert.ok(at>=0);const units=trace.slice(0,at).filter(x=>x.command[0]==="INCRBY"&&String(x.command[1]).startsWith("nl:allow:studio:")).reduce((n,x)=>n+Number(x.command[2]),0);
   const bytes=Buffer.byteLength(String(trace[at].reply));console.log(JSON.stringify({case:"cached count cost",status:r.status,subscriptions:2000,cacheBytes:bytes,commands:trace.length,paidUnitsBeforeCache:units,pricedBytes:units*(PAGE_INCLUDED_BYTES+KEPT_READINGS_SHAPE.dbBytes/STUDIO_PAGE_UNITS),stripeCalls}));assert.equal(units,1,"Real admission pays one studio unit");assert.ok(bytes<=units*(PAGE_INCLUDED_BYTES+KEPT_READINGS_SHAPE.dbBytes/STUDIO_PAGE_UNITS),"The cache alone must fit even after granting this call its full store-readings share");assert.equal(trace[at].command[0],"GETRANGE");assert.deepEqual(trace[at].command.slice(2),[0,40000]);assert.ok(bytes<=40003,"At most40001 Redis bytes plus a replacement character at a cut UTF-8 edge");assert.equal((r.body.members as Record<string,unknown>)[basic],null,"Oversize cache is unknown, never zero");assert.equal(trace.some(x=>x.command[0]==="GET"&&x.command[1]===cache),false);
  });
  await check("authorization refuses before the membership cache",async()=>{trace.length=0;assert.equal((await post("",{action:"count",id:pid})).status,401);assert.equal(trace.some(x=>x.command[0]==="GET"&&x.command[1]===cache),false);});
  await check("missing cache remains unknown with no Stripe repair",async()=>{redis.run(["DEL",cache]);const r=await post(session,{action:"count",id:pid});assert.equal(r.status,200);assert.equal((r.body.members as Record<string,unknown>)[basic],null);assert.equal(stripeCalls,0);});
  await check("confirmed off/on changes preserve price and delivery",async()=>{const first=await post(session,{action:"sale",id:basic,onSale:false});assert.equal(first.status,200);let p=(await readProduct((await storeForEmail(owner))!,pid))!;assert.equal(p.options[0].offSale,true);assert.deepEqual({...p.options[0],offSale:undefined},{...product.options[0],offSale:undefined});assert.equal((await post(session,{action:"sale",id:basic,onSale:true})).status,200);p=(await readProduct((await storeForEmail(owner))!,pid))!;assert.equal(Object.hasOwn(p.options[0],"offSale"),false);});
  await check("an unknown product-write ACK never confirms an option off sale",async()=>{
   store=(await storeForEmail(owner))!;assert.equal(store.catalog.head.some(p=>p.id===pid),false);dropListing=`nl:catalog:${store.catalog.id}:l:${pid}`;dropped=0;trace.length=0;let r:Awaited<ReturnType<typeof post>>;
   try{r=await post(session,{action:"sale",id:basic,onSale:false});}finally{dropListing="";}
   const p=(await readProduct((await storeForEmail(owner))!,pid))!;const buyer=(await readListing((await storeForEmail(owner))!,pid))!;const confirmed=confirmsOptionWrite(r.body,r.httpOk);const offered=sellableOptions(buyer).some(o=>o.id===basic);
   console.log(JSON.stringify({case:"unknown product ACK",droppedPipelines:dropped,status:r.status,clientConfirms:confirmed,persistedOffSale:p.options[0].offSale===true,buyerStillOffersOption:offered,stripeCalls}));assert.equal(dropped,1);assert.ok(!confirmed||!offered,"No success confirmation while the buyer still receives the price as on sale");
  });
  await check("a same-length unknown SET acknowledgement never confirms an option off sale",async()=>{
   store=(await storeForEmail(owner))!;dropListing=`nl:catalog:${store.catalog.id}:l:${pid}`;dropped=0;sameLengthUnknown=true;trace.length=0;
   let r:Awaited<ReturnType<typeof post>>;
   try{r=await post(session,{action:"sale",id:basic,onSale:false});}finally{dropListing="";sameLengthUnknown=false;}
   const saved=(await readProduct((await storeForEmail(owner))!,pid))!;const buyer=(await readListing((await storeForEmail(owner))!,pid))!;
   const confirmed=confirmsOptionWrite(r.body,r.httpOk),offered=sellableOptions(buyer).some(o=>o.id===basic);
   console.log(JSON.stringify({case:"same-length unknown SET ACK",droppedPipelines:dropped,criticalCommands:trace.filter(x=>x.reply===undefined).map(x=>x.command[0]),reply:"null for each SET, 0 for other existing-record writes",status:r.status,clientConfirms:confirmed,persistedOffSale:saved.options[0].offSale===true,buyerStillOffersOption:offered,stripeCalls}));
   assert.equal(dropped,1);assert.ok(!confirmed||!offered,"Exact outer length cannot turn an unknown critical SET into a confirmed write");
  });
  await check("concurrent changes to separate options preserve both confirmed writes",async()=>{const results=await Promise.all([post(session,{action:"sale",id:basic,onSale:false}),post(session,{action:"sale",id:plus,onSale:false})]);assert.deepEqual(results.map(r=>r.status),[200,200]);const p=(await readProduct((await storeForEmail(owner))!,pid))!;assert.equal(p.options.filter(o=>o.id===basic||o.id===plus).every(o=>o.offSale===true),true);});
  assert.equal(stripeCalls,0);
 }finally{redis.pipeline=originalPipeline;globalThis.fetch=originalFetch;}
 console.log(`${passed} passed; ${failed} failed`);process.exitCode=failed?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
