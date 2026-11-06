/** Opt-in evidence only. Real routes/readers/writers, MemoryRedis and synthetic provider IO. */
import { NextRequest } from "next/server";
import { POST as payCart } from "@/app/api/store/cart/route";
import { POST as paySingle } from "@/app/api/store/checkout/route";
import { POST as payPayPal } from "@/app/api/store/paypal/checkout/route";
import { POST as submitTask } from "@/app/api/store/course/task/route";
import { addProduct, claimHandle, ensureStatsId, setPayPalSeller, setProductCourse, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { setSoon } from "@/lib/waitlist";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, mintPass, passCookieName, recordEnrollment } from "@/lib/learn";
import { DOOR_SECONDS, noteTaskUpload, saveTask, staleTaskUploads, submissionOf } from "@/lib/assignment";
import { taskFolder } from "@/lib/assignment-rules";
import { withConsent } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { answering } from "./security/next-headers";
import { files, deleted } from "./buyer-actions-blob";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const pipeline = redis.pipeline.bind(redis);
const originalFetch = globalThis.fetch;
const originalHas = files.has.bind(files);
const sent: URLSearchParams[] = [];
let paypalOrders = 0;
process.env.STRIPE_SECRET_KEY = "sk_test_c2_route_evidence_only";
process.env.PAYPAL_PARTNER_CLIENT_ID = "partner_client_test";
process.env.PAYPAL_PARTNER_SECRET = "partner_secret_test";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNER00001";
process.env.PAYPAL_BN_CODE = "marktmorgen_test_bn";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    sent.push(new URLSearchParams(String(init.body)));
    return Response.json({id:"cs_test_c2Evidence0000000001",url:"https://checkout.stripe.com/c/pay/cs_test_c2Evidence0000000001"});
  }
  if (url.hostname === "api.stripe.com") return Response.json({object:"list",data:[],has_more:false});
  if (url.hostname === "api-m.paypal.com" && url.pathname === "/v1/oauth2/token") return Response.json({access_token:"synthetic_paypal_token",expires_in:3600});
  if (url.hostname === "api-m.paypal.com" && url.pathname === "/v2/checkout/orders" && init?.method === "POST") {
    paypalOrders++;
    const id=`ORDER${String(paypalOrders).padStart(6,"0")}`;
    return Response.json({id,links:[{rel:"approve",href:`https://www.paypal.com/checkoutnow?token=${id}`}]});
  }
  return Response.json({}, {status:404});
}) as typeof fetch;

async function shop(handle: string, withLink = true): Promise<{owner:string;store:Store;product:string}> {
  const owner = `${handle}@example.test`;
  const claimed = await claimHandle(owner,handle,"Evidence shop","");
  if(!claimed.ok) throw new Error("fixture could not claim store");
  await ensureStatsId(owner);
  await setStripeAccount(owner,"acct_C2Evidence0001",true);
  await setSubscription(owner,{customerId:`cus_${handle}00001`,subscriptionId:`sub_${handle}00001`,active:true,tier:"creator",period:paidPeriod()});
  await setPayPalSeller(owner,"SELLER000001");
  const made = await addProduct(owner,"Evidence guide","A synthetic guide","19",null);
  if(!made.ok) throw new Error("fixture could not add product");
  if(withLink) await setProductLink(owner,made.product.id,"https://example.test/guide");
  const store = await storeForEmail(owner);
  if(!store) throw new Error("fixture store not found");
  return {owner,store,product:made.product.id};
}

async function cart(mode: "empty"|"coming"|"throw"|"null"|"short") {
  redis.clear(); redis.pipeline=pipeline; sent.length=0;
  const w=await shop(`c2cart${mode}`);
  if(mode!=="empty") await setSoon(w.store,w.product,true);
  let reads=0;
  redis.pipeline=async(commands:(string|number)[][])=>{
    if(commands[0]?.[0]==="SMEMBERS" && commands[0][1]===`nl:wl:${w.store.statsId}:soon`){
      reads++;
      if(mode==="throw") throw new Error("synthetic pre-sale read outage");
      if(mode==="null") return [null,[]];
      if(mode==="short") return [];
    }
    return pipeline(commands);
  };
  const form=withConsent(new URLSearchParams({handle:w.store.handle,id:w.product}));
  const request=new NextRequest("https://marktmorgen.test/api/store/cart",{method:"POST",headers:{host:"marktmorgen.test",origin:"https://marktmorgen.test","content-type":"application/x-www-form-urlencoded"},body:form.toString()});
  const response=await payCart(request as NextRequest);
  const result={status:response.status,location:response.headers.get("location"),reads,checkouts:sent.length,cart:sent[0]?.get("metadata[cart]"),preorder:sent[0]?.get("metadata[preorder]")};
  console.log("cart observation",mode,JSON.stringify(result));
  redis.pipeline=pipeline;
  return result;
}

async function single(mode: "empty"|"coming"|"throw"|"null"|"short") {
  redis.clear();redis.pipeline=pipeline;sent.length=0;
  const w=await shop(`c2single${mode}`);
  if(mode!=="empty") await setSoon(w.store,w.product,true);
  let reads=0;
  redis.pipeline=async(commands:(string|number)[][])=>{
    if(commands[0]?.[0]==="SISMEMBER"&&commands[0][1]===`nl:wl:${w.store.statsId}:soon`){
      reads++;
      if(mode==="throw") throw new Error("synthetic single pre-sale outage");
      if(mode==="null") return [null,null];
      if(mode==="short") return [];
    }
    return pipeline(commands);
  };
  const form=withConsent(new URLSearchParams({handle:w.store.handle,product:w.product}));
  const response=await paySingle(new NextRequest("https://marktmorgen.test/api/store/checkout",{method:"POST",headers:{host:"marktmorgen.test",origin:"https://marktmorgen.test","content-type":"application/x-www-form-urlencoded"},body:form.toString()}));
  const result={status:response.status,location:response.headers.get("location"),reads,checkouts:sent.length,preorder:sent[0]?.get("metadata[preorder]")};
  console.log("single observation",mode,JSON.stringify(result));
  redis.pipeline=pipeline;
  return result;
}

async function paypal(mode: "empty"|"coming"|"throw"|"null"|"short") {
  redis.clear();redis.pipeline=pipeline;paypalOrders=0;
  const w=await shop(`c2paypal${mode}`);
  if(mode!=="empty") await setSoon(w.store,w.product,true);
  let reads=0;
  redis.pipeline=async(commands:(string|number)[][])=>{
    if(commands[0]?.[0]==="SISMEMBER"&&commands[0][1]===`nl:wl:${w.store.statsId}:soon`){
      reads++;
      if(mode==="throw") throw new Error("synthetic PayPal pre-sale outage");
      if(mode==="null") return [null];
      if(mode==="short") return [];
    }
    return pipeline(commands);
  };
  const form=withConsent(new URLSearchParams({handle:w.store.handle,product:w.product}));
  const response=await payPayPal(new NextRequest("https://marktmorgen.test/api/store/paypal/checkout",{method:"POST",headers:{host:"marktmorgen.test",origin:"https://marktmorgen.test","content-type":"application/x-www-form-urlencoded"},body:form.toString()}));
  const result={status:response.status,location:response.headers.get("location"),reads,orders:paypalOrders};
  console.log("PayPal observation",mode,JSON.stringify(result));
  redis.pipeline=pipeline;
  return result;
}

type Work={store:Store;product:string;course:string;lesson:string;cookie:string;path:string};
async function work(handle:string):Promise<Work>{
  redis.clear();redis.pipeline=pipeline;files.clear();deleted.length=0;files.has=originalHas;
  const w=await shop(handle,false);
  let course=emptyCourse();
  const added=editCourse(course,{op:"lesson-add",moduleId:course.modules[0].id,title:"Opening"});
  if(!added.ok) throw new Error("fixture lesson");
  course=added.course;
  const lesson=course.modules[0].lessons[0].id;
  const tasked=editCourse(course,{op:"task",lessonId:lesson,task:{review:true,gate:false,file:true}});
  if(!tasked.ok) throw new Error("fixture task");
  course=tasked.course;
  const attached=await setProductCourse(w.owner,w.product,{id:course.id,lessons:1});
  if(!attached.ok) throw new Error(`fixture attach course: ${JSON.stringify(attached)}`);
  const store=(await storeForEmail(w.owner))!;
  await saveCourse(course,store);
  await saveTask(course.id,lesson,{prompt:"Write one paragraph",review:true,gate:false,file:true},store);
  const buyer="student@example.test";
  await recordEnrollment(store,buyer,w.product,Math.floor(Date.now()/1000)-60);
  const pass=await mintPass(store,buyer,"all");
  const path=`${taskFolder(await storeFolder(storeRef(store)),course.id,lesson,emailKey(buyer))}${"a".repeat(32)}.jpg`;
  await noteTaskUpload(path);files.add(path);
  return{store,product:w.product,course:course.id,lesson,cookie:`${passCookieName(store)}=${pass}`,path};
}
async function submit(w:Work){
  const request=new Request("https://marktmorgen.test/api/store/course/task",{method:"POST",headers:{host:"marktmorgen.test",origin:"https://marktmorgen.test","content-type":"application/json",cookie:w.cookie},body:JSON.stringify({handle:w.store.handle,product:w.product,lesson:w.lesson,text:"My work",file:{path:w.path,name:"work.jpg"}})});
  answering(request);
  const response=await submitTask(request as NextRequest);
  return{status:response.status,body:await response.json() as {ok:boolean;error?:string}};
}

async function main(){
  part("Cart: a known coming-soon product versus unknown pre-sale evidence");
  const empty=await cart("empty");
  is("control: confirmed empty pre-sale set creates one ordinary checkout",[empty.checkouts,empty.cart],[1,"yes"]);
  const coming=await cart("coming");
  is("control: confirmed coming-soon product is refused before checkout",[coming.checkouts,coming.location?.includes("cart=changed")],[0,true]);
  for(const mode of ["throw","null","short"] as const){
    const result=await cart(mode);
    is(`${mode}: unknown pre-sale read must not create an ordinary checkout`,[result.reads,result.checkouts],[1,0]);
  }
  part("Rule 30 sibling: ordinary single-product checkout");
  const singleEmpty=await single("empty");
  is("control: known non-pre-sale single product opens one checkout",singleEmpty.checkouts,1);
  const singleComing=await single("coming");
  is("control: known coming-soon single product opens none",[singleComing.checkouts,singleComing.location?.includes("#waitlist")],[0,true]);
  for(const mode of ["throw","null","short"] as const){
    const result=await single(mode);
    is(`single ${mode}: unknown pre-sale read must not create an ordinary checkout`,[result.reads,result.checkouts],[1,0]);
  }
  part("Rule 30 sibling: PayPal checkout");
  const paypalEmpty=await paypal("empty");
  is("control: known non-pre-sale product opens one PayPal order",[paypalEmpty.status,paypalEmpty.orders],[303,1]);
  const paypalComing=await paypal("coming");
  is("control: known coming-soon product opens no PayPal order",[paypalComing.orders,paypalComing.location?.includes("#waitlist")],[0,true]);
  for(const mode of ["throw","null","short"] as const){
    const result=await paypal(mode);
    is(`PayPal ${mode}: unknown pre-sale read must not open an order`,[result.status,result.reads,result.orders],[503,1,0]);
  }
  part("Assignment: file-store outage must not consume the only upload receipt");
  const healthy=await work("c2taskcontrol");
  const accepted=await submit(healthy);
  is("control: enrolled student submits the uploaded file",[accepted.status,accepted.body.ok,(await submissionOf(healthy.course,healthy.lesson,emailKey("student@example.test")))?.file?.path],[200,true,healthy.path]);
  const w=await work("c2taskoutage");
  const [markedBefore]=await pipeline([["ZSCORE","nl:tasks:doors",w.path]]);
  let heads=0;
  files.has=(path:string)=>{if(path===w.path){heads++;throw new Error("synthetic provider HEAD outage");}return originalHas(path);};
  const first=await submit(w);
  files.has=originalHas;
  const [markedAfter]=await pipeline([["ZSCORE","nl:tasks:doors",w.path]]);
  const after=await submit(w);
  const persisted=await submissionOf(w.course,w.lesson,emailKey("student@example.test"));
  console.log("task observation",JSON.stringify({first,after,heads,markedBefore,markedAfter,filePresent:originalHas(w.path),deleted:deleted.includes(w.path),persisted}));
  is("unknown HEAD must be reported as transient, never confirmed missing",[heads,first.status>=500&&first.body.error!=="missing"],[1,true]);
  is("same file must remain retryable after the provider recovers",[after.status,after.body.ok],[200,true]);
  is("recovered hand-in must keep its file on the submission",persisted?.file?.path,w.path);
  is("control: upload door was present before the failed HEAD",markedBefore!==null,true);
  is("failed HEAD must not discard the upload's existing door",markedAfter!==null,true);
  is("control: provider outage did not delete or lose the stored file",[originalHas(w.path),deleted.includes(w.path)],[true,false]);
  const old=await work("c2tasksweepcontrol");
  const expired=Date.now()+(DOOR_SECONDS+60)*1000;
  is("control: cleanup finds an unused upload with its known door",(await staleTaskUploads(expired)).includes(old.path),true);
  const orphan=await work("c2tasksweepoutage");
  files.has=(path:string)=>{if(path===orphan.path)throw new Error("synthetic provider HEAD outage");return originalHas(path);};
  await submit(orphan);files.has=originalHas;
  const swept=await staleTaskUploads(Date.now()+(DOOR_SECONDS+60)*1000);
  console.log("sweep observation",JSON.stringify({swept,filePresent:originalHas(orphan.path)}));
  is("unused stored file must remain discoverable by its cleanup sweep after HEAD outage",swept.includes(orphan.path),true);
}
void main().then(()=>{redis.pipeline=pipeline;files.has=originalHas;globalThis.fetch=originalFetch;answering(null);done();}).catch(error=>{console.error(error);process.exitCode=2;});
