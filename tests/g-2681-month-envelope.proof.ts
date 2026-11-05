import { payoutUnknownMonth } from "@/lib/paypal-payouts";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
async function main():Promise<void>{
  const original=redis.pipeline.bind(redis);
  try{
    for(const [label,reply,expected] of [
      ["exact one-command envelope",[["1","2","3"]],{unknown:1,settled:2,manual:3}],
      ["extra command reply is unknown",[["1","2","3"],["999"]],null],
      ["missing command reply is unknown",[],null],
      ["confirmed absent fields are zero",[[null,null,null]],{unknown:0,settled:0,manual:0}],
    ] as const){
      redis.pipeline=(async()=>reply) as unknown as typeof redis.pipeline;
      is(label,await payoutUnknownMonth("2026-11"),expected);
    }
  }finally{redis.pipeline=original;}
  done();
}
void main();
