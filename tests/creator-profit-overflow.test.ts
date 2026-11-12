import assert from 'node:assert/strict';
import {test} from 'node:test';
import {orderProfit,periodProfit,productKey,productProfit,type OrderMoney,type ChargedLine,type Profit} from '../lib/creator-profit-rules';
const MAX=Number.MAX_SAFE_INTEGER;
const order=(paid:number):OrderMoney=>({currency:'usd',paid,refunded:0,fee:0,otherCosts:0,lines:[{productId:'p1',units:1,costPerSale:0}]});
const loss=():OrderMoney=>({...order(MAX),refunded:MAX,lines:[{productId:'p1',units:MAX,costPerSale:1}]});
const charged=(input:OrderMoney):Omit<OrderMoney,'lines'>&{lines:ChargedLine[]}=>({...input,lines:input.lines.map(line=>({...line,charged:input.paid??0}))});
const key=productKey('usd','p1',null);
const preciseCost=():OrderMoney=>({...order(MAX),lines:[{productId:'p1',units:90_071_995,costPerSale:99_999_999}]});
const exact=(value:bigint):Profit=>value>BigInt(MAX)||value<BigInt(-MAX)?{state:'unavailable'}:{state:'complete',cents:Number(value)};

test('an exact small order loss cannot inherit rounded cost multiplication',()=>{
 const input=preciseCost();
 const expected=BigInt(MAX)-BigInt(99_999_999)*BigInt(90_071_995);
 assert.deepEqual(orderProfit(input),exact(expected));
});
test('a product keeps the same exact order loss after allocating charges',()=>{
 const expected=BigInt(MAX)-BigInt(99_999_999)*BigInt(90_071_995);
 assert.deepEqual(productProfit([charged(preciseCost())]).get(key),exact(expected));
});
test('period sums cannot label an unsafe aggregate as complete',()=>{
 assert.deepEqual(periodProfit([order(MAX),order(1)],{}).get('usd'),{state:'unavailable'});
});
test('ad subtraction cannot label an unsafe aggregate loss as complete',()=>{
 assert.deepEqual(periodProfit([loss()],{usd:1}).get('usd'),{state:'unavailable'});
});
test('period cancellation retains exact cents after an unsafe intermediate sum',()=>{
 for(const list of [[order(MAX),order(2),loss()],[loss(),order(2),order(MAX)],[order(2),order(MAX),loss()]])assert.deepEqual(periodProfit(list,{}).get('usd'),{state:'complete',cents:2});
});
test('product sums cannot label an unsafe aggregate as complete',()=>{
 assert.deepEqual(productProfit([charged(order(MAX)),charged(order(1))]).get(key),{state:'unavailable'});
});
test('product cancellation retains exact cents independent of order sequence',()=>{
 for(const list of [[order(MAX),order(2),loss()],[loss(),order(2),order(MAX)],[order(2),order(MAX),loss()]])assert.deepEqual(productProfit(list.map(charged)).get(key),{state:'complete',cents:2});
});
test('case aliases cannot overwrite an unknown or ambiguous ad cost',()=>{
 for(const first of [null,0,100]){
  const result=periodProfit([order(1000)],{USD:first,usd:0,eur:20});
  assert.deepEqual(result.get('usd'),{state:'unavailable'});
  assert.deepEqual(result.get('eur'),{state:'complete',cents:-20});
 }
 assert.deepEqual(periodProfit([],{USD:25}).get('usd'),{state:'complete',cents:-25});
});
test('known zero, refunds, losses, missing cost and separate currencies keep their meanings',()=>{
 assert.deepEqual(orderProfit(order(0)),{state:'complete',cents:0});
 assert.deepEqual(periodProfit([order(10),{...order(12),currency:'EUR'}],{USD:15}).get('usd'),{state:'complete',cents:-5});
 assert.deepEqual(periodProfit([order(10),{...order(12),currency:'EUR'}],{USD:15}).get('eur'),{state:'complete',cents:12});
 assert.deepEqual(orderProfit({...order(10),fee:null}),{state:'unavailable'});
 assert.deepEqual(orderProfit({...order(10),lines:[{productId:'p1',units:1,costPerSale:null}]}),{state:'incomplete',why:'cost not set'});
});
test('near-boundary cost arithmetic agrees with an independent integer oracle',()=>{
 for(let i=0;i<64;i++){
  const cost=99_999_999-i,units=90_071_995+i;
  const input={...order(MAX),lines:[{productId:'p1',units,costPerSale:cost}]};
  assert.deepEqual(orderProfit(input),exact(BigInt(MAX)-BigInt(cost)*BigInt(units)),`${cost} * ${units}`);
 }
});
