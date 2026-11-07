import assert from "node:assert/strict";
import {test} from "node:test";
import {recordPrice,priorLowestPrice,unitPrice,readNetQuantity,checkProp65} from "@/lib/physical-legal";
const DAY=86400, T=1794009600;
test("healthy unit-price and sequential history controls",()=>{
 assert.deepEqual(unitPrice(249,readNetQuantity({amount:"250",unit:"g"})),{cents:996,unit:"kg",same:false});
 let h=recordPrice([],1000,T-40*DAY);h=recordPrice(h,20,T-2);h=recordPrice(h,10,T);
 assert.deepEqual(priorLowestPrice(h,T),{cents:20,complete:true});
});
test("two legitimate changes in one second cannot inflate the next sale's prior lowest price",()=>{
 let h=recordPrice([],1000,T-40*DAY);
 h=recordPrice(h,500,T);h=recordPrice(h,20,T);h=recordPrice(h,10,T+1);
 console.log("SAME_SECOND_HISTORY",JSON.stringify(h),JSON.stringify(priorLowestPrice(h,T+1)));
 assert.deepEqual(priorLowestPrice(h,T+1),{cents:20,complete:true});
});
test("an unreadable history step cannot certify a complete known prior price",()=>{
 const h=[{at:T-40*DAY,cents:1000},{at:T-2,cents:"20"}];
 const got=priorLowestPrice(h as unknown as Parameters<typeof priorLowestPrice>[0],T);
 assert.ok(got===null||got.complete===false,"malformed price evidence must not become a complete known reference");
});
test("warning shape must name the intended site rather than a suffix hostname",()=>{
 assert.equal(checkProp65("WARNING: Cancer - www.P65Warnings.ca.gov"),null);
 assert.equal(checkProp65("WARNING: Cancer - www.P65Warnings.ca.gov.example.invalid"),"site");
});
