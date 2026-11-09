// The pinned v22.6.0 v2 response enum excludes inactive.
// All provider replies are injected; valid controls use that same pinned enum.
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
  for(const status of ["inactive","restricted"]){
   await setStripeAccount(email,account,true);body=shaped(status,"currently_due");commands=0;jsonBytes=0;requests=0;measured=true;
   const response=await call();measured=false;
   const still=(await storeForEmail(email))?.stripeChargesEnabled;
   console.log("STATUS_ROUTE",JSON.stringify({name,status,said:said(response),still,commands,jsonBytes,requests}));
   is(name+" nominal status result "+status,said(response),status==="inactive"?"error":"pending");
   is(name+" nominal selling state "+status,still,status==="inactive");
   is(name+" one bounded provider GET "+status,requests,1);
  }
 }
 for(const status of ["active","pending","restricted","unsupported"]){body=shaped(status,"currently_due");const actual=await readAccount(account);is("pinned card status "+status,actual,{chargesEnabled:status==="active",detailsSubmitted:true});}
 for(const deadline of ["currently_due","eventually_due","past_due"]){body=shaped("active",deadline);is("pinned deadline "+deadline,stripeCheck(true,await within(()=>readAccount(account),null,2000)).state,deadline==="past_due"?"problem":"ok");}
 body=shaped("inactive","currently_due");let rejected=false;try{await readAccount(account);}catch{rejected=true;}is("inactive reader rejects",rejected,true);
 console.log("PROVIDER_CALLS",JSON.stringify(calls));done();
}
void main();
