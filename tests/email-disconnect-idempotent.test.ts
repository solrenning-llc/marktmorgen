import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {NextRequest} from "next/server";
import {POST} from "@/app/api/store/email-sync/route";
import {openSession,SESSION_COOKIE} from "@/lib/auth";
import {claimHandle,setSubscription,storeForEmail} from "@/lib/store";
import {redisPipeline} from "@/lib/redis";
import {allowanceUsed} from "@/lib/store-allowance";
import {paidPeriod} from "./billing-period-fixture";
import {store as redis} from "./redis-stub";
import {afterTasks} from "./next-server-after-world";
import {notices} from "./email-disconnect-world";
globalThis.fetch=(async()=>{throw Error("Unexpected external request in synthetic email withdrawal test");}) as typeof fetch;
test("actual email withdrawal preserves missing legacy identifiers and retained cleanup",async()=>{
 redis.clear();afterTasks.length=0;notices.length=0;
 const email="email-withdrawal@example.com";
 await claimHandle(email,"emailwithdrawal","A store","");
 await setSubscription(email,{customerId:"cus_EmailWithdrawal01",subscriptionId:"sub_EmailWithdrawal01",active:true,tier:"creator",cycle:"month",period:paidPeriod()});
 // New stores now have statistics ids. This models an explicitly supported
 // legacy record: parseStore reads an absent statsId as null, not a new id.
 const ownerKey="nl:store:owner:"+createHash("sha256").update("nimbus-store:"+email).digest("hex").slice(0,40);
 const [raw]=await redisPipeline([["GET",ownerKey]]);
 assert.equal(typeof raw,"string");
 const legacy=JSON.parse(raw as string);
 delete legacy.statsId;
 await redisPipeline([["SET",ownerKey,JSON.stringify(legacy)]]);
 const before=(await storeForEmail(email))!;
 assert.equal(before.statsId,null);
 const token=await openSession(email);
 const request=(action:string,extra:Record<string,string>={})=>new NextRequest("https://local.example/api/store/email-sync",{
  method:"POST",headers:{"Content-Type":"application/json",Origin:"https://local.example",Host:"local.example",Cookie:SESSION_COOKIE+"="+token,...extra},
  body:JSON.stringify({action}),
 });
 for(const [headers,status] of [[{Cookie:""},401],[{Origin:"https://other.example.test"},403],[{"content-length":"40001"},413]] as const){
  assert.equal((await POST(request("disconnect",headers))).status,status);
 }
 assert.equal((await storeForEmail(email))!.statsId,null);
 for(let i=0;i<2;i++){
  const response=await POST(request("disconnect"));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.ok,true);
  assert.equal(body.view.connected,null);
  assert.deepEqual(body.view.log,[]);
  assert.equal((await storeForEmail(email))!.statsId,null,"absent withdrawal does not allocate an identifier");
 }
 assert.equal(afterTasks.length,0,"there was no connection to notify about");
 assert.equal(await allowanceUsed(before,"integration"),0,"existing withdrawal exception retained");
 assert.equal(await allowanceUsed(before,"studio"),2,"both successful requests still consume settings admission");
 // An action that needs platform state keeps its existing allocation and
 // service metering; no platform is connected, so it truthfully refuses.
 const targets=await POST(request("targets"));
 assert.equal(targets.status,400);
 assert.equal((await targets.json()).error,"refused");
 const allocated=(await storeForEmail(email))!;
 assert.ok(allocated.statsId);
 const id=allocated.statsId;
 assert.equal(await allowanceUsed(allocated,"integration"),1);
 // A retained connection with an unreadable old secret is still forgotten
 // through the actual backend, without asking the external platform.
 const cfg="nl:esync:cfg:"+id,tags="nl:esync:tags:"+id,bad="nl:esync:bad:"+id;
 await redisPipeline([
  ["SET",cfg,JSON.stringify({provider:"mailchimp",key:"unreadable-fixture",last4:"ture",target:null,free:true,buyers:"all",products:[],tags:{},since:1,connectedAt:1,handle:allocated.handle})],
  ["HSET",tags,"mailchimp|old-tag","synthetic-tag"],
  ["SET",bad,JSON.stringify({message:"Old key cannot be opened",at:1})],
 ]);
 const removed=await POST(request("disconnect"));
 assert.equal(removed.status,200);
 assert.equal((await removed.json()).view.connected,null);
 assert.deepEqual(await redisPipeline([["EXISTS",cfg],["EXISTS",bad],["EXISTS",tags]]),[0,0,0]);
 assert.equal((await storeForEmail(email))!.statsId,id,"existing identifier remains unchanged");
 assert.equal(await allowanceUsed(allocated,"integration"),1,"removal does not reset or consume the service allowance");
 assert.equal(afterTasks.length,1);
 for(const task of afterTasks)await (task as ()=>Promise<unknown>)();
 assert.deepEqual(notices,["email-platform-removed"]);
 assert.equal((await POST(request("disconnect"))).status,200);
 assert.equal(afterTasks.length,1,"repeat removal has no duplicate notice");
 assert.equal((await storeForEmail(email))!.statsId,id);
});
