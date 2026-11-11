import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromotionPlanner } from '@/components/promotion-planner';
import { promotionChoices } from '@/lib/promotion-plan';
import type { StatsData } from '@/lib/stats';

const products=[{id:'a',title:'Guide',url:'https://shop.example/p/a'}];
const figures={views:120,cents:0,sales:0,checkouts:0};
const channel=(source:string,visits:number,cents=0)=>({source,visits,cents,sales:0,checkouts:0,free:0});
function data(channels= [channel('x',120),channel('instagram',10)]): StatsData {
 return {sales:'ok',partial:false,currency:'usd',days:[{date:'2026-10-16'}],
  products:[{id:'a',title:'Guide',d7:figures,d30:figures,d90:figures}],
  channels:{d7:channels,d30:[],d90:[]}} as unknown as StatsData;
}

test('before the first sale, the strongest measured traffic replaces the arbitrary default',()=>{
 const plan=promotionChoices(data(),'d7',products);
 assert.equal(plan.channel,'x');assert.equal(plan.channelBasis,'visits');assert.equal(plan.channelEvidence?.visits,120);
});
test('complete positive revenue retains priority over traffic',()=>{
 const plan=promotionChoices(data([channel('x',120),channel('email',10,100)]),'d7',products);
 assert.equal(plan.channel,'email');assert.equal(plan.channelBasis,'sales');
});
test('partial paid records cannot become sales evidence',()=>{
 const plan=promotionChoices({...data([channel('x',120),channel('email',10,100)]),partial:true},'d7',products);
 assert.equal(plan.channel,'x');assert.equal(plan.channelBasis,'visits');
});
test('unknown sources and zero activity do not manufacture a recommendation',()=>{
 const plan=promotionChoices(data([channel('direct',999),channel('x',0)]),'d7',products);
 assert.equal(plan.channel,'instagram');assert.equal(plan.channelBasis,'default');assert.equal(plan.channelEvidence,null);
});
test('the selected period controls traffic evidence',()=>{
 const value=data();value.channels.d30=[channel('email',200)];
 assert.equal(promotionChoices(value,'d30',products).channel,'email');
});
test('the interface labels traffic evidence without claiming revenue evidence',()=>{
 const markup=renderToStaticMarkup(createElement(PromotionPlanner,{data:data(),range:'d7',products,campaignResults:false}));
 assert.ok(markup.includes('based on store-wide visits'));
 assert.equal(markup.includes('based on store-wide gross revenue'),false);
 assert.ok(markup.includes('does not prove this product sold through that channel'));
});
