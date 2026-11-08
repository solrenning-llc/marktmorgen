/** Codex S independent privacy probe: applied DEL with lost/malformed acknowledgment. */
import { forgetHealthCopy } from "@/lib/member-health";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
const store={statsId:"shealthcopy1"} as Store;
const key="nl:health:shealthcopy1";
const real=redis.pipeline.bind(redis);
const outcome=async()=>{try{return `answered ${await forgetHealthCopy(store)}`;}catch(e){return e instanceof UnknownReplyError ? "unknown" : "threw";}};
async function main(){
 redis.clear();await real([["SET",key,"synthetic cache"]]);
 is("healthy actual deletion",await outcome(),"answered 1");
 is("healthy absent key",await outcome(),"answered 0");
 for(const [label,reply] of [["text",["1"]],["extra",[1,1]],["hole",new Array(1)]] as [string,unknown[]][]){
  await real([["SET",key,"synthetic cache"]]);let used=false;
  redis.pipeline=(async(commands:(string|number)[][])=>{const r=await real(commands);if(commands.length===1&&commands[0][0]==="DEL"&&commands[0][1]===key){used=true;return reply;}return r;}) as typeof redis.pipeline;
  try{is(`${label}: applied unknown ACK is not confirmed`,await outcome(),"unknown");}finally{redis.pipeline=real;}
  is(`${label}: actual DEL reached and removed cache`,[used,await real([["EXISTS",key]])],[true,[0]]);
  is(`${label}: healthy retry confirms absent`,await outcome(),"answered 0");
 }
 done();
}
void main();
