import { test } from "node:test";
import assert from "node:assert/strict";
import { ADD_ON_ROOM_CENTS, ASSISTANT_MESSAGES_MONTHLY, ASSISTANT_PRICE_CENTS, assistantMeetsFloor, assistantMonthWorst, assistantMostTaxNetShare, assistantReviewedNetShare } from "../lib/store-assistant-rules";
import { assessCustomerWorstCase } from "../lib/net-margin-rules";
import { mostCorrectTaxesOf } from "../lib/receiving-costs";
import type { CustomerTaxInput } from "../lib/customer-tax-review";
import { assistantTaxFixture, ASSISTANT_TAX_TEST_NOW as now } from "./store-assistant-tax-fixture";

test("absence of actual tax evidence stays unknown while costs and published rights remain known",()=>{
  const month=assistantMonthWorst();
  assert.equal(month.review.taxesCeilingCents,null);assert.equal(month.allowedCents,null);assert.equal(month.roomCents,null);
  assert.equal(month.review.allTaxesReviewed,false);assert.equal(assistantMeetsFloor(),false);
  assert.equal(assistantReviewedNetShare(),null);assert.equal(assistantMostTaxNetShare(),null);
  assert.equal(assessCustomerWorstCase(month.review).approved,false);
  assert.equal(ASSISTANT_PRICE_CENTS,6900);assert.equal(ASSISTANT_MESSAGES_MONTHLY,700);assert.equal(ADD_ON_ROOM_CENTS,25);
  assert.ok(Number.isSafeInteger(month.totalCents)&&month.totalCents>0);
});

test("real assessor uses annual BRL profit and each incoming exchange before explicit FX conversion",()=>{
  const input=assistantTaxFixture(),book=input.taxReview!.books[0];
  const expected=mostCorrectTaxesOf({currency:"BRL",annualProfitCents:book.annualProfitCents,incomingExchangeCents:book.exchanges.map(x=>x.brlCents)});
  assert.ok(expected);assert.equal(expected.iofCents,40); // ceil(10001*.0038)+ceil(3*.0038)
  const month=assistantMonthWorst(700,input,now),tax=Math.ceil(expected.totalTaxCents/5)+5;
  assert.equal(month.review.taxesCeilingCents,tax);assert.equal(month.allowedCents,6900-tax-1);
  assert.equal(month.roomCents,6900-tax-1-month.totalCents);
  const assessed=assessCustomerWorstCase(month.review);assert.equal(assessed.approved,true);
  assert.equal(assistantMeetsFloor(700,input,now),true);
  assert.equal(assistantReviewedNetShare(input,now),assessed.netCents!/6900);
  assert.equal(assistantMostTaxNetShare(input,now),assistantReviewedNetShare(input,now));
});

test("the existing 25-cent room is exact and never earns a new tax credit",()=>{
  for(const room of [24,25]) {
    const input=assistantTaxFixture(),base=assistantMonthWorst(700,input,now);
    const targetTax=base.revenueCents-base.totalCents-1-room;
    const extra=targetTax-base.review.taxesCeilingCents!;
    assert.ok(extra>0);input.taxReview!.components.brazilOther.usdCents+=extra;
    const adjusted=assistantMonthWorst(700,input,now);
    assert.equal(adjusted.roomCents,room);assert.equal(adjusted.review.taxesCeilingCents,targetTax);
    assert.equal(assistantMeetsFloor(700,input,now),room===25);
  }
});

test("reviewed losses stay negative, while two calendar books retain their separate annual bases",()=>{
  const loss=assistantTaxFixture(),base=assistantMonthWorst(700,loss,now);
  loss.taxReview!.components.brazilOther.usdCents+=base.revenueCents-base.totalCents-base.review.taxesCeilingCents!+1;
  assert.equal(assistantReviewedNetShare(loss,now),-1/6900);assert.equal(assistantMeetsFloor(700,loss,now),false);
  const input=assistantTaxFixture(),review=input.taxReview!,original=review.books[0],profit=original.annualProfitCents;
  const scope={scenario:"store_assistant_month_full",from:"2026-12-15",through:"2027-01-15",months:1 as const};
  input.taxContext={...scope};review.scope={...scope};review.fx.from=scope.from;review.fx.through=scope.through;
  review.books=[{...original,year:2026,annualProfitCents:Math.floor(profit/2),exchanges:[{...original.exchanges[0],at:"2026-12-20"}]},
    {...original,year:2027,annualProfitCents:profit-Math.floor(profit/2),exchanges:[{...original.exchanges[1],at:"2027-01-05"}]}];
  const taxes=review.books.map(book=>mostCorrectTaxesOf({currency:"BRL",annualProfitCents:book.annualProfitCents,incomingExchangeCents:book.exchanges.map(x=>x.brlCents)})!);
  assert.equal(assistantMonthWorst(700,input,new Date("2026-12-20T00:00:00Z")).review.taxesCeilingCents,Math.ceil(taxes.reduce((sum,tax)=>sum+tax.totalTaxCents,0)/5)+5);
});

test("wrong scenario, stale period, missing FX or missing annual book never become zero",()=>{
  for(const mutate of [
    (i:CustomerTaxInput)=>{i.taxContext!.scenario="creator_month_full";i.taxReview!.scope.scenario="creator_month_full";},
    (i:CustomerTaxInput)=>{i.taxContext!.months=12;i.taxReview!.scope.months=12;},
    (i:CustomerTaxInput)=>{delete(i.taxReview!.fx as {usdToBrl?:unknown}).usdToBrl;},
    (i:CustomerTaxInput)=>{i.taxReview!.books=[];},
  ]) {
    const input=assistantTaxFixture();mutate(input);
    const month=assistantMonthWorst(700,input,now);
    assert.equal(month.review.taxesCeilingCents,null);assert.equal(month.roomCents,null);assert.equal(assistantMeetsFloor(700,input,now),false);
  }
  const input=assistantTaxFixture();
  for(const at of [new Date("2026-09-30T23:59:59.999Z"),new Date("2026-11-01T00:00:00Z"),new Date("2026-11-20T12:00:00Z"),new Date(NaN)]) {
    assert.equal(assistantMonthWorst(700,input,at).review.taxesCeilingCents,null);
    assert.equal(assistantMeetsFloor(700,input,at),false);
  }
});

test("fiscal input is captured once without getters, hidden fields or mutable follow-up reads",()=>{
  let getters=0,reads=0;const valid=assistantTaxFixture();
  const getter=Object.defineProperty({...valid},"taxReview",{get(){getters++;return valid.taxReview;}});
  assert.equal(assistantMonthWorst(700,getter,now).review.taxesCeilingCents,null);assert.equal(getters,0);
  const hidden=Object.defineProperty({...valid},"taxContext",{value:valid.taxContext,enumerable:false});
  assert.equal(assistantMeetsFloor(700,hidden,now),false);
  const source=new Proxy(valid,{getOwnPropertyDescriptor(target,key){
    if(key==="taxContext") {reads++;return Reflect.getOwnPropertyDescriptor(reads===1?target:{...target,taxContext:null},key);}
    return Reflect.getOwnPropertyDescriptor(target,key);
  }});
  const month=assistantMonthWorst(700,source,now);
  assert.equal(reads,1);assert.equal(assessCustomerWorstCase(month.review).approved,true);
  valid.taxReview!.books[0].annualProfitCents=0;valid.taxContext!.through="2030-01-01";
  assert.equal(assessCustomerWorstCase(month.review).approved,true);
});

test("invalid or overflowing usage cannot approve a month",()=>{
  for(const messages of [-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    assert.equal(assistantMeetsFloor(messages,assistantTaxFixture(),now),false);
    assert.throws(()=>assistantMonthWorst(messages),RangeError);
  }
  assert.equal(assistantMeetsFloor(Number.MAX_SAFE_INTEGER,assistantTaxFixture(),now),false);
  assert.ok(Number.isSafeInteger(assistantMonthWorst(Number.MAX_SAFE_INTEGER).totalCents));
});
