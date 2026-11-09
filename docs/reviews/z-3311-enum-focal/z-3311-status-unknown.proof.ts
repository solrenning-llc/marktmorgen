// A fault-injected unknown status string must stay unknown (rule 24).
// This oracle does not claim a real Stripe response or a specific unpublished enum.
import {NextRequest} from "next/server";
import {POST} from "@/app/api/stripe/check/route";
import {GET} from "@/app/api/stripe/return/route";
import {readAccount} from "@/lib/stripe-connect";
import {within} from "@/lib/checkup";
import {stripeCheck} from "@/lib/checkup-rules";
import {SESSION_COOKIE,openSession} from "@/lib/auth";
import {claimHandle,setStripeAccount,storeForEmail} from "@/lib/store";
import {store as redis} from "../../../tests/redis-stub";
import {done,is} from "../../../tests/check";
process.env.STRIPE_SECRET_KEY="sk_test_z3311_unknown_only";
const account="acct_z3311Status",email="z3311-status@example.test";
let body:unknown,requests=0;
const calls:{method:string,path:string,requestBodyBytes:number}[]=[];
globalThis.fetch=(async(input,init)=>{requests++;const u=new URL(String(input));if(u.origin!=="https://api.stripe.com"||u.pathname!=="/v2/core/accounts/"+account||init?.method!=="GET")throw Error("unexpected synthetic request");calls.push({method:String(init.method),path:u.pathname,requestBodyBytes:Buffer.byteLength(String(init.body??""))});return Response.json(body);}) as typeof fetch;
const shaped=(card:string,deadline:string)=>({id:account,configuration:{merchant:{capabilities:{card_payments:{status:card}}}},requirements:{summary:{minimum_deadline:{status:deadline}}}});
const rawPipeline=redis.pipeline;let measured=false,commands=0,jsonBytes=0;
redis.pipeline=async cs=>{if(measured){commands+=cs.length;jsonBytes+=Buffer.byteLength(JSON.stringify(cs));}return rawPipeline(cs);};
const said=(r:Response)=>new URL(r.headers.get("location")??"","https://marktmorgen.com").searchParams.get("stripe");
async function main(){
 is("synthetic owner",(await claimHandle(email,"z3311status","Synthetic","")).ok,true);
 const cookie=SESSION_COOKIE+"="+await openSession(email);
 const routes=[["check",()=>POST(new NextRequest("https://marktmorgen.com/api/stripe/check",{method:"POST",headers:{cookie,origin:"https://marktmorgen.com",host:"marktmorgen.com"}}))],["return",()=>GET(new NextRequest("https://marktmorgen.com/api/stripe/return",{headers:{cookie}}))]] as const;
 for(const [name,call] of routes){
  for(const status of [" ","future_unknown"]){
   await setStripeAccount(email,account,true);body=shaped(status,"currently_due");commands=0;jsonBytes=0;requests=0;measured=true;
   const response=await call();measured=false;
   const still=(await storeForEmail(email))?.stripeChargesEnabled;
   console.log("STATUS_ROUTE",JSON.stringify({name,status,said:said(response),still,commands,jsonBytes,requests}));
   is(name+" unknown status is error "+JSON.stringify(status),said(response),"error");
   is(name+" unknown status preserves selling "+JSON.stringify(status),still,true);
  }
 }
 for(const deadline of [" ","future_unknown"]){body=shaped("active",deadline);const state=stripeCheck(true,await within(()=>readAccount(account),null,2000)).state;console.log("STATUS_CHECKUP",JSON.stringify({deadline,state}));is("unknown deadline is not checked "+JSON.stringify(deadline),state,"not-checked");}
 body=shaped("active","past_due");is("known past due remains a problem",stripeCheck(true,await within(()=>readAccount(account),null,2000)).state,"problem");
 body=shaped("active","currently_due");is("known state remains ok",stripeCheck(true,await within(()=>readAccount(account),null,2000)).state,"ok");
 console.log("PROVIDER_CALLS",JSON.stringify(calls));done();
}
void main();
