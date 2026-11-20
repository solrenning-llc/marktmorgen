import { statsTrafficCoverage } from "@/lib/range-traffic-coverage";
import { readStats, studioStats } from "@/lib/stats";
import { readNumbers, summaryOf } from "@/lib/stats-report";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";
const good:unknown[]=[...Array.from({length:90},()=>["v",1,"c",0,"r:direct",1]),...Array.from({length:90},()=>1),7,30,90,7,30,90,...Array.from({length:90},()=>[1,null])];
const replace=(index:number,value:unknown)=>good.map((v,i)=>i===index?value:v);
const allKnown={current:true,previous:{d7:true,d30:true,d90:true}};
const currentUnknown={current:false,previous:{d7:false,d30:false,d90:false}};
part("Dashboard pipeline coverage is checked before zero fallbacks");
is("all current and previous replies are confirmed",statsTrafficCoverage(good),allKnown);
for(const index of [0,89,90,179,180,181,182])is("missing current daily or window counter cannot certify a report",statsTrafficCoverage(replace(index,undefined)),currentUnknown);
for(const value of [null,{},["v"],["v",-1],["v",1,"v",2]])is("invalid current daily hash cannot certify a report",statsTrafficCoverage(replace(89,value)).current,false);
for(const value of [null,false,"",NaN,Infinity,-1,0.5])is("invalid current visitor window cannot certify a report",statsTrafficCoverage(replace(180,value)).current,false);
is("seven-day previous estimate is independent",statsTrafficCoverage(replace(183,null)),{current:true,previous:{d7:false,d30:true,d90:true}});
is("thirty-day previous estimate is independent",statsTrafficCoverage(replace(184,undefined)),{current:true,previous:{d7:true,d30:false,d90:true}});
is("ninety-day previous estimate is independent",statsTrafficCoverage(replace(185,{})),{current:true,previous:{d7:true,d30:true,d90:false}});
for(const index of [186,220,275])is("each older daily count is required for the long prior window",statsTrafficCoverage(replace(index,undefined)),{current:true,previous:{d7:true,d30:true,d90:false}});
for(const value of [[],[1],[1,0,0],[1,"oops"],[null,undefined]])is("invalid older hash leaves shorter comparisons available",statsTrafficCoverage(replace(186,value)).previous,{d7:true,d30:true,d90:false});
is("missing all prior replies keeps current only",statsTrafficCoverage(good.slice(0,183)),{current:true,previous:{d7:false,d30:false,d90:false}});
is("partial prior reply list keeps confirmed shorter windows",statsTrafficCoverage(good.slice(0,185)),{current:true,previous:{d7:true,d30:true,d90:false}});
is("truncated current replies stay unavailable",statsTrafficCoverage(good.slice(0,182)),currentUnknown);
is("unexpected extra replies invalidate the layout",statsTrafficCoverage([...good,0]),currentUnknown);
is("sparse replies do not count as confirmed",statsTrafficCoverage(new Array(276)),currentUnknown);
const quiet:unknown[]=[...Array.from({length:90},()=>[]),...Array.from({length:96},()=>0),...Array.from({length:90},()=>[null,null])];
is("confirmed empty days and periods remain available",statsTrafficCoverage(quiet),allKnown);

async function main(){
 const previousFetch=globalThis.fetch;
 const keys=["UPSTASH_REDIS_REST_URL","UPSTASH_REDIS_REST_TOKEN"] as const;
 const saved=keys.map(key=>process.env[key]);
 process.env.UPSTASH_REDIS_REST_URL="https://dashboard-traffic.test";
 process.env.UPSTASH_REDIS_REST_TOKEN="tests-only-not-a-real-token";
 let replies=good;let firstCommands=0;
 globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
  if(String(input)!=="https://dashboard-traffic.test/pipeline")throw new Error("Unexpected test request");
  const commands=JSON.parse(String(init?.body)) as (string|number)[][];
  let values:unknown[];
  if(commands.length===276){firstCommands=commands.length;values=replies;}
  else if(commands.length===1&&commands[0][0]==="HGETALL"&&String(commands[0][1]).endsWith(":life"))values=[["filled","2026-10-15","vgap",0,"u",1]];
  else throw new Error("Unexpected pipeline layout");
  return new Response(JSON.stringify(values.map(result=>({result}))),{status:200});
 }) as typeof fetch;
 try{
  const store={statsId:"dashboard-traffic",currency:"usd",stripeAccountId:null,paypalSeller:null,links:[],attributionDays:30} as unknown as Store;
  const now=Date.UTC(2026,9,15,12);
  const read=()=>readStats(store,now);
  part("Real dashboard reader propagates source availability to API summaries");
  const complete=(await read())!;
  is("reader uses expected 90-day layout",firstCommands,276);
  is("reader keeps confirmed current window totals",[complete.windows.d7.views,complete.windows.d30.views,complete.windows.d90.views],[7,30,90]);
  is("source flags cover confirmed history",complete.previousTrafficAvailable,allKnown.previous);
  const base=studioStats(store,complete,null,"none",[]);
  is("studio preserves source flags",base.previousTrafficAvailable,allKnown.previous);
  replies=replace(183,null);
  const missingShort=(await read())!;
  const studio=studioStats(store,missingShort,null,"none",[]);
  is("missing short history preserves current traffic",studio.totals.d7.visitors,7);
  is("studio does not certify legacy numeric placeholders",studio.previousTrafficAvailable,{d7:false,d30:true,d90:true});
  const summary=summaryOf(studio);
  is("API has unavailable prior visitors, not zero",[summary.days.last_7_days.previous.available,summary.days.last_7_days.previous.visitors],[false,null]);
  is("other confirmed comparison remains available",summary.days.last_30_days.previous.available,true);
  replies=replace(275,null);
  const missingLong=(await read())!;
  is("long history failure leaves shorter histories confirmed",missingLong.previousTrafficAvailable,{d7:true,d30:true,d90:false});
  is("long history failure preserves current long window",missingLong.windows.d90.visitors,90);
  // A short batch is not Redis's answer and rejects the read (#2509); history Redis answers as missing, inside
  // complete envelopes ({"result": null}), keeps the current numbers and withholds every comparison.
  replies=good.slice(0,183);
  let shortRejected=false;try{await read();}catch{shortRejected=true;}
  is("a truncated batch rejects the read, never a snapshot without its history",shortRejected,true);
  replies=[...good.slice(0,183),...good.slice(183).map(()=>null)];
  const noHistory=(await read())!;
  is("all missing history leaves current data available",noHistory.windows.d7.views,7);
  is("all missing history stays unavailable",noHistory.previousTrafficAvailable,{d7:false,d30:false,d90:false});
  replies=replace(0,null);
  is("invalid current source returns no dashboard snapshot",await read(),null);
  is("public summary reader does not publish a partial current snapshot",await readNumbers(store,now),null);
  replies=quiet;
  const empty=(await read())!;
  is("confirmed zero current windows remain zero",[empty.windows.d7.visitors,empty.windows.d90.views],[0,0]);
  is("confirmed zero historical windows stay available",empty.previousTrafficAvailable,allKnown.previous);
  const emptySummary=summaryOf(studioStats(store,empty,null,"none",[]));
  is("API retains real prior zero",[emptySummary.days.last_7_days.previous.available,emptySummary.days.last_7_days.previous.visitors],[true,0]);
  const legacy={...complete,previousTrafficAvailable:undefined};
  is("legacy source without flags keeps its confirmed history",studioStats(store,legacy,null,"none",[]).previousTrafficAvailable,allKnown.previous);
  const missingObject={...complete,previous:undefined} as unknown as typeof complete;
  is("source flags cannot certify a missing previous object",studioStats(store,missingObject,null,"none",[]).previousTrafficAvailable,{d7:false,d30:false,d90:false});
 }finally{
  globalThis.fetch=previousFetch;
  keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
 }
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
