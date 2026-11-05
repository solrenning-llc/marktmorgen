import { payoutUnknownMonth } from "@/lib/paypal-payouts";
import { store as redis } from "./redis-stub";
import { done,is } from "./check";
async function main():Promise<void>{
  const original=redis.pipeline.bind(redis);let traps=0;
  const guarded=(value:unknown[])=>new Proxy(value,{
    get(t,p,r){if(p!=="then")traps++;return Reflect.get(t,p,r);},
    getOwnPropertyDescriptor(t,p){traps++;return Reflect.getOwnPropertyDescriptor(t,p);},
    ownKeys(t){traps++;return Reflect.ownKeys(t);},
  });
  try{
    redis.pipeline=(async()=>[["1","2","3"]]) as typeof redis.pipeline;
    is("native exact reply control",await payoutUnknownMonth("2026-11"),{unknown:1,settled:2,manual:3});
    for(const which of ["outer","inner"]){
      traps=0;const row=["1","2","3"];
      const reply=which==="outer"?guarded([row]):[guarded(row)];
      redis.pipeline=(async()=>reply) as typeof redis.pipeline;
      is(`${which}: Proxy is unavailable`,await payoutUnknownMonth("2026-11"),null);
      is(`${which}: no Proxy reflection or property read`,traps,0);
    }
  }finally{redis.pipeline=original;}
  done();
}
void main();
