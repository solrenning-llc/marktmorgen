/** Extra opt-in controls for the empty-page fix, including the blocked read threshold. */
import { studentPage } from "@/lib/learn";
import { emptyCourse } from "@/lib/course";
import { BLOCKED_READ_MAX } from "@/lib/api-read-rules";
import { store as redis } from "./redis-stub";
import { done,is } from "./check";
async function main(){
 const course=emptyCourse();const native=redis.pipeline.bind(redis);
 for(const next of ["0","37"]){for(const blocked of [0,1,BLOCKED_READ_MAX,BLOCKED_READ_MAX+1]){
  let calls=0;const admission:number[][]=[];const total=next==="0"?0:42;
  redis.pipeline=(async commands=>{calls++;if(commands.length!==3||commands[0][0]!=="HSCAN")throw Error("unexpected supplementary read for empty page");return [[next,[]],total,blocked];}) as typeof redis.pipeline;
  const result=await studentPage(course,"0",10,async(rows,b)=>{admission.push([rows,b]);return true;});
  is(`empty page ${next}, blocked ${blocked}: exact data retained`,result,{total,next,students:[]});
  is(`empty page ${next}, blocked ${blocked}: only the counted initial read`,calls,1);
  is(`empty page ${next}, blocked ${blocked}: admission receives exact size`,admission,[[0,blocked]]);
 }}
 for(const [name,total,blocked] of [["unknown total",null,1],["unknown blocked",0,null]] as const){
  let admitted=0;redis.pipeline=(async()=>[["0",[]],total,blocked]) as typeof redis.pipeline;
  is(`${name}: empty page still refuses unknown count`,await studentPage(course,"0",10,async()=>{admitted++;return true;}),null);
  is(`${name}: no follow-on admission`,admitted,0);
 }
 redis.pipeline=native;done();
}
void main();
