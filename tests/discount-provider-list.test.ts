import { done,is,part } from "./check";
import { isDeepStrictEqual } from "node:util";

const originalFetch=globalThis.fetch;
const priorKey=process.env.STRIPE_SECRET_KEY;
const priorBase=process.env.STRIPE_CONNECT_API_BASE;
process.env.STRIPE_SECRET_KEY="sk_test_local_discount_provider_only";
process.env.STRIPE_CONNECT_API_BASE="http://127.0.0.1:4999";
let body:unknown={data:[]},status=200,requests=0;
globalThis.fetch=(async(input:RequestInfo|URL)=>{
 const url=String(input);if(!url.startsWith("http://127.0.0.1:4999/"))throw Error("Unexpected external provider request");
 requests++;
 return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
}) as typeof fetch;
async function main(){
try{
 const {listCodes}=await import("@/lib/discount");
 part("Unknown provider discount lists cannot clear the checkout discount flag");
 for(const value of [{}, {data:null},{data:{}},{data:""},{data:[null]},{data:[[]]},{data:[{}]},{data:[{id:"promo_bad",code:""}]}]){
  body=value;status=200;
  is("malformed provider list is refused",await listCodes("acct_synthetic_discount"),{state:"error"});
 }
 body={data:[]};
 is("explicit empty provider list remains valid",await listCodes("acct_synthetic_discount"),{state:"ok",codes:[]});
 const row={id:"promo_preserved",code:"Creator-Édition",active:true,times_redeemed:3,max_redemptions:null,expires_at:null,promotion:{coupon:{percent_off:12.5}}};
 body={data:[row]};
 const expected={id:row.id,code:row.code,active:true,timesRedeemed:3,maxRedemptions:null,expiresAt:null,off:{kind:"percent",percent:12.5},minimum:null,firstOrder:false,duration:null,otherRules:false};
 is("valid creator spelling and IDs remain unchanged",isDeepStrictEqual(await listCodes("acct_synthetic_discount"),{state:"ok",codes:[expected]}),true);
 body={data:[row,{...row,id:""}]};
 is("one unreadable row refuses whole reconciliation",await listCodes("acct_synthetic_discount"),{state:"error"});
 body={data:[row,row]};
 is("duplicate provider IDs refuse ambiguous reconciliation",await listCodes("acct_synthetic_discount"),{state:"error"});
 body={error:{message:"Synthetic provider failure"}};status=500;
 is("provider HTTP failure is not empty success",await listCodes("acct_synthetic_discount"),{state:"error"});
 is("all provider requests stayed synthetic",requests,13);
}finally{
 globalThis.fetch=originalFetch;
 if(priorKey===undefined)delete process.env.STRIPE_SECRET_KEY;else process.env.STRIPE_SECRET_KEY=priorKey;
 if(priorBase===undefined)delete process.env.STRIPE_CONNECT_API_BASE;else process.env.STRIPE_CONNECT_API_BASE=priorBase;
}
done();
}
main().catch(error=>{console.error(error);process.exit(1);});
