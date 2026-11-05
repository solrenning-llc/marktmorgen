import {bookedCalendarFeed, calendarAttemptsKey} from '@/lib/calendar-sync';
import {store as redis} from './redis-stub';
import {done,is} from './check';
async function main(){
 const now=Date.UTC(2031,2,10,9,30), day=new Date(now).toISOString().slice(0,10);
 const ref='calendar-control@example.com';
 for(const [label,attempts,own,copy,wantMade] of [
  ['absent counters',null,null,false,1],
  ['confirmed zero','0','0',false,1],
  ['exhausted attempts','999','0',false,0],
  ['malformed attempts','abc','0',false,0],
  ['malformed own count','0','',false,0],
  ['stale copy and unknown attempts','abc','0',true,0],
  ['stale copy and unknown own count','0','1.5',true,0],
  ['oversized count','9999999999999999','0',true,0],
 ] as const){
  redis.clear();
  const owner={statsId:'jroom'+label.length,handle:'jroom'};
  redis.run(['SET','nl:store:handle:jroom',ref]);
  if(attempts!==null)redis.run(['SET',calendarAttemptsKey(owner.statsId,day),attempts]);
  if(own!==null)redis.run(['SET',`nl:cal:builds:${owner.statsId}:${day}`,own]);
  if(copy)redis.run(['SET',`nl:cal:out:${owner.statsId}`,JSON.stringify({at:now-86400000,ics:'ORIGINAL',ref,sid:owner.statsId})]);
  let made=0;
  const answer=await bookedCalendarFeed(owner,async()=>{made++;return{ics:'BEGIN:VCALENDAR\r\nEND:VCALENDAR',listId:null,named:[]};},now);
  is(label,[made,copy?answer:null], [wantMade,copy?{state:'copy',ics:'ORIGINAL'}:null]);
 }
 done();
}
void main();
