import test from "node:test";
import assert from "node:assert/strict";
import {writePathWording} from "@/lib/path-wording";
import {aiMonthKey} from "@/lib/ai";
import {aiSpendLedgerKey,aiSpendOpenedKey} from "@/lib/ai-spend-policy";
import {AI_MONTHLY} from "@/lib/ai-rules";
import type {Store} from "@/lib/store";
import {reset,ordinary,ledger,opened,monetaryCalls} from "./path-wording-provider-world";
import {calendarPeriod} from "./billing-period-fixture";
import {withinOneUtcDay} from "./one-utc-day";
// The checks name the month's job count and spend ledger by the month they read; the code reads its own at each call,
// so a real month end passing mid-file read the new month's 0. The clock stays inside one UTC day (tests/one-utc-day.ts).
withinOneUtcDay();
const source={mission:"title",step:"Write your store's name the way you want people to say it."};
const text="Write your store's name as you want people to say it.";
const store={statsId:"pathwording",sid:"a".repeat(32),tier:"pro",createdAt:1,subscriptionActive:true,subscriptionId:"synthetic-subscription",trialEnds:0,planEndedAt:"",period:calendarPeriod(),name:"Private owner name",bio:"private-contact@example.test"} as unknown as Store;
const ledgerKey=()=>aiSpendLedgerKey(new Date().toISOString().slice(0,7));
const company=()=>Number(ledger.get(ledgerKey())?.get("company")??0);
async function jobs(){return Number((await ordinary.pipeline([["GET",aiMonthKey(store,new Date())!]]))[0]??0);}
function start(){reset();process.env.ANTHROPIC_API_KEY="sk-ant-"+"x".repeat(30);process.env.AI_MODEL="claude-sonnet-5-5";process.env.AI_ANSWER_MODEL="claude-haiku-5-5";}
test("real counted job and monetary reservation both precede the model fetch",async()=>{
 start();const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_input,init)=>{calls++;assert.equal(await jobs(),1);assert.ok(company()>0);assert.ok(monetaryCalls.length>0);const body=JSON.parse(String(init?.body));assert.ok(Buffer.byteLength(String(init?.body),"utf8")<=4096);assert.equal(body.model,"claude-haiku-5-5");assert.equal(body.max_tokens,240);assert.equal(body.messages[0].content,JSON.stringify({instruction:source.step}));assert.equal(/Private owner|private-contact/.test(JSON.stringify(body)),false);return Response.json({content:[{type:"text",text:JSON.stringify({text})}]});};
 try{const reply=await writePathWording(store,source);assert.equal(reply.fallback,false);assert.equal(reply.text,text);assert.equal(reply.left,AI_MONTHLY.pro-1);assert.equal(calls,1);assert.equal(await jobs(),1);assert.ok(company()>0);}finally{globalThis.fetch=old;}
});
test("trial, ended, setup and a tier without writing jobs never count or call",async()=>{
 for(const state of [{subscriptionActive:true,trialEnds:Date.now()/1000+86400},{subscriptionActive:false,subscriptionId:"ended"},{subscriptionActive:false,subscriptionId:null},{tier:"creator"}]){
  start();const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error("must not call");};
  try{assert.equal((await writePathWording({...store,...state} as Store,source)).fallback,true);assert.equal(calls,0);assert.equal(await jobs(),0);assert.equal(company(),0);}finally{globalThis.fetch=old;}
 }
});
test("spent writing quota and missing monetary ledger refuse before provider",async()=>{
 for(const kind of ["quota","ledger"]){
  start();if(kind==="quota")await ordinary.pipeline([["SET",aiMonthKey(store,new Date())!,AI_MONTHLY.pro]]);
  else opened.add(aiSpendOpenedKey(new Date().toISOString().slice(0,7)));
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error("must not call");};
  try{assert.equal((await writePathWording(store,source)).fallback,true);assert.equal(calls,0);assert.equal(company(),0);}finally{globalThis.fetch=old;}
 }
});
test("unsafe model output keeps fixed wording and retains both reservations",async()=>{
 start();const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({content:[{type:"text",text:JSON.stringify({text:"Earn $500 today.",complete:true})}]});
 try{const reply=await writePathWording(store,source);assert.equal(reply.fallback,true);assert.equal(reply.text,source.step);assert.equal(await jobs(),1);assert.ok(company()>0);}finally{globalThis.fetch=old;}
});
test("a lost response has fixed fallback, no automatic retry and no refund",async()=>{
 start();const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error("synthetic lost response");};
 try{assert.equal((await writePathWording(store,source)).fallback,true);const first=company();assert.ok(first>0);assert.equal(calls,1);assert.equal(await jobs(),1);assert.equal((await writePathWording(store,source)).fallback,true);assert.equal(calls,2);assert.equal(company(),first*2);assert.equal(await jobs(),2);}finally{globalThis.fetch=old;}
});
test("checkout and consent instructions bypass AI entirely",async()=>{
 start();const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error("must not call");};
 try{for(const mission of ["test","sale","lead","traffic-4","traffic-7"])assert.equal((await writePathWording(store,{...source,mission})).fallback,true);assert.equal(calls,0);assert.equal(await jobs(),0);assert.equal(company(),0);}finally{globalThis.fetch=old;}
});
