import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { GET as feed } from "@/app/[handle]/blog/feed.xml/route";
import { claimHandle, ensureStatsId, setPostCount, storeForEmail } from "@/lib/store";
import { publishedPosts, savePost } from "@/lib/store-blog";
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
 done();
}
main().catch(error=>{console.error(error);process.exit(1);});
