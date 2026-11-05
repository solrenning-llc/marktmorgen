import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ThanksPage from "@/app/[handle]/thanks/page";
import { confirmPreorder, queueRelease, readPreorder, setExpectedDay, soonOne } from "@/lib/preorders";
import { importedFor } from "@/lib/imported-purchases";
import { preorderWords } from "@/lib/buyer-words/preorder";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

type World = Record<string, Record<string, unknown>>;
const scope = globalThis as typeof globalThis & { __i2ThanksWorld?: World };
const stats = "a".repeat(32);
const product = { id:"breadbookproof1",title:"Bread Book",priceCents:2500,course:null } as unknown as Listing;
const store = {sid:"sidpreproof01",handle:"bakery",name:"Oven Notes",email:"owner@example.test",previousHandles:[],releasedHandles:[],statsId:stats,currency:"usd",language:"en",stripeAccountId:"acct_test_preordercopy1",pastBuyers:true,look:{theme:"light"}} as unknown as Store;
const session = {id:"cs_test_preorderproof0001",created:1794000000,status:"complete",payment_status:"paid",amount_total:2500,currency:"usd",payment_intent:"pi_preorderproof0001",metadata:{store:"bakery",product:product.id,preorder:"yes"},customer_details:{email:"buyer@example.test"}};
const deps={base:"https://example.test/@bakery",from:"Oven Notes <hello@example.test>",ordersLink:async()=>"https://example.test/@bakery/orders",recordStart:async()=>{}};
const promise = "The way to open it is in your purchases";
async function setup(ready:boolean, canConfirm:boolean) {
 redis.clear();process.env.RESEND_API_KEY="re_test_only";
 const oldFetch=globalThis.fetch;
 globalThis.fetch=(async()=>new Response("synthetic sender refusal",{status:503})) as typeof fetch;
 redis.run(["SADD",`nl:wl:${stats}:soon`,product.id]);
 await setExpectedDay(store,product.id,"2099-01-01");
 await confirmPreorder(store,session as Parameters<typeof confirmPreorder>[1],product,deps);
 assert.equal(Boolean((await readPreorder(store,product.id,session.id))?.given),false);
 if(ready){redis.run(["SREM",`nl:wl:${stats}:soon`,product.id]);await queueRelease(store,product.id);}
 const tasks:(()=>unknown)[]=[];
 scope.__i2ThanksWorld={
  "@/lib/store":{storeForPage:async()=>store,normaliseHandle:(s:string)=>s.replace(/^@/,"")},
  "@/lib/metered-limits":{withinStore:async()=>true},
  "@/lib/store-checkout":{readOrder:async()=>({state:"paid",preorder:true,product,record:session,email:"buyer@example.test",amount:2500,currency:"usd",created:session.created,news:false})},
  "next/headers":{headers:async()=>new Headers()},
  "@/lib/request-guard":{clientAddress:()=>"192.0.2.1"},
  "next/server":{after:(work:()=>unknown)=>tasks.push(work)},
  "@/lib/sale-events":{noteSale:async()=>{}},
  "@/lib/affiliates":{noteSession:async()=>{}},
  "@/lib/purchase-email":{canConfirm:()=>canConfirm,confirmPurchase:async()=>confirmPreorder(store,session as Parameters<typeof confirmPreorder>[1],product,deps)},
  "@/lib/store-look":{lookStyle:()=>({})},
  "@/components/store-tracking":{StoreTracking:()=>null},
 };
 const page=async()=>renderToStaticMarkup(await ThanksPage({params:Promise.resolve({handle:"@bakery"}),searchParams:Promise.resolve({session_id:session.id})}));
 return {tasks,page,cleanup:()=>{globalThis.fetch=oldFetch;delete scope.__i2ThanksWorld;}};
}

test("I2 released page must not claim an opening path already exists while hand-over is still deferred",async()=>{
 const r=await setup(true,true);
 try{const html=await r.page();assert.equal((await soonOne(store,product.id)).soon,false);assert.equal((await importedFor(store,"buyer@example.test")).length,0);assert.equal(Boolean((await readPreorder(store,product.id,session.id))?.given),false);assert.equal(r.tasks.length,2);assert.ok(html.includes(preorderWords("en").thanksOut));assert.equal(html.includes(promise),false);}
 finally{r.cleanup();}
});
test("I2 released page without confirmation available must not claim an existing opening path",async()=>{
 const r=await setup(true,false);
 try{const html=await r.page();assert.equal(r.tasks.length,1);assert.equal((await importedFor(store,"buyer@example.test")).length,0);assert.equal(html.includes(promise),false);}
 finally{r.cleanup();}
});
test("I2 granted control: draining the actual hand-over grants access even with sender refusal",async()=>{
 const r=await setup(true,true);
 try{await r.page();for(const work of r.tasks)await work();assert.equal((await importedFor(store,"buyer@example.test")).length,1);assert.equal(Boolean((await readPreorder(store,product.id,session.id))?.given),true);const html=await r.page();assert.ok(html.includes(preorderWords("en").thanksOut));}
 finally{r.cleanup();}
});
test("I2 upcoming control: real soon state does not select the released wording",async()=>{
 const r=await setup(false,true);
 try{const html=await r.page();assert.equal((await soonOne(store,product.id)).soon,true);assert.equal((await importedFor(store,"buyer@example.test")).length,0);assert.equal(html.includes(preorderWords("en").thanksOut),false);}
 finally{r.cleanup();}
});
