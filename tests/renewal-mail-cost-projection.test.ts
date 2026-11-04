import {test} from "node:test";
import assert from "node:assert/strict";
import {renewalNoticeCost,COST_LINES} from "./plan-cost-registry";
import {netOf,worstCost} from "./plan-cost-model";
import {PRICES_WITHOUT_COMMISSION} from "@/lib/plan";
test("CX64 reports active projection without enabling it or relaxing the relative margin gate",()=>{
 const line=COST_LINES.find(x=>x.id==="renewal-mail-owner-notice");assert.ok(line);
 const rows=[];
 for(const cycle of ["month","year"] as const)for(const tier of ["pro","scale"] as const){
  const net=netOf(tier,cycle,PRICES_WITHOUT_COMMISSION),baseline=worstCost(tier)-line.monthlyUsd(tier),delta=renewalNoticeCost(tier);
  assert.ok(Number.isFinite(delta)&&delta>0);
  rows.push({cycle,tier,netAfterProviderFees:net,worstBefore:baseline,extra:delta,worstAfter:baseline+delta,relativeBefore:(net-baseline)/net,relativeAfter:(net-baseline-delta)/net});
 }
 for(const cycle of ["month","year"] as const){const pro=rows.find(r=>r.cycle===cycle&&r.tier==="pro")!,scale=rows.find(r=>r.cycle===cycle&&r.tier==="scale")!;assert.ok(scale.relativeAfter>=pro.relativeAfter,cycle+": active projection must preserve Scale >= Pro");}
 console.log(JSON.stringify({context:"same provider-net comparison as plan-margin; not owner TX profit or funding certification",rows}));
});
