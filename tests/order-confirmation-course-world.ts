/** Synthetic original input, never checkout/payment/consent proof. */
import assert from "node:assert/strict";
import { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";
export function courseCandidateWorld() {
  const store={sid:"a".repeat(32),statsId:"b".repeat(32),stripeAccountId:"acct_TestCourse01",handle:"original-course-store",
    name:"Original course store",email:"course-owner@example.test",currency:"usd",language:"en"};
  const product={id:"a1b2c3d4e5",title:"Original course title",priceCents:4500,course:{id:"d".repeat(32),lessons:4},
    call:null,podcast:null,recurring:null,bundle:null,keys:null,file:null,link:null,plan:null,pwyw:null,callPackage:null,shipping:null,note:false,options:[],fields:[]};
  const metadata={store:store.handle,product:product.id,dc:`yes:${EU_WITHDRAWAL_CONSENT_VERSION}:d:1793556000`,mm_admit:"498210"};
  return {store,product,metadata};
}


/** Actual persisted creator/store/catalog callers, still using only the
 * normal synthetic Redis/provider boundaries configured by the test runner. */
export async function realCourseCandidateWorld(handle="factory-course-store") {
  const {addProduct,claimHandle,ensureStatsId,ensureStoreId,setProductCourse,setStripeAccount,storeForEmail}=await import("@/lib/store");
  const {readProduct,readListing}=await import("@/lib/catalog");
  const {store:redis}=await import("./redis-stub");
  redis.clear();const owner="factory-course-owner@example.test";
  const claimed=await claimHandle(owner,handle,"Original course store","");assert.ok(claimed.ok);
  await ensureStatsId(owner);await ensureStoreId(owner);await setStripeAccount(owner,"acct_TestCourse01",true);
  const added=await addProduct(owner,"Original real course title","The original course","49",null);assert.ok(added.ok);
  await setProductCourse(owner,added.product.id,{id:"d".repeat(32),lessons:4});
  const store=(await storeForEmail(owner))!,product=(await readProduct(store,added.product.id))!;
  assert.ok(store);assert.ok(product);const listing=(await readListing(store,added.product.id))!;
  const metadata={store:store.handle,product:product.id,dc:`yes:${EU_WITHDRAWAL_CONSENT_VERSION}:d:1793556000`,mm_admit:"498210"};
  return {store,product,metadata,listing};
}
