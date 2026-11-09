// The cancel and switch routes write the store's subscription after Stripe has
// already ended or switched it. A write that did not happen (null) or failed
// (a throw) must never be reported as "ended" or "switched": the store would
// keep the old plan's rights while the creator is told otherwise.
import {NextRequest} from "next/server";
import {POST as cancelPOST} from "@/app/api/billing/cancel/route";
import {POST as switchPOST} from "@/app/api/billing/switch/route";
import {resetWorld,world} from "./billing-subscription-write-world";
import {done,is,part} from "./check";
const form=(path:string,body:string)=>new NextRequest("https://local.example/api/billing/"+path,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
const billing=(response:Response)=>new URL(response.headers.get("location")!).searchParams.get("billing");
async function outcome(run:()=>Promise<Response>){try{return billing(await run());}catch{return "route threw";}}
async function main(){
 part("Cancel: Stripe confirms the end");
 for(const write of ["ok","null","throw"] as const){
  resetWorld();world.write=write;
  const got=await outcome(()=>cancelPOST(form("cancel","intent=cancel")));
  is("ended state, write "+write,got,write==="ok"?"ended":"cancel-error");
  is("one store write asked, write "+write,world.writes,[["write-test@example.com",{active:false}]]);
  is("Stripe asked exactly as before, write "+write,world.provider,[["cancel_at_period_end","sub_WriteTest0001",true]]);
 }
 part("Cancel: Stripe refuses because it is already over");
 for(const write of ["ok","null","throw"] as const){
  resetWorld();world.write=write;world.cancelRefused=true;
  const got=await outcome(()=>cancelPOST(form("cancel","intent=cancel")));
  is("refused-and-over, write "+write,got,write==="ok"?"ended":"cancel-error");
  is("one store write asked after the refusal, write "+write,world.writes.length,1);
  is("Stripe change then read, write "+write,world.provider,[["cancel_at_period_end","sub_WriteTest0001",true],["read","sub_WriteTest0001"]]);
 }
 part("Cancel: still running is unchanged");
 resetWorld();world.cancelState="active";
 is("canceling at period end",await outcome(()=>cancelPOST(form("cancel","intent=cancel"))),"canceling");
 is("no store write while it still runs",world.writes.length,0);
 part("Switch: Stripe confirms the new cycle");
 for(const write of ["ok","null","throw"] as const){
  resetWorld();world.write=write;
  const got=await outcome(()=>switchPOST(form("switch","tier=creator&cycle=year")));
  is("switched state, write "+write,got,write==="ok"?"switched-year":"cancel-error");
  is("one store write with Stripe's plan, write "+write,world.writes,[["write-test@example.com",{active:true,tier:"creator",cycle:"year",trialEnds:0,shared:false,period:null}]]);
  is("Stripe asked exactly as before, write "+write,world.provider,[["switch","sub_WriteTest0001",{tier:"creator",cycle:"year"},{id:"grant_WriteTest"}]]);
 }
 done();
}
main().catch(e=>{console.error(e);process.exit(1);});
