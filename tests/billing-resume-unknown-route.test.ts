import {NextRequest} from "next/server";
import {POST} from "@/app/api/billing/cancel/route";
import {POST as pausePOST} from "@/app/api/billing/pause/route";
import {PLAN_BREAKS_ENABLED} from "@/lib/plan-pause-rules";
import {claimHandle,setSubscription,storeForEmail,storeRef} from "@/lib/store";
import {state} from "./billing-resume-route-world";
import {store as redis} from "./redis-stub";
import {PAUSE_OBSERVATION} from "@/lib/plan-pause";
import {done,is,part} from "./check";
process.env.STRIPE_SECRET_KEY="sk_test_resume_unknown_only";
let writes=0;
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const u=new URL(String(input));
 if(u.origin!=="https://api.stripe.com"||!u.pathname.startsWith("/v1/subscriptions/")||init?.method!=="POST")throw Error("Unexpected synthetic provider request");
 writes++;
 return Response.json({id:state.store!.subscriptionId,status:"active",cancel_at_period_end:new URLSearchParams(String(init?.body??"")).get("cancel_at_period_end")==="true",cancel_at:null,items:{object:"list",data:[{price:{unit_amount:6900,recurring:{interval:"month",interval_count:1}}}]}});
}) as typeof fetch;
const request=()=>new NextRequest("https://local.example/api/billing/cancel",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"intent=resume"});
async function main(){
 part("Actual resume route preserves unknown pause outcomes");
 const email="resume-unknown@example.com";
 await claimHandle(email,"resumeunknown","A store","");
 await setSubscription(email,{customerId:"cus_ResumeUnknown01",subscriptionId:"sub_ResumeUnknown01",active:true,tier:"creator",cycle:"month"});
 state.store=(await storeForEmail(email))!;
 const ref=storeRef(state.store),key="nl:pause:"+ref,year="nl:pause:last:"+ref;
 const pipeline=redis.pipeline;
 const until=Math.floor(Date.now()/1000)+86400;
 await pipeline([["SET",year,"123"],["ZADD","nl:pause:due",until,ref]]);
 for(const mode of ["malformed","lost","wrong-type"]){
  await pipeline([["DEL",key]]);
  if(mode==="wrong-type")await pipeline([["HSET",key,"evidence","retain"]]);
  else await pipeline([["SET",key,"{broken"]]);
  writes=0;let observations=0;
  redis.pipeline=async commands=>{
   if(commands.some(c=>c[0]==="EVAL"&&c[1]===PAUSE_OBSERVATION)){observations++;if(mode==="lost")return [];}
   return pipeline(commands);
  };
  let response:Response;
  try{response=await POST(request());}finally{redis.pipeline=pipeline;}
  is("unknown returns existing error "+mode,new URL(response.headers.get("location")!).searchParams.get("billing"),"cancel-error");
  is("one observation and no provider write "+mode,[observations,writes],[1,0]);
  is("annual and due retained "+mode,await pipeline([["GET",year],["ZSCORE","nl:pause:due",ref]]),["123",String(until)]);
 }
 await pipeline([["DEL",key]]);
 writes=0;
 const response=await POST(request());
 is("known absence permits ordinary resume",new URL(response.headers.get("location")!).searchParams.get("billing"),"resumed");
 is("ordinary resume makes one provider write",writes,1);
 is("opening switch stays off",PLAN_BREAKS_ENABLED,false);
 for(const intent of ["pause","undo"]){
  writes=0;
  const before=await pipeline([["GET",key],["GET",year],["ZSCORE","nl:pause:due",ref]]);
  const blocked=await pausePOST(new NextRequest("https://local.example/api/billing/pause",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"intent="+intent+"&months=1"}));
  is("actual pause route refuses "+intent,new URL(blocked.headers.get("location")!).searchParams.get("billing"),"pause-unavailable");
  is("disabled pause has no provider write "+intent,writes,0);
  is("disabled pause preserves records "+intent,await pipeline([["GET",key],["GET",year],["ZSCORE","nl:pause:due",ref]]),before);
 }
 const record=JSON.stringify({subscription:state.store!.subscriptionId,customer:"cus_ResumeUnknown01",paymentMethod:"pm_ResumeUnknown01",tier:"creator",from:until-86400,until,told:0});
 await pipeline([["SET",key,record]]);
 writes=0;
 const blockedResume=await POST(request());
 is("cancel route cannot restart a recorded break while off",new URL(blockedResume.headers.get("location")!).searchParams.get("billing"),"pause-unavailable");
 is("blocked restart has no provider write",writes,0);
 is("blocked restart preserves exact record",await pipeline([["GET",key]]),[record]);
 await pipeline([["DEL",key]]);
 writes=0;
 const cancelled=await POST(new NextRequest("https://local.example/api/billing/cancel",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"intent=cancel"}));
 is("normal cancellation remains available",new URL(cancelled.headers.get("location")!).searchParams.get("billing"),"canceling");
 is("normal cancellation reaches provider once",writes,1);

 done();
}
main().catch(e=>{console.error(e);process.exit(1);});
