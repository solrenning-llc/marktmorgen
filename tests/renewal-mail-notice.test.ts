import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { renewalMailSummary, RENEWAL_NOTICE_SCRIPT } from "@/lib/renewal-mail-notice";
import { RenewalMailNotice } from "@/components/renewal-mail-notice";
import { shipmentPolicy } from "./shipment-mail-outbox-fixture";
import { confirmationLocalPipeline } from "./order-confirmation-paid-fixture";
import type { Store } from "@/lib/store";
const store = {statsId:"NoticeSynthetic",stripeAccountId:"acct_TestNotice01"} as Store;
test("inactive and missing funding never read pending rows",async()=>{
 let reads=0;const pipeline=async()=>{reads++;throw Error("not permitted");};
 assert.equal(await renewalMailSummary(store,{lifecycle:"never_activated",pipeline}),null);
 assert.deepEqual(await renewalMailSummary(store,{lifecycle:"active",policy:null,pipeline}),{unavailable:true});
 assert.equal(reads,0);
});
test("bounded aggregate ACK and owner exit never expose a row or claim delivery",async()=>{
 const pipeline=async(commands: (string|number)[][])=>{assert.equal(commands.length,1);assert.equal(commands[0][1],RENEWAL_NOTICE_SCRIPT);assert.equal(commands[0][2],1);return [["ok",8,8,0]];};
 const runtime={lifecycle:"active" as const,policy:shipmentPolicy(),pipeline};
 assert.deepEqual(await renewalMailSummary(store,runtime),{pending:8,unconfirmed:8,held:0});
 const html=renderToStaticMarkup((await RenewalMailNotice({store,runtime}))!);
 assert.match(html,/8 request\(s\) have unconfirmed/);assert.match(html,/mailto:support@marktmorgen.com/);
 assert.match(html,/Do not resend or delete/);assert.doesNotMatch(html,/token=|origin=|will be emailed/);
});
test("malformed or excessive summaries are unknown rather than empty",async()=>{
 for(const response of [null,[],[["ok",9,9,0]],[["ok",1,1,1]],[["ok",1,NaN,0]],[["ok","1",0,0]],[["unknown"]]]){
  assert.deepEqual(await renewalMailSummary(store,{lifecycle:"active",policy:shipmentPolicy(),pipeline:async()=>response as never}),{unavailable:true});
 }
});
const native=process.env.MARKTMORGEN_REDIS_INTEGRATION==="1"&&Boolean(process.env.CONFIRMATION_ORIGIN_REDIS_PORT);
test("native Lua caps the index before rows, aggregates eight and never mutates uncertain custody",{skip:!native},async()=>{
 const key=`nl:order-confirmation:renewal:store:${store.statsId}`;
 const ids=Array.from({length:9},(_,i)=>createHash("sha256").update(`notice-synthetic-${i}`).digest("hex"));
 const keys=[key,...ids.map(id=>`nl:order-confirmation:row:${id}`)];
 const runtime={lifecycle:"active" as const,policy:shipmentPolicy(),pipeline:confirmationLocalPipeline};
 try{
  await confirmationLocalPipeline([["DEL",...keys]]);
  for(const [i,id] of ids.entries()){
   await confirmationLocalPipeline([["SADD",key,id],["SET",keys[i+1],JSON.stringify({id,originKind:"single_digital_renewal",statsId:store.statsId,accountId:store.stripeAccountId,state:i<4?"dispatching":"queued",next:0,sealed:"private-capsule-token"})]]);
   if(i===7){assert.deepEqual(await renewalMailSummary(store,runtime),{pending:8,unconfirmed:4,held:4});}
  }
  assert.deepEqual(await renewalMailSummary(store,runtime),{unavailable:true});
  assert.deepEqual(await confirmationLocalPipeline([["SCARD",key],["TTL",keys[1]]]),[9,-1]);
  await confirmationLocalPipeline([["SREM",key,ids[8]],["SET",keys[1],"x".repeat(131073)]]);
  assert.deepEqual(await renewalMailSummary(store,runtime),{unavailable:true});
 }finally{await confirmationLocalPipeline([["DEL",...keys]]);}
});
