/** A local cloud HTTP server supplies the synthetic ICS; no external network or account. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { calendarBusy, calendarKeys, removeFeed } from "@/lib/calendar-sync";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
const statsId = "calendar-late-refresh";
const store = { statsId, handle:"late-calendar", callsId:null, catalog:{items:[]} } as unknown as Store;
const feed = {id:"aaaaaaaaaaaaaaaa",url:"https://calendar.example.com/private.ics",addedAt:"2026-11-20T00:00:00.000Z"};
const config = {handle:store.handle,callsId:null,feeds:[feed],token:null,tokenAt:""};
const cfgKey = `nl:cal:cfg:${statsId}`;
const keys = ["busy","good","err"].map(k=>`nl:cal:${k}:${feed.id}`);
const now = Date.UTC(2026,10,20,12);
const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//synthetic//EN\r\nBEGIN:VEVENT\r\nUID:private\r\nDTSTART:20261120T120100Z\r\nDTEND:20261120T120200Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
class LocalAgent extends https.Agent {
 constructor(private port:number){super({keepAlive:false});}
 createConnection():net.Socket{return net.connect(this.port,"127.0.0.1");}
}
for(const outcome of ["success","failure"] as const)for(const action of ["unchanged","remove","erased"] as const){
 test(`store calendar late ${outcome}: ${action}`,async()=>{
  redis.clear();await redis.pipeline([["SET",cfgKey,JSON.stringify(config)]]);
  const server=http.createServer((_q,r)=>{r.writeHead(outcome==="success"?200:500,{"content-type":"text/calendar"});r.end(ics);});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const agent=new LocalAgent((server.address() as net.AddressInfo).port);
  let reached=0;
  try{
   const result=await calendarBusy(store,now,{agent,resolve:async()=>{
    reached++;
    if(action==="remove")await removeFeed(store,feed.id);
    if(action==="erased")await redis.pipeline([["DEL",cfgKey,...calendarKeys(config)]]);
    return [{address:"93.184.216.34",family:4}];
   }});
   assert.equal(reached,1,"the race really occurs inside the admitted feed read");
   const kept=await redis.pipeline(keys.map(k=>["GET",k]));
   if(action==="unchanged"){
    assert.equal(result.failing,outcome==="success"?0:1);
    assert.equal(typeof kept[0],"string");
    if(outcome==="success")assert.deepEqual(result.busy,[{start:now+60_000,end:now+120_000}]);
   }else{
    assert.deepEqual(kept,[null,null,null],"forgotten private calendar readings stay absent");
    assert.equal(result.failing,1,"a config changed during the read cannot authorize an available time");
    assert.equal(result.busy.some(b=>b.start===now+60_000&&b.end===now+120_000),false,"no late private intervals are answered");
    assert.ok(result.busy.length>0,"unknown stays blocked, never free");
   }
  }finally{agent.destroy();await new Promise<void>(r=>server.close(()=>r()));}
 });
}

for (const reply of [[], [null], ["1"], [1, 0], Array(1)]) {
 test(`unknown store calendar commit ${JSON.stringify(reply)} stays blocked`,async()=>{
  redis.clear();await redis.pipeline([["SET",cfgKey,JSON.stringify(config)]]);
  const server=http.createServer((_q,r)=>{r.writeHead(200,{"content-type":"text/calendar"});r.end(ics);});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const agent=new LocalAgent((server.address() as net.AddressInfo).port);
  const run=redis.pipeline.bind(redis);let commits=0;
  redis.pipeline=(async commands=>{
   if(commands[0]?.[0]==="EVAL"&&String(commands[0][1]).includes("calendar-readings-current:v1")){commits++;return reply;}
   return run(commands);
  }) as typeof redis.pipeline;
  try{
   const result=await calendarBusy(store,now,{agent,resolve:async()=>[{address:"93.184.216.34",family:4}]});
   assert.equal(commits,1,"no error-write retry after an uncertain commit");
   assert.equal(result.failing,1);assert.ok(result.busy.length>0);
   assert.equal(result.busy.some(b=>b.start===now+60_000&&b.end===now+120_000),false);
   assert.deepEqual(await run(keys.map(k=>["GET",k])),[null,null,null]);
  }finally{redis.pipeline=run;agent.destroy();await new Promise<void>(r=>server.close(()=>r()));}
 });
}

for(const mode of ["mixed","remove","lost","cached"] as const){
 test(`one batch preserves every feed and its own marks: ${mode}`,async()=>{
  redis.clear();
  const feeds=["a","b","c"].map(c=>({id:c.repeat(16),url:`https://calendar.example.com/${c}.ics`,addedAt:feed.addedAt}));
  await redis.pipeline([["SET",cfgKey,JSON.stringify({...config,feeds})]]);
  const cached=JSON.stringify({at:now,busy:[[now+60_000,now+120_000]],events:1,unsupported:0,truncated:false});
  if(mode==="cached")await redis.pipeline([["SET",`nl:cal:busy:${feeds[0].id}`,cached]]);
  const server=http.createServer((q,r)=>{r.writeHead(q.url==="/b.ics"&&mode==="mixed"?500:200,{"content-type":"text/calendar"});r.end(ics);});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const agent=new LocalAgent((server.address() as net.AddressInfo).port);
  const run=redis.pipeline.bind(redis);const sent:(string|number)[][]=[];
  redis.pipeline=async c=>{sent.push(...c);return run(c);};let resolves=0;
  try{
   const result=await calendarBusy(store,now,{agent,resolve:async()=>{
    resolves++;
    if(resolves===3&&mode==="remove")await removeFeed(store,feeds[0].id);
    if(resolves===3&&mode==="lost")await run([["SET",`nl:cal:lock:${feeds[0].id}`,"another-reader","EX",20]]);
    return [{address:"93.184.216.34",family:4}];
   }});
   assert.equal(resolves,mode==="cached"?2:3);
   assert.equal(sent.filter(c=>c[0]==="EVAL"&&String(c[1]).includes("calendar-readings-current:v1")).length,1);
   assert.equal(sent.filter(c=>c[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:release:v1\n")).length,0,"releases are inside the same batch");
   const locks=await run(feeds.map(f=>["GET",`nl:cal:lock:${f.id}`]));
   assert.deepEqual(locks,mode==="lost"?["another-reader",null,null]:[null,null,null]);
   if(mode==="remove"){
    for(const f of feeds)assert.deepEqual(await run(["busy","good","err"].map(k=>["GET",`nl:cal:${k}:${f.id}`])),[null,null,null]);
   }else if(mode==="lost"){
    assert.deepEqual(await run(["busy","good","err"].map(k=>["GET",`nl:cal:${k}:${feeds[0].id}`])),[null,null,null]);
   }else{
    assert.equal(result.failing,mode==="mixed"?1:0);
    assert.equal(typeof (await run([["GET",`nl:cal:good:${feeds[2].id}`]]))[0],"string");
    if(mode==="mixed")assert.equal(typeof (await run([["GET",`nl:cal:err:${feeds[1].id}`]]))[0],"string");
    if(mode==="cached")assert.equal((await run([["GET",`nl:cal:busy:${feeds[0].id}`]]))[0],cached);
   }
   if(mode==="lost"||mode==="remove")assert.equal(result.busy.some(b=>b.start===now+60_000&&b.end===now+120_000),false);
  }finally{redis.pipeline=run;agent.destroy();await new Promise<void>(r=>server.close(()=>r()));}
 });
}
