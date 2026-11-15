import { openCount, settleStoreList } from "@/lib/payment-request-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
// The removal is the separate SREM it was, or since issue #4728 the one-step script that counts again inside Redis.
const removes = (c: (string | number)[]) => c[0] === "SREM" || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:payreq-idle-store:"));
async function main() {
 const original=redis.pipeline;
 const sid="synthetic-count-store";
 let calls:(string|number)[][]=[];
 part("Unverified counts never establish zero or remove sweep coverage");
 for (const reply of [null,[],[0],[0,null],[0,undefined],[0,"0"],[0,false],[0,-1],[0,0.5],[null,0],[0,0,0]]) {
  calls=[];redis.pipeline=async commands=>{calls.push(...commands);return reply as unknown[];};
  let refused=false;try { await openCount(sid); } catch { refused=true; }
  is("unknown count refused",refused,true);
  await settleStoreList(sid);
  is("unknown count preserves store membership",calls.some(removes),false);
 }
 for (const count of [0,1,200]) {
  calls=[];redis.pipeline=async commands=>{calls.push(...commands);return removes(commands[0] ?? [])?[1]:[0,count];};
  is("verified count preserved",await openCount(sid),count);
  await settleStoreList(sid);
  is("only verified zero settles store membership",calls.some(removes),count===0);
 }
 let refused=false;try { await openCount(""); } catch { refused=true; }
 is("missing identity is not a zero count",refused,true);
 redis.pipeline=original;
 done();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
