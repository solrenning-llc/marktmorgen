import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { recordPackage, readBought, holdSession, packageState, type Bought } from "@/lib/call-packages";
import { claimHandle, ensureStatsId, addProduct, setSubscription, storeForEmail, type Store, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
const originalFetch=globalThis.fetch;
const checkout="cs_test_i2packageevidence0001";
let store:Store,product:Listing;
const key=()=>`nl:pkg:${checkout}`;
const session=()=>({id:checkout,status:"complete",payment_status:"paid",created:1800000000,amount_total:50000,currency:"usd",metadata:{kind:"package",sessions:"5",days:"90"},customer_details:{email:"buyer@example.test"}});
const record=(value:Parameters<typeof recordPackage>[0]["session"])=>recordPackage({store,product,session:value,base:"https://example.test",from:"proof@example.test"});
beforeEach(async()=>{
 redis.clear();
 await claimHandle("package-owner@example.test","packageproof","Package proof","");
 await ensureStatsId("package-owner@example.test");
 await setSubscription("package-owner@example.test",{customerId:"cus_Owner00001",subscriptionId:"sub_Owner00001",active:true,period:paidPeriod()});
 const made=await addProduct("package-owner@example.test","Sessions","","120",null);assert.ok(made.ok);
 store=(await storeForEmail("package-owner@example.test"))!;product=(await readListing(store,made.product.id))!;
 globalThis.fetch=(async()=>{throw Error("Synthetic fixture: no real provider allowed");}) as typeof fetch;
});
afterEach(()=>{globalThis.fetch=originalFetch;});
async function mustRefuse(value:Parameters<typeof recordPackage>[0]["session"],calls?:()=>number){
 let error:unknown,got:Bought|null=null;
 try{got=await record(value);}catch(e){error=e;}
 assert.deepEqual({refused:error instanceof Error,stored:redis.run(["GET",key()])!==null,total:got?.total??null,until:got?.until??null,...(calls?{getterCalls:calls()}: {})},
 {refused:true,stored:false,total:null,until:null,...(calls?{getterCalls:0}: {})});
}
test("I2 explicit own zero payment/no expiry and a normal paid package remain valid",async()=>{
 const own={...session(),amount_total:0,metadata:{kind:"package",sessions:"5",days:"0"}};
 const got=await record(own);assert.ok(got);assert.equal(got.until,0);assert.equal(got.total,5);assert.deepEqual(await readBought(checkout),got);
});
test("I2 inherited zero days is missing paid validity, never a new unlimited grant",async()=>{
 const meta=Object.assign(Object.create({days:"0"}),{kind:"package",sessions:"5"});
 assert.equal(Object.hasOwn(meta,"days"),false);await mustRefuse({...session(),metadata:meta});
});
test("I2 inherited session count is not a confirmed paid quantity",async()=>{
 const meta=Object.assign(Object.create({sessions:"5"}),{kind:"package",days:"90"});
 assert.equal(Object.hasOwn(meta,"sessions"),false);await mustRefuse({...session(),metadata:meta});
});
test("I2 inherited zero amount is not explicit zero payment",async()=>{
 const value=Object.assign(Object.create({amount_total:0}),session());delete value.amount_total;
 assert.equal(Object.hasOwn(value,"amount_total"),false);await mustRefuse(value);
});
test("I2 computed paid validity must be refused without evaluating its getter",async()=>{
 let calls=0;const meta:Record<string,string>={kind:"package",sessions:"5"};
 Object.defineProperty(meta,"days",{enumerable:true,get(){calls++;return"90";}});
 await mustRefuse({...session(),metadata:meta},()=>calls);
});
async function withPrototype(name:string,get:()=>unknown,work:()=>Promise<void>){
 const old=Object.getOwnPropertyDescriptor(Object.prototype,name);
 Object.defineProperty(Object.prototype,name,{configurable:true,get});
 try{await work();}finally{if(old)Object.defineProperty(Object.prototype,name,old);else Reflect.deleteProperty(Object.prototype,name);}
}
for(const field of ["until","holds"] as const)test(`I2 missing stored ${field} cannot be replaced by an inherited zero/empty value`,async()=>{
 const made=await record(session());assert.ok(made);
 const partial:Partial<Bought>={...made};delete partial[field];
 redis.run(["SET",key(),JSON.stringify(partial)]);
 let calls=0;
 await withPrototype(field,()=>{calls++;return field==="until"?0:[];},async()=>{
  let error:unknown,found:Bought|null=null;
  try{found=await readBought(checkout);}catch(e){error=e;}
  const state=found?await packageState(found):null;
  assert.deepEqual({refused:error instanceof Error,accepted:Boolean(found),own:found?Object.hasOwn(found,field):false,left:state?.left??null,getterEvaluated:calls>0},
   {refused:true,accepted:false,own:false,left:null,getterEvaluated:false});
 });
});
test("I2 own retained fields remain usable under unrelated prototype values",async()=>{
 const made=await record(session());assert.ok(made);
 const held=await holdSession(store,checkout,"cs_test_i2heldsession0001",Math.floor(Date.now()/1000)+3600);assert.equal(held,true);
 let calls=0;
 await withPrototype("until",()=>{calls++;return 0;},async()=>withPrototype("holds",()=>{calls++;return [];},async()=>{
  const found=await readBought(checkout);assert.ok(found);
  assert.equal(Object.hasOwn(found,"until"),true);assert.equal(Object.hasOwn(found,"holds"),true);
  assert.equal((await packageState(found)).left,4);assert.equal(calls,0);
 }));
});
