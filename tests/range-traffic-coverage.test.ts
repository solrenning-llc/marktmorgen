import { rangeTrafficCoverage } from "@/lib/range-traffic-coverage";
import { readRange } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";
const good:unknown[]=[["v","2","c","1","r:newsletter","2","pv:guide","2"],["v",3,"c",1],1,"2",3,1,[null,null],["1",1]];
const replace=(index:number,value:unknown)=>good.map((v,i)=>i===index?value:v);
part("Confirmed counters and exact command shapes");
is("valid mixed numeric Redis replies cover both periods",rangeTrafficCoverage(good,2,true),{current:true,previous:true});
is("quiet days and absent HMGET fields are confirmed zeros",rangeTrafficCoverage([[],[],0,"0",0,0,[null,null],[null,"0"]],2,true),{current:true,previous:true});
is("no requested previous range needs no previous replies",rangeTrafficCoverage(good.slice(0,5),2,false),{current:true,previous:false});
is("missing previous replies preserve current coverage",rangeTrafficCoverage(good.slice(0,5),2,true),{current:true,previous:false});
for(const days of [0,-1,401,1.5,NaN])is("invalid day count cannot certify a reading",rangeTrafficCoverage(good,days,true).current,false);
for(const value of [null,undefined,{},[],true,"", " ","oops",-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1])is("invalid daily visitor counter stays unavailable",rangeTrafficCoverage(replace(2,value),2,true).current,false);
for(const value of [null,undefined,{},["v"],["v",null],["v",false],["v","oops"],["v",-1],["v",1.5],["v",1,"v",2],["",1],[7,1]])is("malformed daily hash cannot certify traffic",rangeTrafficCoverage(replace(0,value),2,true).current,false);
is("missing consolidated visitor count blocks the current report",rangeTrafficCoverage(replace(4,undefined),2,true).current,false);
is("short current response stays unavailable",rangeTrafficCoverage(good.slice(0,4),2,true).current,false);
is("unexpected extra replies cannot certify a layout",rangeTrafficCoverage([...good,0],2,true).current,false);
for(const value of [undefined,null,[],[null],[null,null,0],[null,undefined],[true,0],["oops",0],[-1,0]]){
 const result=rangeTrafficCoverage(replace(6,value),2,true);
 is("invalid previous daily counters keep current and withhold prior",result,{current:true,previous:false});
}
is("missing prior visitor estimate withholds previous",rangeTrafficCoverage(replace(5,undefined),2,true),{current:true,previous:false});
is("sparse current command slot is not skipped",rangeTrafficCoverage(new Array(8),2,true).current,false);

async function main(){
 const previousFetch=globalThis.fetch;
 const envKeys=["UPSTASH_REDIS_REST_URL","UPSTASH_REDIS_REST_TOKEN"] as const;
 const saved=envKeys.map(key=>process.env[key]);
 process.env.UPSTASH_REDIS_REST_URL="https://range-traffic.test";
 process.env.UPSTASH_REDIS_REST_TOKEN="tests-only-not-a-real-token";
 let replies:unknown[]=good;let networkFailure=false;let commandCount=0;
 globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
  if(String(input)!=="https://range-traffic.test/pipeline")throw new Error("Unexpected test request");
  if(networkFailure)throw new Error("Simulated Redis outage");
  commandCount=(JSON.parse(String(init?.body)) as unknown[]).length;
  return new Response(JSON.stringify(replies.map(result=>({result}))),{status:200});
 }) as typeof fetch;
 try{
  const store={statsId:"range-traffic-test",currency:"usd",stripeAccountId:null,paypalSeller:null} as Store;
  const now=Date.UTC(2026,9,15,12);
  const read=()=>readRange(store,"2026-10-13","2026-10-14",now);
  part("Real range reader preserves confirmed current traffic only");
  const complete=(await read())!;
  is("reader requests the expected command layout",commandCount,8);
  is("valid current values survive",[complete.totals.visitors,complete.totals.views,complete.totals.checkouts],[3,5,2]);
  is("valid prior traffic survives",[complete.before?.visitors,complete.before?.views,complete.before?.checkouts],[1,1,1]);
  is("channels retain confirmed visits",complete.channels.map(row=>[row.source,row.visits]),[["newsletter",2]]);
  // A source Redis answers as missing, inside a complete envelope ({"result": null}), keeps the coverage rules; an
  // envelope with no result at all ({}) or a short batch is not Redis's answer and rejects the read (#2509).
  replies=replace(0,null);
  is("missing current hash returns no report instead of partial totals",await read(),null);
  replies=replace(2,null);
  is("missing current visitors returns no report instead of zero",await read(),null);
  replies=replace(4,"not-a-count");
  is("invalid consolidated visitors returns no report",await read(),null);
  replies=replace(6,null);
  const priorMissing=(await read())!;
  is("prior failure keeps current report",priorMissing.totals.views,5);
  is("prior failure does not publish provisional zeros",priorMissing.before,null);
  const rejects=async()=>{try{await read();return false;}catch{return true;}};
  replies=good.slice(0,5);
  is("a truncated batch is not Redis's answer: the read rejects, never a report without its prior days",await rejects(),true);
  replies=replace(0,undefined);
  is("an envelope with no result is not Redis's answer: the read rejects",await rejects(),true);
  replies=[[],[],0,0,0,0,[null,null],[null,null]];
  const quiet=(await read())!;
  is("confirmed empty current traffic remains zero",[quiet.totals.visitors,quiet.totals.views,quiet.totals.checkouts],[0,0,0]);
  is("confirmed empty prior traffic remains zero",[quiet.before?.visitors,quiet.before?.views,quiet.before?.checkouts],[0,0,0]);
  replies=[[],0,0];
  const earliest=new Date(now-399*86400000).toISOString().slice(0,10);
  const boundary=(await readRange(store,earliest,earliest,now))!;
  is("oldest retained day needs no previous commands",commandCount,3);
  is("retention boundary keeps confirmed current zero",boundary.totals.visitors,0);
  is("retention boundary does not invent prior history",boundary.before,null);
  networkFailure=true;let rejected=false;try{await read();}catch{rejected=true;}
  is("transport failure still reaches the route error path",rejected,true);
 }finally{
  globalThis.fetch=previousFetch;
  envKeys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
 }
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
