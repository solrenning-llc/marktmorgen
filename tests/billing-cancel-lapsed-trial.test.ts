// A creator whose first payment after the free trial failed cancels the plan.
// The store is recorded as ended and the studio says so; Stripe must then have
// nothing left that it could still charge (Terms, section 8: "After you cancel,
// you will not be charged"). Setting cancel_at_period_end alone leaves the
// subscription past_due with its open invoice, which Stripe keeps retrying.
// Synthetic only: a stubbed Stripe, the in-memory Redis stub.
import {NextRequest} from "next/server";
import {POST} from "@/app/api/billing/cancel/route";
import {claimHandle,setSubscription,storeForEmail} from "@/lib/store";
import {state} from "./billing-resume-route-world";
import {done,is,part} from "./check";
process.env.STRIPE_SECRET_KEY="sk_test_cancel_lapsed_trial";
const ID="sub_CancelLapsed01";
const trialEnd=Math.floor(Date.now()/1000)-3*86400;
const stripe={status:"past_due" as string,cancelAtPeriodEnd:false,deleted:false,requests:[] as string[]};
const body=()=>({id:ID,object:"subscription",status:stripe.status,trial_end:trialEnd,cancel_at_period_end:stripe.cancelAtPeriodEnd,cancel_at:null,
 metadata:{store:"cancellapsed"},
 items:{object:"list",data:[{current_period_start:trialEnd,current_period_end:trialEnd+30*86400,price:{unit_amount:6900,currency:"usd",recurring:{interval:"month",interval_count:1}}}]}});
globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
 const u=new URL(String(input));
 const method=init?.method??"GET";
 if(u.origin!=="https://api.stripe.com"||u.pathname!=="/v1/subscriptions/"+ID)throw Error("Unexpected synthetic provider request "+method+" "+u.pathname);
 stripe.requests.push(method);
 if(method==="POST"){stripe.cancelAtPeriodEnd=new URLSearchParams(String(init?.body??"")).get("cancel_at_period_end")==="true";return Response.json(body());}
 if(method==="DELETE"){stripe.deleted=true;stripe.status="canceled";return Response.json(body());}
 return Response.json(body());
}) as typeof fetch;
/** Whether Stripe could still collect the open invoice of this subscription. */
const chargeable=()=>!stripe.deleted&&(stripe.status==="past_due"||stripe.status==="active");
async function main(){
 part("Canceling a plan whose first payment after the trial failed");
 const email="cancel-lapsed@example.com";
 await claimHandle(email,"cancellapsed","A store","");
 await setSubscription(email,{customerId:"cus_CancelLapsed01",subscriptionId:ID,active:true,tier:"creator",cycle:"month"});
 state.store=(await storeForEmail(email))!;
 const response=await POST(new NextRequest("https://local.example/api/billing/cancel",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"intent=cancel"}));
 is("the creator is told the plan ended",new URL(response.headers.get("location")!).searchParams.get("billing"),"ended");
 is("the store is recorded as ended",(await storeForEmail(email))!.subscriptionActive,false);
 is("Stripe has nothing left it could still charge",chargeable(),false);
 done();
}
main().catch(e=>{console.error(e);process.exit(1);});
