import test from 'node:test';
import assert from 'node:assert/strict';
import { ENDING_KEY, GIVE_UP_DAYS, finishPlanRefunds } from '@/lib/plan-refund-flow';
import { redisPipeline } from '@/lib/redis';
import { store as redis } from './redis-stub';
import { DAY, NOW, paidShop, world } from './plan-refund-stripe-world';

process.env.STRIPE_SECRET_KEY = 'sk_test_a_stand_in_key_for_tests_only';
process.env.RESEND_API_KEY = 're_a_stand_in_key_for_tests_only';
for (const variant of ['stops control','renews control','unknown status','missing stop flag','string stop flag','string cancel_at'] as const) {
  test(`damaged-note letter: ${variant}`, async () => {
    redis.clear(); world.calls=[]; world.emails=[];
    const shop=await paidShop();
    const store=await shop.store();
    const sub=world.subs.get(shop.subId)!;
    if(variant==='stops control')sub.cancel_at_period_end=true;
    if(variant==='unknown status')sub.status='unrecognized_provider_status';
    if(variant==='missing stop flag')delete sub.cancel_at_period_end;
    if(variant==='string stop flag')sub.cancel_at_period_end='true';
    if(variant==='string cancel_at')sub.cancel_at='2000000000';
    await redisPipeline([['HSET',ENDING_KEY,store.sid,JSON.stringify({s:shop.subId,at:NOW-(GIVE_UP_DAYS+1)*DAY,m:0,p:[null]})]]);
    await finishPlanRefunds(Date.now()+10_000,NOW);
    assert.equal(world.calls.some(x=>!x.startsWith('GET ')),false,'no mutation at Stripe');
    assert.equal(world.emails.length,1,'one letter actually reached the synthetic sender');
    const text=world.emails[0].text;
    if(variant==='stops control')assert.match(text,/set to stop at the end/);
    else if(variant==='renews control')assert.match(text,/renews as usual/);
    else {
      assert.match(text,/We could not read your plan just now/,'unknown provider evidence must select the uncertainty sentence');
      assert.doesNotMatch(text,/renews as usual|nothing more will be charged/);
    }
  });
}
