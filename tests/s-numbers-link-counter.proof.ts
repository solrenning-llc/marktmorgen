/** Bounded main-only proof; no product fix or changed limits. */
import { countOpen, OPENS_PER_DAY, LINK_ID } from "@/lib/numbers-links";
import { store as redis } from "./redis-stub";
import { is, done } from "./check";

const id="numberscounterproof1";
const now=Date.UTC(2026,10,8,12);
const key=`nl:nlink:opens:${id}:2026-11-08`;

async function main(): Promise<void> {
  redis.clear();
  is("fixture link ID passes production validation",LINK_ID.test(id),true);
  is("first exact opening admitted",await countOpen(id,now),true);
  let healthy=1;
  for(let i=1;i<OPENS_PER_DAY;i++) if(await countOpen(id,now)) healthy++;
  is("healthy producer reaches existing daily maximum",healthy,OPENS_PER_DAY);
  is("next exact opening refused",await countOpen(id,now),false);

  const replies: [string,unknown][]=[
    ["unknown count",[null,1]],
    ["count as text",["1",1]],
    ["count as boolean",[false,1]],
    ["impossible zero after INCR",[0,1]],
    ["missing expiry ACK",[1]],
    ["expiry not confirmed",[1,0]],
    ["extra pipeline reply",[1,1,1]],
  ];
  const original=redis.pipeline.bind(redis);
  for(const [label,reply] of replies){
    // Reuse a count reached by the healthy producer above, not an invented overflow.
    // This never resets the execution guard or its command budget.
    await original([["SET",key,String(OPENS_PER_DAY)]]);
    let intercepted=false;
    redis.pipeline=(async(commands:(string|number)[][])=>{
      const actual=await original(commands);
      if(commands[0]?.[0]==="INCR"&&commands[0]?.[1]===key){intercepted=true;return reply;}
      return actual;
    }) as typeof redis.pipeline;
    try {
      is(`${label}: unknown does not admit opening`,await countOpen(id,now),false);
    } finally {redis.pipeline=original;}
    is(`${label}: actual committed counter is above the maximum`,await original([["GET",key]]),[String(OPENS_PER_DAY+1)]);
    is(`${label}: real pipeline was reached before fault`,intercepted,true);
  }
  done();
}
void main();
