import test from 'node:test';
import assert from 'node:assert/strict';
import {videoUsageNotice} from '../lib/video-usage-notice';
const sample = {seconds:14400,limit:14400,standing:'paid' as const,studioUrl:'https://example.test/studio',supportEmail:'support@example.test'};
test('an exhausted paid store is told its real threshold and is not described as unpaid',()=>{
 const notice=videoUsageNotice(sample);
 assert.equal(notice.subject,'Your lesson videos are paused');
 assert.match(notice.text,/your paid plan is 4 hours/);
 assert.match(notice.text,/New stream playback is paused/);
 assert.doesNotMatch(notice.text,/store has no paid plan|as much as they like|Nobody has been cut off|400 hours/);
});
test('trial and setup notices use their actual smaller allowances',()=>{
 const trial=videoUsageNotice({...sample,seconds:3600,limit:3600,standing:'trial'});
 const setup=videoUsageNotice({...sample,seconds:900,limit:900,standing:'none'});
 assert.match(trial.text,/your free trial is 1 hour/);
 assert.match(setup.text,/without an active paid plan is 15 minutes/);
});
test('past the old 400 hours the notice names no charge and promises no playback',()=>{
 const notice=videoUsageNotice({...sample,seconds:401*3600});
 assert.equal(notice.subject,'Your lesson videos are paused');
 assert.doesNotMatch(notice.text,/historical invoice terms|\$0\.03|charge|invoice/i);
 assert.match(notice.text,/Existing player links may remain valid/);
});
test('a non-exhausted reading is not announced as a pause',()=>{
 const notice=videoUsageNotice({...sample,seconds:14399});
 assert.equal(notice.subject,'Your monthly lesson video usage');
 assert.doesNotMatch(notice.text,/New stream playback is paused/);
});
