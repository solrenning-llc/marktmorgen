import {test} from "node:test";
import assert from "node:assert/strict";
import {renderToStaticMarkup} from "react-dom/server";
import {NextRequest} from "next/server";
import StudioMeetingsPage from "@/app/studio/meetings/page";
import {POST} from "@/app/api/integrations/meetings/route";
import {openSession,SESSION_COOKIE} from "@/lib/auth";
import {claimHandle,ensureStatsId,setSubscription,storeForEmail} from "@/lib/store";
import {redisPipeline} from "@/lib/redis";
import {paidPeriod} from "./billing-period-fixture";
import {store as redis} from "./redis-stub";
import {afterTasks} from "./next-server-after-world";
import {cookieValues} from "./meeting-withdrawal-page-world";
globalThis.fetch=(async()=>{throw Error("Unexpected external request in synthetic page journey");}) as typeof fetch;
test("actual authenticated meetings page remains truthful after the last disabled connection is removed",async()=>{
 const names=["GOOGLE_OAUTH_CLIENT_ID","GOOGLE_OAUTH_CLIENT_SECRET","ZOOM_CLIENT_ID","ZOOM_CLIENT_SECRET","ZOOM_WEBHOOK_SECRET_TOKEN"];
 const before=names.map(name=>process.env[name]);
 try{
  for(const name of names)delete process.env[name];
  redis.clear();cookieValues.clear();afterTasks.length=0;
  const visit=()=>StudioMeetingsPage({searchParams:Promise.resolve({})});
  await assert.rejects(visit,/redirect:\/signin/,"disabled services do not bypass authentication");
  const email="withdrawal-page@example.com";
  await claimHandle(email,"withdrawalpage","A store","");
  await ensureStatsId(email);
  await setSubscription(email,{customerId:"cus_WithdrawalPage01",subscriptionId:"sub_WithdrawalPage01",active:true,tier:"creator",cycle:"month",period:paidPeriod()});
  const store=(await storeForEmail(email))!;
  assert.ok(store.statsId);
  const token=await openSession(email);
  cookieValues.set(SESSION_COOKIE,token);
  const key="nl:meet:conn:"+store.statsId+":google";
  await redisPipeline([["SET",key,JSON.stringify({provider:"google",account:{id:"synthetic-account",email:"old-account@example.test",name:"Account"},access:"",refresh:"",expires:0,scope:"",connectedAt:1,by:email,owner:{email,handle:store.handle},broken:"",brokenAt:0})]]);
  const connected=renderToStaticMarkup(await visit());
  assert.ok(connected.includes("old-account@example.test"));
  assert.ok(connected.includes(">Disconnect</button>"));
  assert.ok(connected.includes(">Unavailable</span>"));
  assert.equal(connected.includes("/api/integrations/google/start"),false);
  assert.equal(connected.includes("data-meet-test"),false);
  const remove=()=>POST(new NextRequest("https://local.example/api/integrations/meetings",{
   method:"POST",headers:{"Content-Type":"application/json",Origin:"https://local.example",Host:"local.example",Cookie:SESSION_COOKIE+"="+token},
   body:JSON.stringify({action:"disconnect",provider:"google"}),
  }));
  const response=await remove();
  assert.equal(response.status,200);
  assert.equal((await response.json()).ok,true);
  assert.equal((await redisPipeline([["GET",key]]))[0],null,"actual backend forgets the connection");
  const empty=renderToStaticMarkup(await visit());
  assert.ok(empty.includes("No video call accounts are connected."),"refresh renders the actual page instead of throwing404");
  for(const text of ["old-account@example.test",">Disconnect</button>","You can disconnect an account below","data-meet-test","/api/integrations/google/start"])assert.equal(empty.includes(text),false,text);
  assert.equal(afterTasks.length,1,"only actual removal schedules the existing notice");
  assert.equal((await remove()).status,200);
  assert.ok(renderToStaticMarkup(await visit()).includes("No video call accounts are connected."));
  assert.equal(afterTasks.length,1,"idempotent removal does not add a notice");
  cookieValues.clear();
  await assert.rejects(visit,/redirect:\/signin/,"empty state still requires the session");
 }finally{
  cookieValues.clear();
  names.forEach((name,index)=>{if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index];});
 }
});
