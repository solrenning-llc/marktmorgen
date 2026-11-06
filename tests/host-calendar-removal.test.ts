import {test} from "node:test";
import assert from "node:assert/strict";
import {NextRequest} from "next/server";
import {POST} from "@/app/api/store/host-calendar/route";
import {openSession,SESSION_COOKIE} from "@/lib/auth";
import {claimHandle,ensureStatsId,setSubscription,storeForEmail} from "@/lib/store";
import {allowanceFor} from "@/lib/store-allowance-rules";
import {allowanceUsed,takeAllowance} from "@/lib/store-allowance";
import {ESSENTIAL_PER_DAY} from "@/lib/studio-allowance-rules";
import {paidPeriod} from "./billing-period-fixture";
import {store as redis} from "./redis-stub";
import {state} from "./host-calendar-removal-world";
globalThis.fetch=(async()=>{throw Error("Unexpected external request in synthetic route test");}) as typeof fetch;
test("actual calendar route preserves bounded withdrawal when integration allowance is exhausted",async()=>{
 redis.clear();
 const email="calendar-removal@example.com";
 await claimHandle(email,"calendarremoval","A store","");
 await ensureStatsId(email);
 await setSubscription(email,{customerId:"cus_CalendarRemoval01",subscriptionId:"sub_CalendarRemoval01",active:true,tier:"creator",cycle:"month",period:paidPeriod()});
 const store=(await storeForEmail(email))!;
 assert.ok(store.statsId);
 const token=await openSession(email);
 const request=(action:string,extra:Record<string,string>={})=>new NextRequest("https://local.example/api/store/host-calendar",{
  method:"POST",headers:{"Content-Type":"application/json",Origin:"https://local.example",Host:"local.example",Cookie:SESSION_COOKIE+"="+token,...extra},
  body:JSON.stringify({action,tz:"UTC",url:"https://calendar.example.test/private.ics"}),
 });
 const limit=allowanceFor(store,"integration");
 assert.ok(limit>0);
 assert.equal((await takeAllowance(store,"integration",limit)).ok,true);
 assert.equal(await allowanceUsed(store,"integration"),limit);
 assert.equal((await POST(request("disconnect"))).status,200);
 assert.equal((await POST(request("ics-remove"))).status,200);
 assert.deepEqual([state.disconnects,state.removals],[1,1]);
 for(const action of ["check","ics-add","disconnect-other"]){
  assert.equal((await POST(request(action))).status,429,action+" remains charged as service work");
 }
 assert.deepEqual([state.checks,state.adds],[0,0]);
 assert.equal(await allowanceUsed(store,"integration"),limit,"removal does not borrow or reset service allowance");
 const before=state.disconnects;
 assert.equal((await POST(request("disconnect",{Cookie:""}))).status,401);
 assert.equal((await POST(request("disconnect",{Origin:"https://other.example.test"}))).status,403);
 assert.equal((await POST(request("disconnect",{"content-length":"4001"}))).status,413);
 assert.equal(state.disconnects,before,"authentication/origin/size refusal precede removal");
 // Five authenticated actions above used the existing shared daily figure.
 for(let i=5;i<ESSENTIAL_PER_DAY;i++)assert.equal((await POST(request("disconnect"))).status,200);
 const admitted=state.disconnects;
 assert.equal((await POST(request("disconnect"))).status,429,"daily bound is still enforced");
 assert.equal(state.disconnects,admitted);
 assert.equal(await allowanceUsed(store,"integration"),limit);
 // A different authenticated store with allowance can still do productive work.
 const other="calendar-control@example.com";
 await claimHandle(other,"calendarcontrol","Other store","");
 await ensureStatsId(other);
 await setSubscription(other,{customerId:"cus_CalendarControl01",subscriptionId:"sub_CalendarControl01",active:true,tier:"creator",cycle:"month",period:paidPeriod()});
 const otherStore=(await storeForEmail(other))!;
 const otherToken=await openSession(other);
 assert.equal((await POST(request("check",{Cookie:SESSION_COOKIE+"="+otherToken}))).status,200);
 assert.equal(state.checks,1);
 assert.equal(await allowanceUsed(otherStore,"integration"),1);
});
