import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { promotionMedium } from '@/lib/promotion-plan';
import { PromotionPlanner } from '@/components/promotion-planner';
import type { StatsData } from '@/lib/stats';

function markup(channel:string){
 const row={views:20,cents:100,sales:1,checkouts:1};
 const data={sales:'ok',partial:false,currency:'usd',days:[{date:'2026-10-17'}],products:[{id:'a',title:'Guide',d7:row,d30:row,d90:row}],channels:{d7:[{source:channel,visits:20,cents:100,sales:1,checkouts:1,free:0}],d30:[],d90:[]}} as unknown as StatsData;
 return renderToStaticMarkup(createElement(PromotionPlanner,{data,range:'d7',products:[{id:'a',title:'Guide',url:'https://shop.example/p/guide'}],campaignResults:false}));
}
test('email and newsletter channels start with email attribution',()=>{
 assert.equal(promotionMedium('email'),'email');assert.equal(promotionMedium('newsletter'),'email');
});
test('social channels retain organic post as the starting choice',()=>{
 for(const channel of ['instagram','x','youtube','linkedin'])assert.equal(promotionMedium(channel),'post');
});
test('an explicit creator choice is preserved when the channel changes',()=>{
 assert.equal(promotionMedium('email','paid'),'paid');
 assert.equal(promotionMedium('newsletter','post'),'post');
 assert.equal(promotionMedium('x','email'),'email');
});
test('suggested email and newsletter channels produce correctly tagged initial links',()=>{
 for(const channel of ['email','newsletter']){
  const html=markup(channel);assert.ok(html.includes('utm_source='+channel));assert.ok(html.includes('utm_medium=email'));
 }
});
test('a suggested social channel keeps the existing post attribution',()=>{
 const html=markup('x');assert.ok(html.includes('utm_source=x'));assert.ok(html.includes('utm_medium=post'));
});
