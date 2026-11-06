import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {pathWeeklySummary} from '../../lib/path-weekly-summary';
import {PathWeeklySummary} from '../../components/path-weekly-summary';
let checks=0;
const equal=(actual:unknown,expected:unknown)=>{checks++;assert.deepEqual(actual,expected);};
// Explicit, finite synthetic exercise: no I/O, mutation or service calls.
const fixtures=[
 ['UTC','2026-11-02T00:00:00Z','2026-11-02','2026-11-08'],
 ['America/New_York','2026-11-02T04:59:59Z','2026-10-26','2026-11-01'],
 ['Pacific/Kiritimati','2026-11-01T10:00:00Z','2026-11-02','2026-11-08'],
 ['Pacific/Pago_Pago','2026-11-02T10:59:59Z','2026-10-26','2026-11-01'],
 ['Asia/Kathmandu','2026-11-01T18:15:00Z','2026-11-02','2026-11-08'],
 ['UTC','2027-01-01T12:00:00Z','2026-12-28','2027-01-03'],
];
for(const [timeZone,now,monday,sunday] of fixtures){
 const checkins=Object.freeze([monday]);
 const result=pathWeeklySummary(Object.freeze({timeZone,checkins}),Date.parse(now));
 equal(result.state,'available');
 if(result.state!=='available')throw Error('unavailable valid week');
 equal([result.monday,result.sunday,result.days],[monday,sunday,[monday]]);
 equal(checkins,[monday]);
}
const valid=['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08'];
const all=pathWeeklySummary({timeZone:'UTC',checkins:Object.freeze([...valid].reverse())},Date.parse('2026-11-08T23:59:59Z'));
equal(all.state==='available'?all.days:null,valid);
const html=renderToStaticMarkup(createElement(PathWeeklySummary,{summary:all,streak:null}));
equal(Buffer.byteLength(html)<4096,true);
equal((html.match(/<li>/g)||[]).length,7);
equal(/Current streak:|<button|<form|<script/.test(html),false);
const malformed:unknown[]=[null,{},'2026-11-02',[null],[1],['__proto__'],['2026-02-29'],['2026-11-09'],new Array(1),Array(61).fill('2026-11-02')];
for(const checkins of malformed)equal(pathWeeklySummary({timeZone:'UTC',checkins:checkins as string[]},Date.parse('2026-11-08T12:00:00Z')).state,'unavailable');
for(const now of [NaN,Infinity,-Infinity,8.64e15,-8.64e15])equal(pathWeeklySummary({timeZone:'UTC',checkins:[]},now).state,'unavailable');
const sixty=Object.freeze(Array(60).fill('2026-11-02'));
const capped=pathWeeklySummary({timeZone:'UTC',checkins:sixty},Date.parse('2026-11-08T12:00:00Z'));
equal(capped.state==='available'?capped.days:null,['2026-11-02']);
console.log(`${checks} independent checks, all passing; no network/service calls.`);
