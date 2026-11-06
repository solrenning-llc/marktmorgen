/** Independent opt-in: native empty course after erasure and valid empty SCAN page. */
import { GET as studentsRead } from "@/app/api/v1/students/route";
import { makeKey } from "@/lib/api-keys";
import { emptyCourse,saveCourse } from "@/lib/course";
import { forgetLearnerPerson,setBlocked,touchStudent } from "@/lib/learn";
import { addProduct,claimHandle,ensureStatsId,setProductCourse,setSubscription,storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done,is,part } from "./check";
// Any accidental network use is a fixture failure; this API journey needs none.
globalThis.fetch=(async ()=>{throw Error("unexpected network in empty-page proof");}) as typeof fetch;
async function main(){
 const owner="g2717-empty@example.com",email="g2717-empty-student@example.com";
 await claimHandle(owner,"g2717-empty","Synthetic empty course","");await ensureStatsId(owner);
 await setSubscription(owner,{customerId:"cus_G2717Empty",subscriptionId:"sub_G2717Empty",active:true,tier:"pro",period:paidPeriod()});
 const made=await addProduct(owner,"Synthetic empty course","","29");if(!made.ok)throw Error("product fixture");
 const course=emptyCourse();await saveCourse(course,ROOM);await setProductCourse(owner,made.product.id,{id:course.id,lessons:0});const store=(await storeForEmail(owner))!;
 const key=await makeKey(store.sid,"Synthetic reader");if(!key.ok)throw Error("key fixture");
 const read=async()=>{const r=await studentsRead(new Request(`https://marktmorgen.com/api/v1/students?product=${made.product.id}`,{headers:{authorization:`Bearer ${key.key}`}}));return{status:r.status,body:await r.json() as {total?:number;data?:{blocked:boolean}[];next?:string|null;error?:string}};};
 part("Legitimate empty page: native erasure of the last blocked student");
 let result=await read();is("ordinary empty course still opens",[result.status,result.body.total,result.body.data?.length,result.body.next],[200,0,0,null]);
 await touchStudent(course.id,email,Math.floor(Date.now()/1000),store);await setBlocked(store,course.id,email,true);
 result=await read();is("real enrolled and blocked student is visible",[result.status,result.body.total,result.body.data?.[0]?.blocked],[200,1,true]);
 await forgetLearnerPerson(store,email,[{courseId:course.id,moduleIds:[]}]);
 const native=redis.pipeline.bind(redis);
 is("real erasure leaves zero students and one block",await native([["HLEN",`nl:course:${course.id}:students`],["SCARD",`nl:course:${course.id}:blocked`]]),[0,1]);
 result=await read();is("native confirmed empty course remains readable after erasure",[result.status,result.body.total,result.body.data?.length,result.body.next],[200,0,0,null]);console.log("OBSERVED erased-empty",JSON.stringify(result));
 part("A valid empty nonterminal HSCAN page must keep its cursor");
 await touchStudent(course.id,email,Math.floor(Date.now()/1000),store);
 let hits=0;redis.pipeline=(async commands=>{
  const replies=await native(commands);
  if(commands[0]?.[0]==="HSCAN"&&commands[0]?.[1]===`nl:course:${course.id}:students`){hits++;return [["37",[]],...replies.slice(1)];}
  return replies;
 }) as typeof redis.pipeline;
 result=await read();is("only one HSCAN page replaced",hits,1);is("valid empty intermediate page permits next page",[result.status,result.body.total,result.body.data?.length,result.body.next],[200,1,0,"37"]);console.log("OBSERVED empty-cursor",JSON.stringify(result));
 redis.pipeline=native;result=await read();is("native final control: row/block unchanged",[result.status,result.body.total,result.body.data?.[0]?.blocked],[200,1,true]);
 done();
}
void main();
