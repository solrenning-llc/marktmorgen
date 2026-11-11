import assert from "node:assert/strict";
import test from "node:test";
import {measureSalesLevers,salesLeverSettings} from "@/lib/sales-levers";
import {claimHandle,storeForEmail,addProduct} from "@/lib/store";
import {store as redis} from "./redis-stub";
const now=Date.parse("2026-10-20T12:00:00Z");
const sale=(meta:Record<string,string>,cents=1200,upsell=false,currency="usd")=>({created:now-60000,cents,currency,upsell,row:{metadata:meta}});
test("a record without Stripe's own date and amount is never credited to a lever; the reading says it is incomplete",()=>{
 // These rows carry only metadata, as a record whose answer lacked created and amount_total would (lib/stats.ts then dates it "now").
 const reading=measureSalesLevers([sale({bump:"extra001",bump_cents:"1200"}),sale({bundle:"inside001"},2400),sale({kind:"upsell"},500,true),sale({bump:"extra001"},9900,false,"eur")],"usd",false,now);
 assert.equal(reading.complete,false);
 for(const key of ["bump","upsell","downsell","bundle"] as const){const row=reading.rows[key];assert.ok("measured" in row&&row.measured);assert.deepEqual(row.amounts,[{currency:"usd",cents:0,orders:0}]);}
 for(const key of ["recovery","next"] as const){const row=reading.rows[key];assert.ok("measured" in row&&!row.measured);}
});
test("reviewing lever settings cannot enable paid/opted-out features or contact a provider",async()=>{
 redis.clear();await claimHandle("levers@example.test","leversfixture","Synthetic levers","");
 const store=(await storeForEmail("levers@example.test"))!;const before=JSON.stringify(store);
 const settings=salesLeverSettings(store);assert.equal(settings.length,6);
 assert.match(settings.find(s=>s.key==="recovery")!.state,/Off/);assert.match(settings.find(s=>s.key==="next")!.state,/Off/);
 assert.equal(JSON.stringify(store),before);
 const product=await addProduct("levers@example.test","Synthetic product","","12");assert.ok(product.ok);
 assert.match(salesLeverSettings(product.store).find(s=>s.key==="upsell")!.state,/No visible/);
});
