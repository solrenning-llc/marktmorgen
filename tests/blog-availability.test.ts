import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { POST } from "@/app/api/store/blog/route";
import { BlogUnavailable } from "@/components/blog-unavailable";
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
 const expression=page.match(/publishedPosts\(store.statsId,\s*page\)(?:\.catch\(\(\)\s*=>\s*null\))?/)?.[0];
 assert.ok(expression);
 const read=new Function("publishedPosts","store","page","return "+expression) as (reader:typeof publishedPosts,shop:typeof store,page:number)=>Promise<unknown>;
 const pageRead=await Promise.allSettled([read(publishedPosts,store,1)]);
 is("actual public page read resolves unavailable",pageRead.map(r=>r.status==="fulfilled"?[r.status,r.value]:[r.status]),[["fulfilled",null]]);
 // Execute the current paid wrapper with the actual size/reader and a synthetic, observed prepaid admission.
 const source=readFileSync("lib/store-sitemap.ts","utf8").match(/export async function paidStoreSitemap[\s\S]*?\n}/)?.[0];
 assert.ok(source);
 const javascript=ts.transpileModule(source.replace(/^export /,""),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const buildWrapper=new Function("sitemapSize","takePublicRequest","sitemapUnits","storeSitemap",javascript+";return paidStoreSitemap;");
 let admitted=0;
 const actualWrapper=buildWrapper(sitemapSize,async(_s:unknown,_who:unknown,_now:unknown,units:number)=>{assert.ok(units>0);admitted++;return true;},sitemapUnits,storeSitemap) as (shop:typeof store)=>Promise<unknown>;
 const map=await Promise.allSettled([actualWrapper(store)]);
 is("paid sitemap wrapper resolves unavailable",map.map(r=>r.status==="fulfilled"?[r.status,r.value]:[r.status]),[["fulfilled",null]]);
 is("reader follows exactly one prepaid admission",admitted,1);
 is("reader recovery never removes the inconsistent stored index",await redis.pipeline([["ZCARD",`nl:blog:pub:${store.statsId}`]]),[1]);
 part("Unavailable feedback is rendered in every supported store language");
 for(const code of Object.keys(LANGUAGES)){
  const words=blogReadingWords(code);
  const html=renderToStaticMarkup(createElement(BlogUnavailable,{language:code,handle:store.handle,name:store.name}));
  is("localized reading notice: "+code,html.includes(words.unavailable.replace(/'/g,"&#x27;").replace(/"/g,"&quot;")),true);
  is("accessible retry keeps the actual blog address: "+code,[html.includes('role="status"'),html.includes(`/@${store.handle}/blog`),html.includes(words.retry)],[true,true,true]);
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
  is("confirmed post is not a missing post or a failed new save",[result.status,result.data.ok,result.data.countUnavailable,typeof result.data.post?.id],[200,true,true,"string"]);
  is("confirmed id points to the saved content",(await readPost(store.statsId,result.data.post?.id??""))?.title,"Confirmed post, unknown count");
  is("unknown total never overwrites cached count with zero",(await storeForEmail(email))?.posts,1);
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
 done();
}
main().catch(error=>{console.error(error);process.exit(1);});
