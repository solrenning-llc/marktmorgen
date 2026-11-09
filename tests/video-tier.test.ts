import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tier } from '../lib/plan';
import { PAID_VIDEO_HOURS, paidVideoSeconds, paidVideoWords, TRIAL_VIDEO_SECONDS } from '../lib/video-admission-rules';
import { SETUP_VIDEO_SECONDS, videoLimitFor } from '../lib/plan-standing';
import { VIDEO_HOURS_INCLUDED, videoOwedCents } from '../lib/watch-rules';
import { lessonVideo } from '../lib/learn';
import { HOLD_MIN_SECONDS } from '../lib/watch';
import { set } from './video-admission-redis';
import { players, reset } from './video-admission-stream';
const now = 1_800_000_000;
const paid = {subscriptionActive:true,subscriptionId:'sub_test',trialEnds:0,planEndedAt:''};
const folder = 'a'.repeat(32);
const file = {pathname:'stream/'+folder+'/abcdefghijkl/00000000-0000-4000-8000-000000000001',name:'lesson.mp4',bytes:1000,contentType:'video/mp4',addedAt:new Date(0).toISOString()};
for (const [tier, hours] of Object.entries(PAID_VIDEO_HOURS) as [Tier,number][]) {
  test(tier+' grants playback below its own cap and pauses exactly at it', async()=>{
    const limit=videoLimitFor({...paid,tier},now);
    assert.equal(limit,hours*3600);
    // Rule 23 (9 November 2026): was limit-1 plays. A token is now good only for the time held for it
    // (lib/watch.ts, holdPlayback), never under HOLD_MIN_SECONDS: a minute left plays, less than that pauses.
    set([String(limit-HOLD_MIN_SECONDS)]);reset();
    assert.equal((await lessonVideo(file,limit))?.kind,'stream');assert.equal(players,1);
    set([String(limit-1)]);reset();
    assert.deepEqual(await lessonVideo(file,limit),{kind:'paused'});assert.equal(players,0);
    set([String(limit)]);reset();
    assert.deepEqual(await lessonVideo(file,limit),{kind:'paused'});assert.equal(players,0);
  });
  test(tier+' trial never inherits the paid playback allowance',()=>{
    assert.equal(videoLimitFor({...paid,tier,trialEnds:now+1},now),TRIAL_VIDEO_SECONDS);
    assert.equal(videoLimitFor({...paid,tier,trialEnds:now},now),hours*3600);
  });
}
test('unknown, inherited and omitted tiers get the smallest paid cap',()=>{
  for(const tier of [undefined,'unknown','__proto__','constructor',null])assert.equal(paidVideoSeconds(tier as Tier),4*3600);
});
test('downgrading uses existing watched time and does not mint a replacement allowance',async()=>{
  set(['15000']);reset();
  const limit=videoLimitFor({...paid,tier:'creator'},now);
  assert.deepEqual(await lessonVideo(file,limit),{kind:'paused'});assert.equal(players,0);
});
test('setup and ended stores have a separate fifteen-minute threshold',async()=>{
  assert.equal(SETUP_VIDEO_SECONDS,900);
  for(const subscriptionId of [null,'sub_ended']){
    const limit=videoLimitFor({...paid,subscriptionActive:false,subscriptionId,tier:'scale'},now);
    assert.equal(limit,900);set(['900']);reset();
    assert.deepEqual(await lessonVideo(file,limit),{kind:'paused'});assert.equal(players,0);
  }
});
test('new admission caps do not lower historical billing allowances or invent overage charges',()=>{
  assert.equal(VIDEO_HOURS_INCLUDED,400);
  assert.equal(videoOwedCents(paidVideoSeconds('scale')+3600),0);
  assert.equal(paidVideoWords(),'4 hours on Store, 32 hours on Studio and 64 hours on Scale');
});
