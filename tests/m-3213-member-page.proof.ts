/** Independent, synthetic causal probe. Real readers, queue, studio and POST.
 * Only the member-list HSCAN/HLEN reply is replaced. No provider work runs.
 */
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {AppRouterContext} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {NextRequest} from "next/server";
import {POST} from "@/app/api/store/community/route";
import StudioCommunityPage from "@/app/studio/community/page";
import {freshConfig, memberPage, mailableMembers, saveConfig, readPost, type Post} from "@/lib/community";
import {announcementReach, queueAnnouncement} from "@/lib/community-mail";
import {communityNotices} from "@/components/community-parts";
import {UnknownReplyError} from "@/lib/redis-reply";
import {SESSION_COOKIE, openSession} from "@/lib/auth";
import {claimHandle, ensureStatsId, setCommunity, setSubscription, setMailSettings, storeForEmail} from "@/lib/store";
import {store as redis} from "./redis-stub";
import {cookieValues} from "./meeting-withdrawal-page-world";
import {afterTasks} from "./next-server-after-world";
import {is, part, done} from "./check";

type Command=(string|number)[];
const original=redis.pipeline.bind(redis);
let fault:((cursor:string)=>unknown)|null=null;
let writes:Command[]=[];
redis.pipeline=(async(batch:Command[])=>{
 const scan=batch.find(c=>c[0]==="HSCAN"&&String(c[1]).endsWith(":m"));
 if(scan&&fault)return fault(String(scan[2]));
 writes.push(...batch.filter(c=>["SET","RPUSH","SADD","ZADD","DEL"].includes(String(c[0]))));
 return original(batch);
}) as typeof redis.pipeline;
const record=(key:string,email:string,name:string)=>JSON.stringify({k:key,e:email,n:name,h:"",dir:false,mail:true,at:1_700_000_000,seen:1_700_000_100,muted:false,removed:false,t:"",q:[],qa:0,qq:[]});
const keyA="a".repeat(32),keyB="b".repeat(32);
const rowA=record(keyA,"first@example.test","Synthetic First");
const rowB=record(keyB,"second@example.test","Synthetic Second");
const unknown=async(run:()=>Promise<unknown>)=>{try{await run();return "resolved";}catch(e){return e instanceof UnknownReplyError?"unknown":String(e);}};

async function main(){
 redis.clear();cookieValues.clear();afterTasks.length=0;
 process.env.UPSTASH_REDIS_REST_URL="http://stub";
 const email="m3213-owner@example.test";
 await claimHandle(email,"m3213probe","Synthetic Studio","Synthetic community.");
 await ensureStatsId(email);
 await setSubscription(email,{active:true,tier:"pro",cycle:"month",subscriptionId:null,customerId:null,trialEnds:0} as never);
 await setMailSettings(email,{fromName:"Synthetic Studio",address:"Synthetic test setting"});
 await setCommunity(email,true);
 const store=(await storeForEmail(email))!,id=store.community!.id;
 const config=freshConfig(store.name);await saveConfig(id,config);
 const session=await openSession(email);cookieValues.set(SESSION_COOKIE,session);
 await original([["HSET",`nl:cm:${id}:m`,keyA,rowA,keyB,rowB]]);
 const post={id:"123456789abc",title:"Synthetic announcement",text:"Synthetic text."} as Post;

 part("Executable envelopes are refused before any getter or Proxy trap");
 let traps=0;
 const getter=(value:unknown[],at:string)=>Object.defineProperty(value,at,{get(){traps++;return "0";},configurable:true});
 // An async fixture necessarily probes `then` while resolving a returned Proxy.
 // Count only the envelope reads performed after that Promise assimilation.
 const proxy=(v:unknown[])=>new Proxy(v,{get(t,p,r){if(p!=="then")traps++;return Reflect.get(t,p,r);},getOwnPropertyDescriptor(t,p){traps++;return Reflect.getOwnPropertyDescriptor(t,p);}});
 const vectors:[string,unknown][]=[
  ["outer hole",new Array(2)],
  ["page hole",[new Array(2),2]],
  ["row hole",[["0",new Array(2)],2]],
  ["outer getter",getter([undefined,2],"0")],
  ["page getter",[getter([undefined,[]],"0"),2]],
  ["row getter",[["0",getter([keyA,undefined],"1")],2]],
  ["outer Proxy",proxy([["0",[]],0])],
  ["page Proxy",[proxy(["0",[]]),0]],
  ["rows Proxy",[["0",proxy([])],0]],
  ["extra outer slot",[["0",[]],0,"extra"]],
  ["fractional count",[["0",[]],0.5]],
  ["unsafe count",[["0",[]],Number.MAX_SAFE_INTEGER+1]],
 ];
 for(const [label,value] of vectors){
  traps=0;fault=()=>value;
  is(`${label}: unknown`,await unknown(()=>memberPage(id,"0")),"unknown");
  is(`${label}: no executable envelope read`,traps,0);
 }
 fault=null;

 part("A healthy first page cannot hide a malformed second page");
 const secondBad=(cursor:string)=>cursor==="0"?[["7",[keyA,rowA]],2]:[null,2];
 fault=secondBad;
 is("walk refuses instead of returning its first member",await unknown(()=>mailableMembers(id)),"unknown");
 is("reach refuses instead of certifying one",await unknown(()=>announcementReach(id)),"unknown");
 writes=[];
 is("queue refuses the incomplete walk",await unknown(()=>queueAnnouncement(store,config,post)),"unknown");
 is("no announcement job, recipient list or queue entry is written",writes.filter(c=>String(c[1]).startsWith("nl:cm:mail")).length,0);
 const markup=await StudioCommunityPage({searchParams:Promise.resolve({store:store.sid})}).then(page=>renderToStaticMarkup(createElement(AppRouterContext.Provider,{value:{refresh(){}} as never},page)));
 is("real studio states that the full member list did not load",/role="status"[^>]*>Members could not be loaded/.test(markup),true);
 is("real studio does not display the first page as a complete roster",/Synthetic First/.test(markup),false);
 fault=null;

 part("POST uses real owner session, persists a real post, and schedules no provider work here");
 async function request(kind:"malformed"|"transport"|"healthy"){
  fault=kind==="healthy"?null:()=>{if(kind==="transport")throw Error("synthetic member read transport failure");return [null,2];};
  const before=Number((await original([["ZCARD",`nl:cm:${id}:feed`]]))[0]);
  writes=[];afterTasks.length=0;
  const form=new FormData();for(const [k,v] of Object.entries({handle:store.handle,action:"post",kind:"announcement",email:"1",title:"Synthetic announcement",text:"Synthetic body.",from:"feed"}))form.set(k,v);
  const response=await POST(new NextRequest("https://marktmorgen.com/api/store/community",{method:"POST",headers:{host:"marktmorgen.com",origin:"https://marktmorgen.com",cookie:`${SESSION_COOKIE}=${session}`},body:form}));
  fault=null;
  const ids=(await original([["ZREVRANGE",`nl:cm:${id}:feed`,0,-1]]))[0] as string[];
  const saved=ids.length?await readPost(id,ids[0]):null;
  return {status:response.status,location:response.headers.get("location")??"",added:ids.length-before,saved:!!saved&&saved.text==="Synthetic body.",jobs:writes.filter(c=>c[0]==="SADD"&&c[1]==="nl:cm:mailq").length,after:afterTasks.length};
 }
 for(const kind of ["malformed","transport"] as const){
  const result=await request(kind);console.log("M_POST_OBSERVATION",JSON.stringify({kind,...result}));
  is(`${kind}: redirect returned`,result.status,303);
  is(`${kind}: exactly one real post saved`,[result.added,result.saved],[1,true]);
  is(`${kind}: no announcement job or after-send scheduled`,[result.jobs,result.after],[0,0]);
  is(`${kind}: feedback admits the post was saved and not emailed`,new URL(result.location||"/","https://marktmorgen.com").searchParams.get("n"),"notemailed");
  const notice=communityNotices("en")[new URL(result.location||"/","https://marktmorgen.com").searchParams.get("n")??""];
  is(`${kind}: feedback never claims nothing changed`,/Nothing was changed/.test(notice?.text??""),false);
 }
 const healthy=await request("healthy");console.log("M_POST_OBSERVATION",JSON.stringify({kind:"healthy",...healthy}));
 is("healthy: one post, one queued job and one deferred send",[healthy.status,healthy.added,healthy.saved,healthy.jobs,healthy.after,new URL(healthy.location).searchParams.get("n")],[303,1,true,1,1,"announced"]);
 fault=null;
 done();
}
void main();
