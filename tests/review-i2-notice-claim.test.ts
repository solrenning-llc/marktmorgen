/** Independent review: real notice worker and Redis, synthetic mail/Stripe only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {sendReminders} from '@/lib/billing-reminders';
import {store as redis} from './redis-stub';

const now=1791700000,day=86400;
for(const near of [false,true])for(const reply of [[],[undefined],['unconfirmed'],[0]])test('unconfirmed notice claim: '+(near?'missed':'send')+' / '+String(reply[0])+' / '+reply.length,async()=>{
 process.env.STRIPE_SECRET_KEY='sk_test_notice_review_only';process.env.RESEND_API_KEY='re_test_notice_review_only';
 const oldFetch=globalThis.fetch,oldPipeline=redis.pipeline.bind(redis);
 try{
   redis.clear();let sends=0;
   const at=near?now+12*3600:Math.floor(now/day)*day+30*day+5*3600;
   globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));
    if(url.origin==='https://api.stripe.com'&&url.pathname==='/v1/subscriptions')return Response.json({data:url.searchParams.get('status')==='active'?[{id:'sub_I2ClaimProof0001',status:'active',created:at-400*day,customer:{email:'notice-review@example.test'},items:{data:[{current_period_start:at-365*day,current_period_end:at,price:{lookup_key:'nimbus_labs_creator_year',unit_amount:29000,recurring:{interval:'year'}}}]}}]:[],has_more:false});
    if(url.origin==='https://api.resend.com'&&init?.method==='POST'){sends++;return Response.json({id:'re_I2ClaimProof0001'});}
    throw Error('Unexpected synthetic notice operation');
   };
   redis.pipeline=async(commands)=>{
    if(commands.length===1&&commands[0][0]==='SET'&&String(commands[0][1]).startsWith('nl:remind:renewal:'))return reply;
    return oldPipeline(commands);
   };
   const counts=await sendReminders(now);
   console.log(JSON.stringify({near,reply,sends,counts}));
   assert.equal(sends,0,'an absent/invalid Redis acknowledgement is not an admission');
   assert.equal(counts.missed,0,'unknown state is not proof that a notice was missed');
   assert.equal(counts.failed,1,'the unconfirmed claim must remain visible');
 }finally{globalThis.fetch=oldFetch;redis.pipeline=oldPipeline;}
});
