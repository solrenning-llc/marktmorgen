import {ENDING_KEY,finishPlanRefunds,refundAndEndPlan} from "@/lib/plan-refund-flow";
import {store as redis} from "./redis-stub";
import {DAY,NOW,paidShop,world} from "./plan-refund-stripe-world";
import {done,is,part} from "./check";

async function main(){
 process.env.STRIPE_SECRET_KEY="sk_test_synthetic_d2_note_only";
 for(const kind of ["null-entry","partial-entry"]){
  redis.clear();world.refundsLeft=null;world.refundsDown=false;
  const shop=await paidShop({at:NOW-20*DAY});shop.addPayment(NOW-2*DAY);
  world.refundsLeft=1;
  try{await refundAndEndPlan(await shop.store(),NOW);}finally{world.refundsLeft=null;}
  const store=await shop.store();
  const raw=await shop.note();
  const note=JSON.parse(String(raw)) as {p:unknown[]};
  part(kind);
  is("real setup has two debts and one refund",[note.p.length,shop.allRefunds().length,shop.sub().status],[2,1,"active"]);
  await finishPlanRefunds(Date.now()+10_000,NOW+3600);
  is("valid partial evidence preserves plan and note",[shop.sub().status,typeof await shop.note()],["active","string"]);
  note.p=kind==="null-entry"?[null]:[note.p[0],null];
  const damaged=JSON.stringify(note);
  await redis.pipeline([["HSET",ENDING_KEY,store.sid,damaged]]);
  const before=world.calls.length;
  await finishPlanRefunds(Date.now()+10_000,NOW+3601);
  is("present malformed debt evidence cannot end plan",shop.sub().status,"active");
  is("unknown debt evidence is retained unchanged",await shop.note(),damaged);
  is("no subscription DELETE from ambiguous debt evidence",world.calls.slice(before).filter(x=>x.startsWith("DELETE /subscriptions/")).length,0);
  is("no second refund occurred",shop.allRefunds().length,1);
 }
 done();
}
main().catch(error=>{console.error(error);process.exit(1);});
