/** Independent review of #2020 source d3de8a0b. Synthetic store/provider only. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {renewalFixture} from "./single-digital-access-renewal-world";
import {enqueueSingleDigitalRenewal,readSingleDigitalRenewalOrigin} from "@/lib/order-confirmation-outbox";
import {SHIPMENT_MAIL_SCRIPT} from "@/lib/shipment-mail-outbox";

test("G2 control: a known clock admits the protected renewal",async()=>{
 const f=await renewalFixture();
 const result=await enqueueSingleDigitalRenewal(f.store,f.url.searchParams.get("origin")!,"a".repeat(64),f.runtime);
 assert.ok(result.ok);
 assert.ok(await readSingleDigitalRenewalOrigin(result.id,f.runtime));
});

test("G2: an unknown local clock after Redis TIME cannot admit a new retained liability",async()=>{
 const f=await renewalFixture(),pipeline=f.runtime.pipeline!;
 f.runtime.pipeline=async commands=>{
  const reply=await pipeline(commands);
  if(commands.some(c=>c[0]==="TIME"))f.runtime.now=()=>NaN;
  return reply;
 };
 const result=await enqueueSingleDigitalRenewal(f.store,f.url.searchParams.get("origin")!,"b".repeat(64),f.runtime);
 const writes=f.commands.filter(c=>c[0]==="EVAL"&&c[1]===SHIPMENT_MAIL_SCRIPT);
 console.log("G2_UNKNOWN_CLOCK",JSON.stringify({result,newRetainedWrites:writes.length}));
 assert.equal(writes.length,0,"clock uncertainty must refuse before the paid persistent write");
 assert.deepEqual(result,{ok:false,reason:"unknown"});
});
