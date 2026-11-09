/** G separate option-A boundary: post-delete host config failure loses the unconfirmed-revoke notice. */
import {disconnectHostGoogle} from "@/lib/host-calendar";
import {hostId} from "@/lib/host-claims";
import {seal} from "@/lib/secret-box";
import {store as redis} from "./redis-stub";
import {done,is} from "./check";
const SID="s0000000000000000-ghostretry",EMAIL="host@example.test",HOST=hostId(EMAIL);
const KEY=`nl:meet:conn:hosts:google:h:${HOST}`,CFG=`nl:hostcal:cfg:${HOST}`;
const raw=redis.pipeline.bind(redis);
let mode:"none"|"missing"|"throw"="none",armed=false,active=true,requests=0;
redis.pipeline=(async(commands:(string|number)[][])=>{
 if(armed&&commands.length===1&&commands[0][0]==="GET"&&commands[0][1]===CFG){
  armed=false;
  if(mode==="missing")return [];
  if(mode==="throw")throw Error("synthetic post-delete config failure");
 }
 const result=await raw(commands);
 if(mode!=="none"&&commands.some(c=>c[0]==="DEL"&&c[1]===KEY))armed=true;
 return result;
}) as typeof redis.pipeline;
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
 const u=new URL(String(input));
 if(u.hostname!=="oauth2.googleapis.com"||u.pathname!=="/revoke"||init?.method!=="POST")throw Error("unexpected synthetic provider request");
 if(new URLSearchParams(String(init.body)).get("token")!=="synthetic-host-grant")throw Error("unexpected synthetic token");
 requests++;
 return Response.json({error:"invalid_request"},{status:400});
}) as typeof fetch;
async function main(){
 for(const fault of ["missing","throw"] as const){
  redis.clear();armed=false;active=true;requests=0;mode=fault;
  const ctx=(part:string)=>`meet|hosts|google|h:${HOST}|${part}`;
  await raw([["SET",KEY,JSON.stringify({provider:"google",account:{id:"synthetic-host",email:EMAIL,name:""},refresh:seal("synthetic-host-grant",ctx("refresh")),access:seal("synthetic-host-grant",ctx("access")),expires:0,scope:"",connectedAt:1,by:EMAIL,owner:{email:EMAIL,handle:"fixture"},broken:"",brokenAt:0})]]);
  const first=await disconnectHostGoogle({statsId:SID},EMAIL).then(x=>x,()=>"unknown");
  is(`${fault}: first action reports post-delete failure`,first,"unknown");
  mode="none";armed=false;
  is(`${fault}: local token is gone but refused provider grant remains`,[(await raw([["GET",KEY]]))[0],active,requests],[null,true,1]);
  const retry=await disconnectHostGoogle({statsId:SID},EMAIL);
  console.log("G_HOST_RETRY",JSON.stringify({fault,first,retry,active,requests}));
  is(`${fault}: healthy retry preserves the unconfirmed-provider warning`,retry,false);
 }
 done();
}
void main();
