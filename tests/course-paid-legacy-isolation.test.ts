import assert from "node:assert/strict";
import {test} from "node:test";
import {addProduct,claimHandle,ensureStatsId,setProductCourse,setStripeAccount,setPastBuyers,storeForEmail} from "@/lib/store";
import {readProduct} from "@/lib/catalog";
import {grantImported} from "@/lib/imported-purchases";
import {courseAccess,mintPass,passCookieName,setBlocked} from "@/lib/learn";
import {store as redis} from "./redis-stub";
import {observeUnverifiedCoursePaidReplies,observeCurrentCoursePaidSource} from "@/lib/course-paid-observation";
import {paidObservationWorld} from "./course-paid-observation-world";

test("observations never mutate or remove independent authenticated import/gift/manual/PayPal rights",async()=>{
 const original=fetch,secret=process.env.STRIPE_SECRET_KEY;process.env.STRIPE_SECRET_KEY="sk_test_course_observation_synthetic";let lists=0,exact=0;
 globalThis.fetch=async input=>{const u=new URL(String(input));if(u.pathname==="/v1/checkout/sessions"){lists++;assert.equal(u.searchParams.get("limit"),"100");return Response.json({object:"list",has_more:true,data:Array.from({length:100},(_,i)=>({id:`cs_test_unrelatedSynthetic${i}0001`,status:"complete",payment_status:"paid",created:1793556000,metadata:{store:"observation-school",product:"not-the-target"}}))});}exact++;throw Error("Only synthetic list reads expected in the existing legacy flow");};
 try{redis.clear();const owner="observation-owner@example.test";assert.ok((await claimHandle(owner,"observation-school","School","")).ok);await ensureStatsId(owner);await setStripeAccount(owner,"acct_TestCourse01",true);await setPastBuyers(owner);
  const made=await addProduct(owner,"Original course","Original content","49",null);assert.ok(made.ok);await setProductCourse(owner,made.product.id,{id:"a".repeat(32),lessons:1});const store=(await storeForEmail(owner))!,product=(await readProduct(store,made.product.id))!;assert.ok(product.course);
  for(const [who,job]of [["import@example.test","c".repeat(24)],["gift@example.test","gift:synthetic01"],["manual@example.test","api:manual01"],["paypal@example.test","paypal:synthetic01"]]){
   await grantImported(store.statsId!,job,[{email:who,productId:product.id,items:null}],1793293200,store.sid);const token=await mintPass(store,who,"all"),cookies={get:(name:string)=>name===passCookieName(store)?{value:token}:undefined};
   assert.equal((await courseAccess(store,product,cookies)).state,"open");
   const w=paidObservationWorld();Object.assign(w.bodies[2],{refunded:true,amount_refunded:5000});assert.equal(observeUnverifiedCoursePaidReplies(w.reference,w.trace).outcome,"fully_refunded");observeCurrentCoursePaidSource({futurePaidSource:w.reference});
   assert.equal((await courseAccess(store,product,cookies)).state,"open","an unrelated paid-source observation cannot take an independent right back");
   await setBlocked(store,product.course!.id,who,true);assert.equal((await courseAccess(store,product,cookies)).state,"closed");await setBlocked(store,product.course!.id,who,false);assert.equal((await courseAccess(store,product,cookies)).state,"open");
  }
  assert.ok(lists>0);assert.equal(exact,0);assert.equal((await courseAccess(store,product,{get:()=>undefined})).state,"closed","no observation authenticates an anonymous learner");
 }finally{globalThis.fetch=original;if(secret===undefined)delete process.env.STRIPE_SECRET_KEY;else process.env.STRIPE_SECRET_KEY=secret;}
});
