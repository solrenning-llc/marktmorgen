/** Independent deterministic interleaving: opt-out/day ceiling changes while the source page is read. No external IO. */
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { type PageReader, saveSender, startPitch } from "@/lib/outreach";
import { PITCHES_PER_DAY } from "@/lib/outreach-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
let modelCalls=0;
globalThis.fetch=(async(input:string|URL|Request)=>{
 const url=new URL(String(input));
 if(url.hostname!=="api.anthropic.com")return new Response("{}",{status:404});
 modelCalls++;
 return new Response(JSON.stringify({content:[{type:"text",text:JSON.stringify({subject:"A recipe video",body:"Hi,\n\nWould a recipe video be of interest?"})}]}),{status:200});
}) as typeof fetch;
const PAGE="https://copperoak.com/partners";
const DOMAIN="copperoak.com";
const NOW=Math.floor(Date.now()/1000)-86400;
const day=new Date(NOW*1000).toISOString().slice(0,10);
type Change="none"|"local"|"global"|"day";
async function attempt(change:Change,beforeRead=false){
 redis.clear();modelCalls=0;
 process.env.ANTHROPIC_API_KEY=`sk-ant-api03-${"x".repeat(40)}`;
 const made=await claimHandle("owner@example.com","harbor","Harbor Kitchen","");
 if(!made.ok)throw Error("no synthetic store");
 await ensureStatsId("owner@example.com");
 await setSubscription("owner@example.com",{customerId:"cus_Owner00001",subscriptionId:"sub_Owner00001",active:true,tier:"pro",trialEnds:0,period:paidPeriod(Date.now(),{behind:30,ahead:300})});
 const store=(await storeForEmail("owner@example.com"))!;
 await saveSender(store,{name:"Jenny Park",address:"PO Box 12, Columbus, OH 43004, USA"});
 const dayKey=`nl:outreach:${store.statsId}:day:${day}`;
 await redis.pipeline([["SET",dayKey,String(PITCHES_PER_DAY-1)]]);
 let changed=false;
 const changeState=async()=>{
  if(change==="local")await redis.pipeline([["SADD",`nl:outreach:${store.statsId}:stop`,DOMAIN]]);
  if(change==="global")await redis.pipeline([["SADD","nl:outreach:stop:all",DOMAIN]]);
  if(change==="day")await redis.pipeline([["INCR",dayKey]]);
  changed=change!=="none";
 };
 if(beforeRead)await changeState();
 const reader:PageReader=async(url)=>{
  if(url===`https://${DOMAIN}/robots.txt`)return{url,html:"User-agent: *\nDisallow: /cart\n"};
  if(url!==PAGE)return null;
  if(!beforeRead)await changeState();
  return{url,html:"<p>Creators and sponsors: write to partnerships@copperoak.com.</p>"};
 };
 const input={goal:"sponsor" as const,country:"US",isCompany:false,page:PAGE,email:"partnerships@copperoak.com",company:"Copper & Oak",about:"Pans.",notes:"I post three family recipes a week."};
 const result=await startPitch(store,input,{reader,now:NOW});
 const [total]=await redis.pipeline([["GET",dayKey]]);
 return {outcome:result.ok?"written":result.reason,modelCalls,changed,total:Number(total)};
}
async function main(){
 part("Exact known state before page read remains controlled");
 is("known permitted state writes the last permitted draft",await attempt("none"),{outcome:"written",modelCalls:1,changed:false,total:PITCHES_PER_DAY});
 for(const change of ["local","global","day"] as const){
  const expected=change==="day"?"day":"stopped";
  const pre=await attempt(change,true);
  is(`${change}: existing refusal control`,[pre.outcome,pre.modelCalls],[expected,0]);
 }
 part("Fresh confirmed state changes during source read are honored before model work");
 for(const change of ["local","global","day"] as const){
  const result=await attempt(change);
  const expected=change==="day"?"day":"stopped";
  is(`${change}: interleaving really changed Redis`,result.changed,true);
  is(`${change}: source read cannot bypass the current refusal`,[result.outcome,result.modelCalls],[expected,0]);
  is(`${change}: no extra draft counted after refusal`,result.total,change==="day"?PITCHES_PER_DAY:PITCHES_PER_DAY-1);
 }
 done();
}
void main();
