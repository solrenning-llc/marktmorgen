import { readAccount, STRIPE_VERSION } from "@/lib/stripe-connect";
import { within } from "@/lib/checkup";
import { stripeCheck } from "@/lib/checkup-rules";
import { done, is } from "../../../tests/check";
process.env.STRIPE_SECRET_KEY="sk_test_z3311_synthetic_only";
const account="acct_z3311Synthetic";
let body:unknown,code=200,transportFailure=false;
let requests=0;
globalThis.fetch=(async (input,init)=>{
 const u=new URL(String(input)); requests++;
 is("only the requested read",[u.origin,u.pathname,init?.method, new Headers(init?.headers).get("Stripe-Version"),u.searchParams.getAll("include")],["https://api.stripe.com","/v2/core/accounts/"+account,"GET",STRIPE_VERSION,["configuration.merchant","requirements"]]);
 if(transportFailure)throw new TypeError("synthetic transport failure");
 return Response.json(body,{status:code});
}) as typeof fetch;
const shaped=(status:unknown,requirements:unknown)=>({id:account,configuration:{merchant:{capabilities:{card_payments:{status}}}},requirements});
async function read(){try{return await readAccount(account);}catch{return null;}}
async function main(){
 const bad:unknown[]=[false,true,"active",{configuration:[],requirements:{summary:{}}},{configuration:{merchant:[]},requirements:{summary:{}}},{configuration:{merchant:{capabilities:[]}},requirements:{summary:{}}},shaped(false,{summary:{}}),shaped([], {summary:{}}),shaped({}, {summary:{}}),shaped("active",false),shaped("active",{summary:false}),shaped("active",{summary:{minimum_deadline:false}}),shaped("active",{summary:{minimum_deadline:{status:false}}}),shaped("active",{summary:{minimum_deadline:{status:""}}})];
 for(let i=0;i<bad.length;i++){body=bad[i];is("unknown shape "+i,await read(),null);}
 for(const [status,deadline,charges,details] of [["active","past_due",true,false],["pending","currently_due",false,true],["restricted","eventually_due",false,true]] as const){body=shaped(status,{summary:{minimum_deadline:{status:deadline}}});is("known state "+status,await read(),{chargesEnabled:charges,detailsSubmitted:details});}
 body={error:{code:"synthetic",message:"synthetic refusal"}};code=503;is("non-200 remains unknown",await read(),null);code=200;transportFailure=true;is("transport remains unknown",await read(),null);transportFailure=false;
 body=shaped("active",{summary:{minimum_deadline:[]}});is("actual checkup boundary retains unknown",stripeCheck(true,await within(()=>readAccount(account),null,2000)).state,"not-checked");
 is("one mock request per read",requests,20);done();
}
void main();
