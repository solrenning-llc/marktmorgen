/** G: after a permitted v1 key prune, an indeterminate first resume must be reconciled before replay. */
import {resumeMembership} from "@/lib/membership-pause";
import {addMonths} from "@/lib/membership-pause-rules";
import {claimHandle,ensureStatsId,setPauseMonths,setStripeAccount,storeForEmail} from "@/lib/store";
import {createHash} from "node:crypto";
import {store as redis} from "./redis-stub";
import {done,is,part} from "./check";
const DAY=86400,HOUR=3600000,SUB="sub_GRetention01",CUSTOMER="cus_GRetention01",END=Date.UTC(2026,9,31)/1000;
const actualNow=Date.now;let clock=actualNow(),origin=clock;
const paused=()=>({id:SUB,status:"active",billing_mode:{type:"classic"},customer:CUSTOMER,pause_collection:{behavior:"void",resumes_at:addMonths(END,2)},metadata:{store:"gretention",product:"prod000001",pause_from:String(END),paused_at:String(END-DAY)},items:{data:[{current_period_end:END,price:{unit_amount:900,currency:"usd",recurring:{interval:"month",interval_count:1}}}]}});
let sub:Record<string,unknown>=paused(),effects=0,keys:string[]=[],plan:string[]=[];
const saved=new Map<string,{at:number,status:number,body:unknown,params:string}>();
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const path=new URL(String(input)).pathname,method=init?.method??"GET";
 if(path==="/v1/customers")return Response.json({data:[{id:CUSTOMER}],has_more:false});
 if(path===`/v1/customers/${CUSTOMER}`)return Response.json({id:CUSTOMER,email:"member@example.test"});
 if(path==="/v1/subscriptions"&&method==="GET")return Response.json({data:[sub],has_more:false});
 if(path===`/v1/subscriptions/${SUB}`&&method==="POST"){
  const key=new Headers(init?.headers).get("idempotency-key")??"",params=String(init?.body);keys.push(key);
  const previous=saved.get(key);
  if(key&&previous&&clock-previous.at<24*HOUR){
   if(previous.params!==params)return Response.json({error:{type:"idempotency_error"}},{status:400});
   return Response.json(previous.body,{status:previous.status});
  }
  // Permitted policy: prune a v1 key once it is at least24h old; no claim every provider does so exactly then.
  if(previous)saved.delete(key);
  const mode=plan.shift()??"normal";
  let status=200,body:unknown;
  if(mode==="decline"){status=402;body={error:{type:"card_error",code:"card_declined"}};}
  else{
   if(new URLSearchParams(params).get("billing_cycle_anchor")==="now")effects++;
   if(mode==="partial500"){
    // Explicit conditional model: a500 had a payment side effect, but the subscription GET still reports paused.
    // The documentation allows indeterminate side effects; it does NOT establish this precise provider ordering.
    status=500;body={error:{type:"api_error"}};
   }else{sub={...sub,pause_collection:null,metadata:{...(sub.metadata as Record<string,string>),pause_from:""}};body=sub;}
  }
  if(key)saved.set(key,{at:clock,status,body,params});
  return Response.json(body,{status});
 }
 throw Error("unexpected synthetic request");
}) as typeof fetch;
async function main(){
 Date.now=()=>clock;
 try{
  redis.clear();process.env.STRIPE_SECRET_KEY="sk_test_g_retention";
  const owner="g-retention@example.test";await claimHandle(owner,"gretention","G retention","");await ensureStatsId(owner);await setStripeAccount(owner,"acct_GRetention01",true);await setPauseMonths(owner,2);
  const shop=(await storeForEmail(owner))!,token="ab".repeat(32),link=`nl:manage:link:${createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0,40)}`;
  const renewLink=()=>redis.pipeline([["SET",link,JSON.stringify({a:shop.stripeAccountId,c:CUSTOMER,h:shop.handle}),"EX",3600]]);
  const resume=async()=>{await renewLink();return resumeMembership(shop,token,SUB,END+DAY+Math.floor((clock-origin)/1000));};
  const reset=()=>{redis.clear();clock=actualNow();origin=clock;sub=paused();effects=0;keys=[];saved.clear();plan=[];};
  part("Indeterminate500 with a side effect, still-paused GET, then a permitted key prune");
  reset();plan=["partial500"];
  const first=await resume();
  is("first outcome is unknown with the declared partial side effect",[first,effects,Boolean(sub.pause_collection)],[{ok:false,reason:"error"},1,true]);
  clock+=23*HOUR;const within=await resume();
  is("inside24h the same key replays500 and never repeats the effect",[within,effects,keys[0]===keys[1]],[{ok:false,reason:"error"},1,true]);
  clock+=2*HOUR;const after=await resume();
  console.log("G3090_RETENTION",JSON.stringify({after,effects,keys,paused:!!sub.pause_collection}));
  is("unresolved resume after the retry window never starts a fresh operation",after.ok,false);
  is("a pruned idempotency key never duplicates the first unknown payment",effects,1);
  part("Healthy controls");
  reset();const good=await resume(),again=await resume();
  is("known successful resume is not sent twice",[good.ok,again.ok,effects,keys.length],[true,false,1,1]);
  reset();plan=["decline","normal"];const refused=await resume(),fixed=await resume();
  is("certain decline can advance the attempt and then charge once",[refused,fixed,effects,keys[0]!==keys[1]],[{ok:false,reason:"declined"},{ok:true},1,true]);
  done();
 }finally{Date.now=actualNow;}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
