import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeQuestions, HOME_QUESTIONS, LEAVING_ANSWER, LEAVING_QUESTION, STAN_QUESTION, stanComparison } from '../lib/home-faq';
import { HELP_SECTIONS } from '../lib/help-content';
import { PLANS_ON_SALE } from '../lib/opening';
import { PUBLISHED_PLAN_PRICES, TRIAL_DAYS } from '../lib/plan';

/*
 * The home page's questions (VS1, owner 31/10/2026): six, in the owner's
 * order, each answer one or two short sentences, every figure read from the
 * code, and nothing they used to say lost from the site.
 */
test("home asks six short questions in the owner's order",()=>{
 assert.deepEqual(HOME_QUESTIONS.map(item=>item.q),["How long does it take to open a store?","How much does it cost?","Where does the money from my sales go?","Can I move from Stan, Kajabi or another platform?","Can I cancel anytime?","Can I start selling today?"]);
 for(const item of HOME_QUESTIONS){
  const sentences=item.a.split(/(?<=[.?!])\s+/).filter(Boolean);
  assert.ok(sentences.length>=1&&sentences.length<=2,item.q+": "+sentences.length+" sentences");
  assert.ok(item.a.length<=170,item.q+": "+item.a.length+" characters");
  assert.doesNotMatch(item.a,/0% of|Stan has|creator also handles|guarantee/);
  assert.ok(item.links?.length,item.q+" links to the rest");
 }
 const all=HOME_QUESTIONS.map(item=>item.q).join(" ");
 assert.doesNotMatch(all,/Who is behind this|What does Stan have/);
});
test("home answers match the code",()=>{
 const cost=HOME_QUESTIONS[1].a;
 for(const tier of ["creator","pro","scale"] as const){
  assert.ok(cost.includes("$"+PUBLISHED_PLAN_PRICES[tier].month/100),tier);
  assert.equal(PUBLISHED_PLAN_PRICES[tier].year,PUBLISHED_PLAN_PRICES[tier].month*10,"the ten-payment year is true for "+tier);
 }
 assert.match(cost,/Stripe's processing fee is separate/);
 assert.equal(/not on sale yet/.test(cost),!PLANS_ON_SALE);
 const today=HOME_QUESTIONS[5].a;
 assert.equal(today.startsWith("Yes."),PLANS_ON_SALE);
 assert.equal(today.includes("not on sale yet")&&today.includes("no card"),!PLANS_ON_SALE);
 if(PLANS_ON_SALE)assert.ok(today.includes(TRIAL_DAYS+"-day"));
 assert.ok(HOME_QUESTIONS[4].links?.some(link=>link.href==="/terms#closing")&&HOME_QUESTIONS[4].links?.some(link=>link.href==="/refunds"));
 assert.ok(HOME_QUESTIONS[3].links?.some(link=>link.href==="/platform/switching-to-marktmorgen"));
 assert.match(HOME_QUESTIONS[3].a,/contacts who agreed/);assert.match(HOME_QUESTIONS[3].a,/yourself/);
 assert.match(HOME_QUESTIONS[0].a,/no set time/);
 assert.match(HOME_QUESTIONS[4].a,/not charged again/);assert.match(HOME_QUESTIONS[4].a,/unless a refund applies/);
 assert.match(HOME_QUESTIONS[2].a,/own Stripe account/);assert.match(HOME_QUESTIONS[2].a,/payout schedule/);
});
test("what left the home page still lives in the help center",()=>{
 const items=HELP_SECTIONS.flatMap(section=>section.items);
 assert.deepEqual(items.find(item=>item.q===LEAVING_QUESTION)?.a,[LEAVING_ANSWER]);
 assert.deepEqual(items.find(item=>item.q===STAN_QUESTION)?.a,[stanComparison(false)]);
 assert.match(LEAVING_ANSWER,/download as files at any time/);assert.match(LEAVING_ANSWER,/notice in writing/);
});

import { decisionQuestions } from "@/lib/home-faq";
import { PRICING_QUESTIONS } from "@/lib/pricing-page-data";
import { PLAN_TITLES,publishedPriceWords } from "@/lib/plan";
test("the six decision questions keep their full answers on pricing",()=>{
 // VS1 (31/10/2026): the home page now has its own six short answers; these stay whole on /pricing.
 const items=decisionQuestions();assert.equal(items.length,6);assert.equal(homeQuestions().length,6);
 for(const item of items){assert.deepEqual(PRICING_QUESTIONS.find(q=>q.q===item.q),item);assert.ok(item.links?.length);}
 const cost=items[0].a;for(const tier of ["creator","pro","scale"] as const){assert.ok(cost.includes(PLAN_TITLES[tier]));for(const cycle of ["month","year"] as const)assert.ok(cost.includes(publishedPriceWords(tier,cycle)));}
 assert.match(cost,/not open yet/);
});
test("FAQ does not invent a migration, support SLA or setup-time promise",()=>{
 const items=decisionQuestions();
 assert.match(items[1].a,/renew|cancel/);assert.ok(items[1].links?.some(l=>l.href==="/terms#closing"));
 assert.ok(items[2].links?.some(l=>l.href==="/platform/switching-to-marktmorgen"));assert.match(items[2].a,/do not automatically move/);assert.match(items[2].a,/consenting contacts/);
 assert.ok(items[3].links?.some(l=>l.href==="/developers"));assert.match(items[3].a,/no native Marktmorgen app/);assert.match(items[3].a,/every plan/);
 assert.match(items[4].a,/support@marktmorgen.com/);assert.match(items[4].a,/do not publish a guaranteed response time/);
 assert.match(items[5].a,/no measured setup-time promise/);assert.ok(items[5].links?.some(l=>l.href==="/demo"));
});
