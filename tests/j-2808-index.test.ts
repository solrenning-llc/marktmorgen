/** Certificate copy index schema: real helper/MemoryRedis, synthetic records, only one index reply altered. */
import { certificatesOf, certKey, allKey } from "@/lib/certificate";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { is, done } from "./check";
const course="c".repeat(32), id="j".repeat(16), email="student@example.test";
const by=`nl:course:${course}:certs:by:${emailKey(email)}`, current=`nl:course:${course}:certs`;
const record={id,store:"synthetic-school",productId:"course",courseId:course,name:"Sample Student",title:"Sample Course",creator:"Sample School",email,issuedAt:1790000000,withdrawnAt:0};
const pipeline=redis.pipeline.bind(redis);
async function main(){
 for(const vector of ["personal","standing","legacy"] as const) for(const corrupt of [false,true]){
  redis.clear();
  await pipeline([["SET",certKey(id),JSON.stringify(record)],["SADD",allKey(course),id]]);
  if(vector!=="legacy")await pipeline([["SADD",allKey(course),...Array.from({length:500},(_,i)=>i.toString(36).padStart(16,"0"))]]);
  if(vector==="personal")await pipeline([["SADD",by,id]]);
  if(vector==="standing")await pipeline([["HSET",current,emailKey(email),id]]);
  let hits=0; const commandsSeen:(string|number)[][]=[];
  redis.pipeline=async commands=>{commandsSeen.push(...commands);const reply=await pipeline(commands);if(corrupt&&!hits){
   if(vector==="personal"&&commands.length===3&&commands[0][0]==="SMEMBERS"){hits++;return [["not-a-certificate-id"],...reply.slice(1)];}
   if(vector==="standing"&&commands.length===3&&commands[1][0]==="HGET"){hits++;return [reply[0],"not-a-certificate-id",reply[2]];}
   if(vector==="legacy"&&commands.length===1&&commands[0][0]==="SMEMBERS"&&commands[0][1]===allKey(course)){hits++;return [["not-a-certificate-id"]];}
  }return reply;};
  let outcome="resolved",copies:unknown[]=[];
  try{copies=await certificatesOf([course],email);}catch(e){outcome=e instanceof Error?e.name:typeof e;}finally{redis.pipeline=pipeline;}
  is(`${vector}/${corrupt?"unknown":"healthy"}: copy is complete or explicitly unknown`,[outcome,copies.length],corrupt?["UnknownReply",0]:["resolved",1]);
  is(`${vector}/${corrupt?"unknown":"healthy"}: only intended index response injected`,hits,corrupt?1:0);
  is(`${vector}/${corrupt?"unknown":"healthy"}: actual certificate remains stored`,(await pipeline([["GET",certKey(id)]]))[0],JSON.stringify(record));
  is(`${vector}/${corrupt?"unknown":"healthy"}: application only reads`,commandsSeen.every(c=>["SMEMBERS","HGET","SCARD","MGET"].includes(String(c[0]))),true);
 }
 done();
}
main().catch(e=>{redis.pipeline=pipeline;console.error(e);process.exitCode=1;});
