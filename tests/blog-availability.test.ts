import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { POST } from "@/app/api/store/blog/route";
import { BlogUnavailable } from "@/app/[handle]/blog/blog-unavailable";
import { blogReadingWords } from "@/lib/buyer-words/blog-reading";
import { LANGUAGES } from "@/lib/store-language";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { GET as feed } from "@/app/[handle]/blog/feed.xml/route";
import { claimHandle, ensureStatsId, setPostCount, storeForEmail } from "@/lib/store";
import { allPosts, publishedPosts, readPost, savePost } from "@/lib/store-blog";
import { sitemapSize, storeSitemap } from "@/lib/store-sitemap";
import { sitemapUnits } from "@/lib/public-read-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

async function main(){
 redis.clear();
 const email="blog-recovery@example.com";
 await claimHandle(email,"blogrecovery","Synthetic blog","");
 await ensureStatsId(email);
 await setPostCount(email,1);
 const store=(await storeForEmail(email))!;
 const id="abcde12345";
 const saved=await savePost(store.statsId,null,{title:"A kept post",body:"Synthetic words.",product:null,draft:false},()=>id,ROOM);
 assert.equal(saved.ok,true);
 const request=new Request("https://local.example/@blogrecovery/blog/feed.xml");
 const context={params:Promise.resolve({handle:"@blogrecovery"})};
 const healthy=await feed(request,context);
 is("healthy real RSS route remains available",healthy.status,200);
 is("healthy RSS contains the stored post",(await healthy.text()).includes("A kept post"),true);
 // A partial pipeline can leave the published index without its metadata. Do not delete or invent a post.
 await redis.pipeline([["HDEL",`nl:blog:meta:${store.statsId}`,id]]);
 part("Public readers expose unavailable evidence without a permanent 500");
 let response:Response|null=null;
 try{response=await feed(request,context);}catch{}
 is("real RSS route returns retryable unavailable",response?.status,503);
 is("unavailable RSS is not cached as an empty feed",response?.headers.get("cache-control"),"no-store");
 is("RSS asks the reader to retry",Number(response?.headers.get("retry-after"))>0,true);
 const page=readFileSync("app/[handle]/blog/page.tsx","utf8");
 // The page's own read, its catch included, run as written (Claude 7's LEVE on #2695: the catch now logs the cause).
 const expression=page.match(/publishedPosts\(store\.statsId,\s*page\)\.catch\([\s\S]*?\n  \}\)/)?.[0];
 assert.ok(expression);
 const pageModule={exports:{} as unknown};
 new Function("module",ts.transpileModule(`module.exports=(publishedPosts,store,page,console)=>${expression};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(pageModule);
 const read=pageModule.exports as (reader:typeof publishedPosts,shop:typeof store,page:number,log:{error:(...a:unknown[])=>void})=>Promise<unknown>;
 const pageLogs:unknown[][]=[];
 const pageRead=await Promise.allSettled([read(publishedPosts,store,1,{error:(...a)=>pageLogs.push(a)})]);
 is("actual public page read resolves unavailable",pageRead.map(r=>r.status==="fulfilled"?[r.status,r.value]:[r.status]),[["fulfilled",null]]);
 is("and the page's read logs its cause once",pageLogs.length,1);
 // Execute the current paid wrapper with the actual size/reader and a synthetic, observed prepaid admission.
 const source=readFileSync("lib/store-sitemap.ts","utf8").match(/export async function paidStoreSitemap[\s\S]*?\n}/)?.[0];
 assert.ok(source);
 const javascript=ts.transpileModule(source.replace(/^export /,""),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const buildWrapper=new Function("sitemapSize","takePublicRequest","sitemapUnits","storeSitemap",javascript+";return paidStoreSitemap;");
 let admitted=0;
 const actualWrapper=buildWrapper(sitemapSize,async(_s:unknown,_who:unknown,_now:unknown,units:number)=>{assert.ok(units>0);admitted++;return true;},sitemapUnits,storeSitemap) as (shop:typeof store)=>Promise<unknown>;
 // Claude 4's LEVE 1 on #2695 (board #5285): a blog that does not read leaves only the blog out of the map, never the
 // whole map. Before, this wrapper resolved null for the whole store.
 const map=await Promise.allSettled([actualWrapper(store)]);
 const drawn=map[0].status==="fulfilled"?map[0].value:undefined;
 is("paid sitemap wrapper still draws the store's map",Array.isArray(drawn),true);
 is("with no blog address in it, none invented",Array.isArray(drawn)&&drawn.some((entry:{url:string})=>entry.url.includes("/blog")),false);
 is("reader follows exactly one prepaid admission",admitted,1);
 is("reader recovery never removes the inconsistent stored index",await redis.pipeline([["ZCARD",`nl:blog:pub:${store.statsId}`]]),[1]);
 part("Unavailable feedback is rendered in every supported store language");
 for(const code of Object.keys(LANGUAGES)){
  const words=blogReadingWords(code);
  const html=renderToStaticMarkup(createElement(BlogUnavailable,{language:code,handle:store.handle,name:store.name}));
  is("localized reading notice: "+code,html.includes(words.unavailable.replace(/'/g,"&#x27;").replace(/"/g,"&quot;")),true);
  is("accessible retry keeps the actual blog address: "+code,[html.includes('role="status"'),html.includes(`/@${store.handle}/blog`),html.includes(words.retry)],[true,true,true]);
  is("temporary unavailable content is not indexed: "+code,html.includes('name="robots" content="noindex"'),true);
 }
 part("Actual write route preserves a confirmed post when only its count is unknown");
 const cookie=`${SESSION_COOKIE}=${await openSession(email)}`;
 const call=async(title:string)=>{
  const result=await POST(new NextRequest("https://marktmorgen.com/api/store/blog",{method:"POST",headers:{"content-type":"application/json","x-nimbus-store":store.sid,cookie},body:JSON.stringify({action:"save",title,body:"Synthetic words.",draft:false})}));
  return{status:result.status,data:await result.json() as {ok?:boolean;error?:string;post?:{id:string};countUnavailable?:boolean}};
 };
 const pipeline=redis.pipeline;
 redis.pipeline=async commands=>{const result=await pipeline(commands);return commands[0][0]==="HSET"&&String(commands[0][1]).startsWith("nl:blog:meta:")?[result[0],result[1],result[2],null]:result;};
 try{
  const result=await call("Confirmed post, unknown count");
  // Claude 7's LEVE on #2695: the count that did not come back is read once more, so the record is not left stale.
  is("confirmed post is not a missing post or a failed new save",[result.status,result.data.ok,result.data.countUnavailable,typeof result.data.post?.id],[200,true,false,"string"]);
  is("confirmed id points to the saved content",(await readPost(store.statsId,result.data.post?.id??""))?.title,"Confirmed post, unknown count");
  is("the record takes the count read again, never zero",(await storeForEmail(email))?.posts,(await redis.pipeline([["ZCARD",`nl:blog:pub:${store.statsId}`]]))[0]);
 }finally{redis.pipeline=pipeline;}
 const before=(await storeForEmail(email))?.posts;
 redis.pipeline=async commands=>{const result=await pipeline(commands);if(commands.length===1&&commands[0][0]==="ZCARD"&&String(commands[0][1]).startsWith("nl:blog:pub:"))return[null];return commands[0][0]==="HSET"&&String(commands[0][1]).startsWith("nl:blog:meta:")?[result[0],result[1],result[2],null]:result;};
 try{
  const result=await call("Confirmed post, count unknown twice");
  is("both counts unknown: the post is saved and the count said unconfirmed",[result.status,result.data.ok,result.data.countUnavailable],[200,true,true]);
  is("both counts unknown: the cached count is kept, never zero",(await storeForEmail(email))?.posts,before);
 }finally{redis.pipeline=pipeline;}
 redis.pipeline=async commands=>{const result=await pipeline(commands);return commands[0][0]==="HSET"&&String(commands[0][1]).startsWith("nl:blog:meta:")?[null,result[1],result[2],result[3]]:result;};
 try{const result=await call("Unconfirmed write");is("uncertain mutation has a distinct retry-check response",[result.status,result.data.error],[503,"unconfirmed"]);}finally{redis.pipeline=pipeline;}
 let written=false,cacheRefused=0;
 redis.pipeline=async commands=>{
  if(written&&commands.some(c=>c.some(arg=>typeof arg==="string"&&arg.includes('"posts":')))){cacheRefused++;throw Error("synthetic count cache unavailable");}
  const result=await pipeline(commands);
  if(commands[0][0]==="HSET"&&String(commands[0][1]).startsWith("nl:blog:meta:"))written=true;
  return result;
 };
 try{const result=await call("Confirmed post, cache unavailable");is("a later cache failure cannot lose the confirmed post id",[result.status,result.data.ok,result.data.countUnavailable,typeof result.data.post?.id],[200,true,true,"string"]);is("cache failure fixture reached the actual update",cacheRefused>0,true);is("the refused cache follows exactly one actually saved post",(await allPosts(store.statsId)).filter(p=>p.title==="Confirmed post, cache unavailable").length,1);}finally{redis.pipeline=pipeline;}
 const editor=readFileSync("components/blog-editor.tsx","utf8");
 is("uncertain write advice says to check before repeating",/unconfirmed:\s*"[^"]*check[^\"]*before/.test(editor),true);
 part("Persisted metadata must preserve its identity, visibility and usable dates");
 const metadataStats="metadata-boundary";
 const keptId="abcde98765", otherId="abcde98764";
 const input={title:"Metadata control",body:"Confirmed content.",product:null,draft:false};
 const original=await savePost(metadataStats,null,input,()=>keptId,ROOM);
 assert.ok(original.ok);
 const key=`nl:blog:meta:${metadataStats}`;
 const [raw]=await redis.pipeline([["HGET",key,keptId]]);
 const valid=JSON.parse(String(raw)) as Record<string,unknown>;
 for(const [field,value] of [["draft","true"],["publishedAt","not-a-date"],["publishedAt","1e309"],["publishedAt",8_640_000_000_001],["updatedAt",0.5],["updatedAt",-1],["minutes",null],["minutes","1e309"],["excerpt",null]] as const){
  await redis.pipeline([["HSET",key,keptId,JSON.stringify({...valid,[field]:value})]]);
  let refused=false;try{await publishedPosts(metadataStats,1);}catch{refused=true;}
  is(`unreadable ${field}:${String(value)} is not projected as published`,refused,true);
  const changed=await savePost(metadataStats,keptId,input,()=>{throw Error("no new id on update");},ROOM);
  is(`unreadable ${field}:${String(value)} cannot authorize an edit`,changed.ok,false);
  is(`unknown ${field}:${String(value)} keeps its original stored bytes`,await redis.pipeline([["HGET",key,keptId]]),[JSON.stringify({...valid,[field]:value})]);
 }
 await redis.pipeline([["HSET",key,keptId,String(raw)]]);
 await savePost(metadataStats,null,{...input,title:"Other confirmed post",body:"Other content stays."},()=>otherId,ROOM);
 await redis.pipeline([["HSET",key,keptId,JSON.stringify({...valid,id:otherId})]]);
 is("mismatched identity cannot authorize updating another post",(await savePost(metadataStats,keptId,input,()=>{throw Error("no new id on update");},ROOM)).ok,false);
 is("other post keeps its confirmed content",(await readPost(metadataStats,otherId))?.body,"Other content stays.");
 await redis.pipeline([["HSET",key,keptId,String(raw)]]);
 is("valid stored metadata still authorizes its own update",(await savePost(metadataStats,keptId,input,()=>{throw Error("no new id on update");},ROOM)).ok,true);
 part("The actual demo seed consumer never writes an unknown post count");
 const seedSource=readFileSync("lib/demo-seed.ts","utf8").match(/async function ensurePost\([\s\S]*?\n}/)?.[0];
 assert.ok(seedSource);
 const seedJs=ts.transpileModule(seedSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const seedFactory=new Function("DEMO_POST","cleanPost","readPost","savePost","setPostCount","REF","refused",seedJs+";return ensurePost;");
 for(const total of [null,2]){
  const writes:unknown[]=[];const pending:string[]=[];
  const run=seedFactory({id:keptId,title:"Seed post",body:"Words.",product:false},(value:unknown)=>value,async()=>null,async()=>({ok:true,post:{id:keptId},published:total}),async(_ref:unknown,count:unknown)=>{writes.push(count);return {...store,posts:count};},"synthetic-owner@example.test",(step:string,reason:string)=>`${step}:${reason}`) as (s:typeof store,p:{id:string},pending:string[])=>Promise<typeof store>;
  const result=await run(store,{id:"synthetic-product"},pending);
  is("seed count writes: "+String(total),writes,total===null?[]:[2]);
  is("seed count uncertainty stays explicit: "+String(total),pending,total===null?["post:count_unknown"]:[]);
  is("seed cached count preserved when unknown: "+String(total),result.posts,total===null?store.posts:2);
 }
 part("A confirmed deletion stays confirmed when only its count is unknown");
 const deleteId="abcde23456";
 await savePost(store.statsId,null,input,()=>deleteId,ROOM);
 const cached=(await storeForEmail(email))?.posts;
 redis.pipeline=async commands=>{const result=await pipeline(commands);return commands[0][0]==="HDEL"&&String(commands[0][1]).startsWith("nl:blog:meta:")?[result[0],result[1],result[2],null]:result;};
 try{
  const response=await POST(new NextRequest("https://marktmorgen.com/api/store/blog",{method:"POST",headers:{"content-type":"application/json","x-nimbus-store":store.sid,cookie},body:JSON.stringify({action:"delete",id:deleteId})}));
  const data=await response.json() as {ok?:boolean;countUnavailable?:boolean};
  is("three deletion ACKs retain the confirmed outcome, its count read again",[response.status,data.ok,data.countUnavailable],[200,true,false]);
  is("the acknowledged deletion removed the actual post",await readPost(store.statsId,deleteId),null);
  is("the record takes the deletion's count read again",(await storeForEmail(email))?.posts,(await redis.pipeline([["ZCARD",`nl:blog:pub:${store.statsId}`]]))[0]);
 }finally{redis.pipeline=pipeline;}
 const secondId="abcde34567";
 await savePost(store.statsId,null,input,()=>secondId,ROOM);
 await setPostCount(email,7);
 redis.pipeline=async commands=>{const result=await pipeline(commands);if(commands.length===1&&commands[0][0]==="ZCARD"&&String(commands[0][1]).startsWith("nl:blog:pub:"))return[null];return commands[0][0]==="HDEL"&&String(commands[0][1]).startsWith("nl:blog:meta:")?[result[0],result[1],result[2],null]:result;};
 try{
  const response=await POST(new NextRequest("https://marktmorgen.com/api/store/blog",{method:"POST",headers:{"content-type":"application/json","x-nimbus-store":store.sid,cookie},body:JSON.stringify({action:"delete",id:secondId})}));
  const data=await response.json() as {ok?:boolean;countUnavailable?:boolean};
  is("both deletion counts unknown: still confirmed, the count said unconfirmed",[response.status,data.ok,data.countUnavailable],[200,true,true]);
  is("both deletion counts unknown: the cached count is kept",(await storeForEmail(email))?.posts,7);
 }finally{redis.pipeline=pipeline;}
 done();
}
main().catch(error=>{console.error(error);process.exit(1);});
