/**
 * Preflight review extension on #2807 f82e077, following R2's source concern.
 * Only the FIRST GET of the requested course changes. Store/course/task/
 * submission writers, authentication, removal route and Redis memory are real.
 * Blob is a local fetch stand-in; no provider or account is contacted.
 */
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { MockAgent, setGlobalDispatcher, fetch as sdkFetch } from "undici";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { POST as productRoute } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { lessonsInOrder, readCourse } from "@/lib/course";
import { handIn, readTaskFor, submissionOf, takeRoom } from "@/lib/assignment";
import { taskFolder } from "@/lib/assignment-rules";
import { emailKey, storeKey } from "@/lib/learn";
import { readListing } from "@/lib/catalog";
import { dataKey } from "@/lib/store-data";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, imageFolder,
  setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const providerFiles = new Map<string, number>();
const providerDeletes: string[] = [];
const unexpectedHosts: string[] = [];
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
mock.get("https://vercel.com").intercept({path:"/api/blob/delete",method:"POST"}).reply(200, options => {
  const body=JSON.parse(String(options.body)) as {urls:string[]};
  for(const path of body.urls){providerDeletes.push(path);providerFiles.delete(path);}
  return {};
}).persist();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  unexpectedHosts.push(url.hostname);
  return new Response("{}",{status:404});
}) as typeof fetch;

type Mode = "healthy" | "unknown-envelope" | "foreign-first" | "stale-own-golden";
const real = redis.pipeline.bind(redis);
async function scenario(index: number, mode: Mode): Promise<void> {
  part(mode);
  redis.clear(); providerFiles.clear(); providerDeletes.length=0; unexpectedHosts.length=0;
  const owner=`preflight${index}@example.com`;
  const made=await claimHandle(owner,`preflight${index}`,`Preflight ${index}`,"");
  if(!made.ok)throw new Error("store not created");
  await ensureStatsId(owner);await ensureStoreId(owner);
  await setStripeAccount(owner,"acct_Preflight0001",true);
  await setSubscription(owner,{customerId:"cus_Preflight0001",subscriptionId:"sub_Preflight0001",active:true,tier:"creator",period:paidPeriod()});
  const loadedStore=await storeForEmail(owner);if(!loadedStore)throw new Error("store missing");
  const store=loadedStore;
  const session=await openSession(owner);
  const headers={"content-type":"application/json","x-nimbus-store":store.sid!,cookie:`${SESSION_COOKIE}=${session}`};
  async function courseCall(body: Record<string,unknown>) {
    const response=await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course",{method:"POST",headers,body:JSON.stringify(body)}));
    const result=await response.json() as {ok?:boolean;error?:string};
    if(!result.ok)throw new Error(`course writer refused ${JSON.stringify(body)}: ${response.status}/${result.error}`);
  }
  async function makeCourse(title: string) {
    const product=await addProduct(owner,title,"","40");if(!product.ok)throw new Error("product not made");
    const id=product.product.id;await courseCall({action:"enable",id});
    const listing=await readListing((await storeForEmail(owner))!,id);if(!listing?.course)throw new Error("not listed");
    const courseId=listing.course.id;
    // Golden from the real writer BEFORE its lesson exists; never synthesize a course object.
    const earlier=redis.run(["GET",`nl:course:${courseId}`]);
    const before=await readCourse(courseId);if(!before)throw new Error("course missing");
    await courseCall({action:"edit",id,op:"lesson-add",moduleId:before.modules[0].id,title:"Actual assignment lesson"});
    const course=await readCourse(courseId);const lesson=course&&lessonsInOrder(course).at(-1)?.lesson;
    if(!lesson)throw new Error("lesson missing");
    const task={prompt:"Explain your answer.",review:true,gate:true,file:true};
    await courseCall({action:"task",id,lessonId:lesson.id,task});
    const who=emailKey("student@example.com");
    const path=taskFolder(await imageFolder(owner),courseId,lesson.id,who)+"1".repeat(32)+".pdf";
    const file={path,name:"answer.pdf",bytes:1000,type:"application/pdf"};
    providerFiles.set(path,file.bytes);
    if(!await takeRoom(storeKey(store),file.bytes,undefined,path))throw new Error("room refused");
    await handIn({data:store,courseId,lessonId:lesson.id,who,email:"student@example.com",task,text:"A real writer's synthetic answer.",file});
    return {id,courseId,lessonId:lesson.id,who,path,earlier};
  }
  const target=await makeCourse("Requested course");
  const other=await makeCourse("Other retained course, same creator");
  async function work(c: typeof target) {
    const files=redis.run(["HGETALL",`nl:course:${c.courseId}:task:${c.lessonId}:files`]);
    return {task:await readTaskFor(c.courseId,c.lessonId),submission:await submissionOf(c.courseId,c.lessonId,c.who),files,
      all:redis.run(["ZRANGEBYSCORE",`nl:course:${c.courseId}:tasks:all`,"-inf","+inf"]),
      waiting:redis.run(["ZRANGEBYSCORE",`nl:course:${c.courseId}:tasks:waiting`,"-inf","+inf"]),
      room:redis.run(["HGET",dataKey(store)!,`ca:${c.courseId}`]),provider:providerFiles.has(c.path)};
  }
  const targetBefore=await work(target),otherBefore=await work(other);
  const otherRaw=redis.run(["GET",`nl:course:${other.courseId}`]);
  const targetRaw=redis.run(["GET",`nl:course:${target.courseId}`]);
  const byteKey=`nl:tasks:bytes:${storeKey(store)}`;
  const bytesBefore=redis.run(["GET",byteKey]);
  if(typeof bytesBefore!=="string"||!/^\d+$/.test(bytesBefore)||Number(bytesBefore)!==2000)throw new Error("real room fixture not confirmed");
  is("two real tasks, submissions, file indexes and provider files exist",[targetBefore,otherBefore].every(w=>Boolean(w.task&&w.submission&&w.provider&&Array.isArray(w.files)&&w.files.length===2&&Array.isArray(w.all)&&w.all.length===1&&Number(w.room)>0)),true);
  let reads=0,injections=0;
  redis.pipeline=(async commands=>{
    if(commands.length===1&&commands[0][0]==="GET"&&commands[0][1]===`nl:course:${target.courseId}`){
      reads++;
      if(reads===1&&mode!=="healthy"){
        injections++;
        if(mode==="unknown-envelope")return [];
        if(mode==="foreign-first")return [otherRaw];
        return [target.earlier];
      }
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let response:Response;
  try {response=await productRoute(new NextRequest("https://marktmorgen.com/api/store/product",{method:"POST",headers,body:JSON.stringify({action:"remove",id:target.id})}));}
  finally {redis.pipeline=real;}
  const body=await response.json() as {ok?:boolean;error?:string};
  const listed=Boolean(await readListing((await storeForEmail(owner))!,target.id));
  const after=await work(target),otherAfter=await work(other);
  is("only the first requested course GET was changed",injections,mode==="healthy"?0:1);
  // Historical 170ae75 expected 503 for []/foreign here. That was too strict:
  // an independent exact read plus complete fallback cleanup is also safe.
  // Keep both safe outcomes explicit; asset and orphan assertions below stay unchanged.
  const rawAfter=redis.run(["GET",`nl:course:${target.courseId}`]);
  const bytesAfter=redis.run(["GET",byteKey]);
  const roomReleased=after.room===null||after.room==="0"||after.room===0;
  const complete= !listed&&rawAfter===null&&!after.task&&!after.submission&&!after.provider&&
    Array.isArray(after.files)&&after.files.length===0&&Array.isArray(after.all)&&after.all.length===0&&
    Array.isArray(after.waiting)&&after.waiting.length===0&&roomReleased&&bytesAfter==="1000";
  const retained=listed&&rawAfter===targetRaw&&JSON.stringify(after)===JSON.stringify(targetBefore)&&bytesAfter===bytesBefore;
  const refused=response.status===503&&body.ok===false&&retained;
  const completed=response.status===200&&body.ok===true&&!listed;
  // The golden case has its unchanged orphan assertion below. The [] and
  // foreign controls accept 200 ONLY with every target asset and both rooms settled.
  is("fallback resolves every target asset or refuses with every target asset retained",refused||completed&&(mode==="stale-own-golden"||complete),true);
  is("a refusal retains identity and only a completed removal detaches it",listed,response.status===503);
  is("the other course remains byte-identical",redis.run(["GET",`nl:course:${other.courseId}`]),otherRaw);
  is("the other course's real work and provider file remain unchanged",otherAfter,otherBefore);
  const orphan= !listed&&!complete;
  is("completed removal never leaves assignment work and its file orphaned",orphan,false);
  is("only the synthetic Blob delete transport was requested",unexpectedHosts,[]);
  console.log("OBSERVED",JSON.stringify({mode,status:response.status,body,listed,reads,injections,
    target:{task:!!after.task,submission:!!after.submission,files:after.files,all:after.all,room:after.room,provider:after.provider},
    otherRetained:JSON.stringify(otherAfter)===JSON.stringify(otherBefore),providerDeletes:providerDeletes.length,bytesBefore,bytesAfter,complete,retained,orphan}));
}
async function main():Promise<void>{
  const blocked = await sdkFetch("https://j-review-unregistered.invalid/never-network").then(
    () => "unexpected-response",
    (error: unknown) => String((error as {cause?:{code?:unknown}}).cause?.code ?? "unknown-error"),
  );
  is("the SDK's actual dispatcher refuses an unregistered destination locally",blocked,"UND_MOCK_ERR_MOCK_NOT_MATCHED");
  if(blocked!=="UND_MOCK_ERR_MOCK_NOT_MATCHED")throw new Error("network isolation control failed; no removal was attempted");
  process.env.UPSTASH_REDIS_REST_URL??="http://stub";
  // Ephemeral synthetic credential, generated only after the blocked-network control; never printed or saved.
  process.env.BLOB_READ_WRITE_TOKEN=["vercel","blob","rw",randomBytes(12).toString("hex"),randomBytes(16).toString("hex")].join("_");
  for(const [index,mode] of [[1,"healthy"],[2,"unknown-envelope"],[3,"foreign-first"],[4,"stale-own-golden"]] as const)await scenario(index,mode);
  done();
}
void main().catch(error=>{console.error(error);process.exit(1)});
