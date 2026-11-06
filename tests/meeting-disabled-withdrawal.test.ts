import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {NextRequest} from "next/server";
import {POST} from "@/app/api/integrations/meetings/route";
import {openSession,SESSION_COOKIE} from "@/lib/auth";
import {claimHandle,ensureStatsId,setSubscription,storeForEmail} from "@/lib/store";
import {isConfigured} from "@/lib/meet-providers";
import {redisPipeline} from "@/lib/redis";
import {allowanceFor} from "@/lib/store-allowance-rules";
import {allowanceUsed,takeAllowance} from "@/lib/store-allowance";
import {paidPeriod} from "./billing-period-fixture";
import {store as redis} from "./redis-stub";
import {afterTasks} from "./next-server-after-world";
import {state} from "./meeting-disabled-world";
globalThis.fetch=(async()=>{throw Error("Unexpected external request in synthetic withdrawal test");}) as typeof fetch;
test("disabled meeting providers still allow authenticated bounded cleanup of stored connections",async()=>{
 const names=["GOOGLE_OAUTH_CLIENT_ID","GOOGLE_OAUTH_CLIENT_SECRET","ZOOM_CLIENT_ID","ZOOM_CLIENT_SECRET","ZOOM_WEBHOOK_SECRET_TOKEN"];
 const before=names.map(name=>process.env[name]);
 try{
  for(const name of names)delete process.env[name];
  redis.clear();afterTasks.length=0;
  assert.equal(isConfigured("google"),false);
  assert.equal(isConfigured("zoom"),false);
  const email="meeting-withdrawal@example.com";
  await claimHandle(email,"meetingwithdrawal","A store","");
  await ensureStatsId(email);
  await setSubscription(email,{customerId:"cus_MeetingWithdrawal01",subscriptionId:"sub_MeetingWithdrawal01",active:true,tier:"creator",cycle:"month",period:paidPeriod()});
  const store=(await storeForEmail(email))!;
  assert.ok(store.statsId);
  const token=await openSession(email);
  const request=(action:string,provider="google",extra:Record<string,string>={})=>new NextRequest("https://local.example/api/integrations/meetings",{
   method:"POST",headers:{"Content-Type":"application/json",Origin:"https://local.example",Host:"local.example",Cookie:SESSION_COOKIE+"="+token,...extra},
   body:JSON.stringify({action,provider}),
  });
  const key=(provider:string)=>"nl:meet:conn:"+store.statsId+":"+provider;
  const testKey=(provider:string)=>"nl:meet:test:"+store.statsId+":"+provider;
  const userKey=(provider:string)=>"nl:meet:user:"+provider+":"+createHash("sha256").update("meet-user:"+provider+":synthetic-account").digest("hex").slice(0,40);
  const seed=async(provider:"google"|"zoom")=>{
   // Deliberately unreadable old secrets: actual cleanup must forget these too.
   // No provider revocation or real email is claimed by this synthetic test.
   await redisPipeline([
    ["SET",key(provider),JSON.stringify({provider,account:{id:"synthetic-account",email:"account@example.test",name:"Account"},access:"",refresh:"",expires:0,scope:"",connectedAt:1,by:email,owner:{email,handle:store.handle},broken:"",brokenAt:0})],
    ["SET",testKey(provider),"synthetic-old-meeting"],
    ["SADD",userKey(provider),store.statsId!],
   ]);
  };
  for(const provider of ["google","zoom"] as const){
   await seed(provider);
   const response=await POST(request("disconnect",provider));
   assert.equal(response.status,200,provider);
   assert.equal((await response.json()).ok,true);
   assert.deepEqual(await redisPipeline([["GET",key(provider)],["GET",testKey(provider)],["SMEMBERS",userKey(provider)]]),[null,null,[]]);
  }
  assert.equal(afterTasks.length,2,"one notice scheduled for each actual old connection");
  for(const task of afterTasks)await (task as ()=>Promise<unknown>)();
  assert.equal(state.notices,2);
  assert.equal((await POST(request("disconnect"))).status,200,"already disconnected remains idempotent");
  assert.equal(afterTasks.length,2,"no notice for a missing connection");
  for(const action of ["test","movetest","untest","disconnect-other"]){
   assert.equal((await POST(request(action))).status,400,action);
  }
  assert.equal((await POST(request("disconnect","unknown"))).status,400);
  assert.deepEqual([state.tests,state.moves,state.removes],[0,0,0]);
  // Authentication, origin and body-size checks still precede cleanup.
  await seed("google");
  assert.equal((await POST(request("disconnect","google",{Cookie:""}))).status,401);
  assert.equal((await POST(request("disconnect","google",{Origin:"https://other.example.test"}))).status,403);
  assert.equal((await POST(request("disconnect","google",{"content-length":"2001"}))).status,413);
  assert.notEqual((await redisPipeline([["GET",key("google")]]))[0],null);
  // Positive configured action proves the route is not blanket-disabled.
  process.env.GOOGLE_OAUTH_CLIENT_ID="synthetic-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET="synthetic-secret";
  assert.equal((await POST(request("test"))).status,200);
  assert.equal(state.tests,1);
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  // No essential reclassification or uncapped cleanup: existing integration
  // and studio admission remain in place, including when provider keys are off.
  const used=await allowanceUsed(store,"integration");
  const remaining=allowanceFor(store,"integration")-used;
  assert.ok(remaining>0);
  assert.equal((await takeAllowance(store,"integration",remaining)).ok,true);
  assert.equal((await POST(request("disconnect"))).status,429);
  assert.notEqual((await redisPipeline([["GET",key("google")]]))[0],null);
  assert.equal(afterTasks.length,2);
 }finally{
  names.forEach((name,index)=>{if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index];});
 }
});
