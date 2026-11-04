import assert from "node:assert/strict";
import {test} from "node:test";
import {createServer} from "node:http";
import {captureUnverifiedCoursePaidReference,planUnverifiedCoursePaidReads,observeUnverifiedCoursePaidReplies,observeCurrentCoursePaidSource} from "@/lib/course-paid-observation";
import {paidObservationWorld,collectLoopbackObservation} from "./course-paid-observation-world";
const unknown=(value:unknown,ref=paidObservationWorld().reference)=>assert.equal(observeUnverifiedCoursePaidReplies(ref,value).outcome,"unknown");
test("the real entry is unavailable before inspecting arguments, clocks, auth, provider or budgets",()=>{
 let calls=0;const trap=new Proxy({}, {get(){calls++;throw Error("No access");},ownKeys(){calls++;throw Error("No inspection");}});
 const clock=Date.now;Date.now=()=>{calls++;throw Error("No clock");};try{assert.deepEqual(observeCurrentCoursePaidSource(trap,trap),{authority:"none",admitted:false,grantsAccess:false,outcome:"unavailable",accessReview:null,fundingReview:null});assert.equal(calls,0);}finally{Date.now=clock;}
});
test("a plain new-source reference and its exact plan remain unverified and non-authorizing",()=>{
 const f=paidObservationWorld(),r=captureUnverifiedCoursePaidReference(f.reference);assert.ok(r);assert.equal(r.admitted,false);
 const p=planUnverifiedCoursePaidReads(r);assert.ok(p);assert.equal(p.reads.length,3);assert.ok(p.reads.every(x=>x.method==="GET"&&x.accountId===r.accountId&&!/list|search/.test(x.path)));assert.equal(p.authority,"unverified");assert.equal(p.grantsAccess,false);
 assert.equal(captureUnverifiedCoursePaidReference({...f.reference,admitted:true}),null);assert.equal(captureUnverifiedCoursePaidReference({...f.reference,authored:true}),null);
});
test("paid, unpaid, full/partial refunds and disputes are observations only, never lesson access",()=>{
 for(const [name,patch]of Object.entries({paid:{},fully_refunded:{refunded:true,amount_refunded:5000},partially_refunded:{amount_refunded:1000},disputed:{disputed:true}})){
  const f=paidObservationWorld();Object.assign(f.bodies[2],patch);const r=observeUnverifiedCoursePaidReplies(f.reference,f.trace);assert.equal(r.outcome,name);assert.equal(r.authority,"unverified");assert.equal(r.admitted,false);assert.equal(r.grantsAccess,false);
 }
 const f=paidObservationWorld();Object.assign(f.bodies[0],{status:"open",payment_status:"unpaid"});assert.equal(observeUnverifiedCoursePaidReplies(f.reference,f.trace).outcome,"not_paid");
});
test("wrong buyer, metadata, identity, currency, totals, account and linked payment never produce a paid observation",()=>{
 const patches:[number,string,unknown][]=[[0,"id","cs_test_otherOriginal00001"],[0,"customer_details",{email:"stranger@example.test"}],[0,"customer_email","stranger@example.test"],[0,"metadata",{}],[0,"amount_total",1],[0,"currency","eur"],[0,"payment_intent","pi_otherPayment0001"],[1,"latest_charge","ch_otherCharge0001"],[1,"amount_received",1],[1,"status","processing"],[2,"payment_intent","pi_otherPayment0001"],[2,"captured",false],[2,"amount_refunded",5001],[2,"refunded",true]];
 for(const [i,key,value]of patches){const f=paidObservationWorld();Object.assign(f.bodies[i],{[key]:value});unknown(f.trace,f.reference);}
 for(const key of ["accountId","path","method","status"]){const f=paidObservationWorld();Object.assign(f.trace.reads[0],{[key]:key==="status"?503:"foreign"});unknown(f.trace,f.reference);}
});
test("missing, expanded, truncated, duplicated, sparse and non-own evidence is unknown",()=>{
 for(const n of [0,1,2,4]){const f=paidObservationWorld();const reads=Array.from({length:n},(_,i)=>f.trace.reads[i%3]);unknown({...f.trace,reads},f.reference);}
 const f=paidObservationWorld();unknown({...f.trace,reads:[f.trace.reads[0],f.trace.reads[0],f.trace.reads[2]]},f.reference);
 const sparse=new Array(3);sparse[0]=f.trace.reads[0];unknown({...f.trace,reads:sparse},f.reference);
 Object.assign(f.bodies[0],{payment_intent:{id:f.reference.paymentIntentId}});unknown(f.trace,f.reference);
});
test("both supplied clocks must be consistent and within the bounded observation window",()=>{
 for(const patch of [{finishedUtcMs:1793556030000},{finishedUtcMs:1793555999999},{finishedMonotonicMs:30010},{finishedMonotonicMs:9},{expiresUtcMs:1793556030001},{expiresMonotonicMs:30011}]){const f=paidObservationWorld();unknown({...f.trace,...patch},f.reference);}
});
test("getters and own/inherited JSON/string hooks do not run, even in invalid response statuses",()=>{
 let hooks=0;const f=paidObservationWorld();const bad=Object.defineProperty({...f.reference},"buyerEmail",{get(){hooks++;return "buyer@example.test";}});assert.equal(captureUnverifiedCoursePaidReference(bad),null);
 const dangerous={toJSON(){hooks++;return "complete";},toString(){hooks++;return "complete";}};
 Object.assign(f.bodies[0],{status:dangerous,payment_status:"unpaid"});unknown(f.trace,f.reference);
 const poison=Object.defineProperty({},"id",{get(){hooks++;return "forged";},enumerable:true});unknown({...f.trace,reads:[{...f.trace.reads[0],body:poison},...f.trace.reads.slice(1)]},f.reference);assert.equal(hooks,0);
});
test("loopback harness collects exactly three GETs outside first100, after local test capacity steps; no real authorization is implied",async()=>{
 const f=paidObservationWorld(),plan=planUnverifiedCoursePaidReads(f.reference)!;const order:string[]=[],seen:string[]=[];
 const server=createServer((req,res)=>{const i=plan.reads.findIndex(p=>p.path===req.url);assert.ok(i>=0);assert.equal(req.method,"GET");assert.equal(req.headers["x-synthetic-account"],f.reference.accountId);seen.push(req.url!);res.setHeader("Content-Type","application/json");res.end(JSON.stringify(f.bodies[i]));});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");
 try{
  const base=`http://127.0.0.1:${address.port}`;
  const none=await collectLoopbackObservation(base,plan,0);assert.equal(none.capacityDenied,true);assert.equal(seen.length,0);unknown({...f.trace,reads:none.reads},f.reference);
  const partial=await collectLoopbackObservation(base,plan,1);assert.equal(partial.reads.length,1);assert.deepEqual(partial.events,["test-capacity-0","get-0","test-capacity-1"]);unknown({...f.trace,reads:partial.reads},f.reference);
  seen.length=0;const collected=await collectLoopbackObservation(base,plan,3);assert.equal(collected.capacityDenied,false);
  order.push(...collected.events);assert.deepEqual(order,["test-capacity-0","get-0","test-capacity-1","get-1","test-capacity-2","get-2"]);assert.deepEqual(seen,plan.reads.map(s=>s.path));const result=observeUnverifiedCoursePaidReplies(f.reference,{...f.trace,reads:collected.reads});assert.equal(result.outcome,"paid");assert.equal(result.grantsAccess,false);assert.equal(result.authority,"unverified");

 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("nullable Checkout customer_email preserves a matching customer_details payer, but contradictory strings do not",()=>{
 const f=paidObservationWorld();Object.assign(f.bodies[0],{customer_email:null});assert.equal(observeUnverifiedCoursePaidReplies(f.reference,f.trace).outcome,"paid");Object.assign(f.bodies[0],{customer_email:"wrong@example.test"});unknown(f.trace,f.reference);
});
test("an exact Session ID with a creation time later than the presented observation window is still unknown",()=>{
 const f=paidObservationWorld();const future=Math.floor(f.trace.startedUtcMs/1000)+3600;Object.assign(f.reference,{createdSeconds:future});Object.assign(f.bodies[0],{created:future});unknown(f.trace,f.reference);
});
