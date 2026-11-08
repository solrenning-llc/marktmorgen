import {NextRequest} from "next/server";
import {GET} from "@/app/api/cron/reminders/route";
import {store as redis} from "./redis-stub";
import {calls,world} from "./plan-break-off-cron-world";
import {done,is,part} from "./check";
process.env.STRIPE_SECRET_KEY="sk_test_off_cron_only";
async function main(){
 part("Actual reminder route skips disabled break work and retains ordinary reminder passes");
 const pipeline=redis.pipeline;let pauseReads=0;
 redis.pipeline=async commands=>{
  pauseReads+=commands.filter(c=>String(c[1]).includes("nl:pause")||String(c[1]).includes("pause-due")).length;
  if(commands.some(c=>c[0]==="EVAL"))throw Error("Disabled break worker must not run");
  return pipeline(commands);
 };
 let response:Response;try{response=await GET(new NextRequest("https://local.example/api/cron/reminders"));}finally{redis.pipeline=pipeline;}
 is("actual cron response",response.status,200);
 const body=await response.json();
 is("no pause effects",body.breaks,{told:0,restarted:0,failed:0,dropped:0});
 is("no pause records read",pauseReads,0);
 is("ordinary passes still invoked",calls,["renewal","failed","trial","requests"]);
 part("Trial nudges have a deadline, and payment request reminders their own slice after it, even when the nudges fail (r24 unit 5.1)");
 const before=Date.now();
 is("the nudges stop starting work well inside the 60 s run",world.trialDeadline>before&&world.trialDeadline<=before+35_000,true);
 is("the payment request reminders run past the nudges' deadline",world.requestsDeadline>world.trialDeadline,true);
 // The first run above could not let go of its lock (this test refuses every EVAL there): it runs out by itself.
 await redis.pipeline([["DEL","nl:remind:lock"]]);
 calls.length=0;world.trialThrows=true;
 const failing=await GET(new NextRequest("https://local.example/api/cron/reminders"));
 world.trialThrows=false;
 is("a nudge pass that fails does not fail the run",failing.status,200);
 is("payment request reminders still run after a failed nudge pass",calls,["renewal","failed","trial","requests"]);
 is("the failed nudge pass is said, not hidden",(await failing.json()).nudges,{error:"failed"});
 is("the run's lock is let go after it",await redis.pipeline([["GET","nl:remind:lock"]]).then(([v])=>v),null);
 done();
}
main().catch(e=>{console.error(e);process.exit(1);});
