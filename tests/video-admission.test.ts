import test from 'node:test';
import assert from 'node:assert/strict';
import {watchedForAdmission} from '../lib/watch';
import {lessonVideo} from '../lib/learn';
import {set,commands} from './video-admission-redis';
import {players,reset} from './video-admission-stream';
const folder='a'.repeat(32),month='2026-10';
const file={pathname:'stream/'+folder+'/abcdefghijkl/00000000-0000-4000-8000-000000000001',name:'lesson.mp4',bytes:1000,contentType:'video/mp4',addedAt:new Date(0).toISOString()};
test('acknowledged unused month is distinct from a failed lookup',async()=>{set([null]);assert.equal(await watchedForAdmission(folder,month),0);set([]);assert.equal(await watchedForAdmission(folder,month),null);set([undefined]);assert.equal(await watchedForAdmission(folder,month),null);set([0,1]);assert.equal(await watchedForAdmission(folder,month),null);});
test('only finite safe integer seconds are admitted',async()=>{for(const raw of [0,1,500,'0','1','500']){set([raw]);assert.equal(await watchedForAdmission(folder,month),Number(raw));}for(const raw of ['', ' 0','01','1e2','-1',-1,1.5,NaN,Infinity,{},false,Number.MAX_SAFE_INTEGER+1]){set([raw]);assert.equal(await watchedForAdmission(folder,month),null);}});
test('invalid folder and month never read another counter',async()=>{set(['0']);assert.equal(await watchedForAdmission('invalid',month),null);assert.equal(await watchedForAdmission(folder,'2026-13'),null);assert.equal(commands.length,0);});
test('unconfigured or unavailable Redis never grants zero seconds',async()=>{set([null],{configured:false});assert.equal(await watchedForAdmission(folder,month),null);set([null],{fail:true});assert.equal(await watchedForAdmission(folder,month),null);});
test('lookup uses exactly the store and requested month',async()=>{set(['21']);assert.equal(await watchedForAdmission(folder,month),21);assert.deepEqual(commands,[[['GET','nl:watch:sec:'+folder+':'+month]]]);});
test('actual limited playback issues no player on lookup error',async()=>{set([null],{fail:true});reset();assert.equal(await lessonVideo(file,100),null);assert.equal(players,0);});
test('corrupt or ambiguous counter cannot mint a player token',async()=>{for(const value of [['bad'],[],[undefined],[true]]){set(value);reset();assert.equal(await lessonVideo(file,100),null);assert.equal(players,0);}});
test('zero and exhausted allowances pause before player issuance',async()=>{for(const [used,limit] of [[0,0],[100,100],[101,100]]){set([String(used)]);reset();assert.deepEqual(await lessonVideo(file,limit),{kind:'paused'});assert.equal(players,0);}});
test('invalid finite allowance cannot bypass admission',async()=>{for(const limit of [NaN,Infinity,-1,0.5]){set(['0']);reset();assert.equal(await lessonVideo(file,limit),null);assert.equal(players,0);}});
// Rule 23 (9 November 2026): was 99 of 100 seconds plays. A token is good only for the time held for it (lib/watch.ts,
// holdPlayback), at least HOLD_MIN_SECONDS: a minute left plays, a second left pauses.
test('confirmed balance below allowance preserves playback',async()=>{set(['40']);reset();assert.equal((await lessonVideo(file,100))?.kind,'stream');assert.equal(players,1);set(['99']);reset();assert.deepEqual(await lessonVideo(file,100),{kind:'paused'});assert.equal(players,0);});

test('null or omitted stream allowance cannot mint a player token',async()=>{for(const limit of [null,undefined]){set(['0']);reset();assert.equal(await lessonVideo(file,limit),null);assert.equal(players,0);assert.equal(commands.length,0);}});

test('marked funded lesson media cannot issue a player without actual financial approval',async()=>{
 const store={statsId:folder,tier:'creator',cycle:'month',subscriptionId:'sub_VideoCohort001',subscriptionActive:true,trialEnds:0,planEndedAt:'',period:{start:Math.floor(Date.UTC(2026,9,1)/1000),end:Math.floor(Date.UTC(2026,10,1)/1000),renews:true,funded:true}} as import('../lib/store').Store;
 set(['0']);reset();
 assert.equal(await lessonVideo(file,100,month,store),null);
 assert.equal(players,0);
 assert.equal(commands.length,0);
});
