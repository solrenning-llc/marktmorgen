/** Every value here is synthetic input, not an admitted source or principal. */
import type {UnverifiedCoursePaidReference} from "@/lib/course-paid-observation";
export function paidObservationWorld(){
 const reference:UnverifiedCoursePaidReference={kind:"unverified-new-course-paid-reference",provenance:"unverified-producer-input",admitted:false,
  storeId:"a".repeat(32),statsId:"b".repeat(32),accountId:"acct_TestCourse01",productId:"a1b2c3d4e5",courseId:"c".repeat(32),buyerEmail:"buyer@example.test",
  sessionId:"cs_test_ObserveSource00001",paymentIntentId:"pi_ObservePayment0001",chargeId:"ch_ObserveCharge0001",currency:"usd",subtotalCents:4900,totalCents:5000,createdSeconds:1793293200,
  nonce:"d".repeat(64),bodyDigest:"e".repeat(64),metadata:{store:"original-school",product:"a1b2c3d4e5",dc:"synthetic-original-consent-not-a-proof",mm_order_origin:"course-v1",mm_order_intent:"d".repeat(64),mm_order_hash:"e".repeat(64)}};
 const bodies=[{object:"checkout.session",id:reference.sessionId,mode:"payment",status:"complete",payment_status:"paid",created:reference.createdSeconds,
  payment_intent:reference.paymentIntentId,amount_subtotal:4900,amount_total:5000,currency:"usd",customer_details:{email:reference.buyerEmail},metadata:{...reference.metadata},line_items:{has_more:false,data:[{quantity:1,price:{unit_amount:4900,currency:"usd"}}]}},
 {object:"payment_intent",id:reference.paymentIntentId,latest_charge:reference.chargeId,currency:"usd",amount:5000,amount_received:5000,status:"succeeded"},
 {object:"charge",id:reference.chargeId,payment_intent:reference.paymentIntentId,currency:"usd",amount:5000,amount_captured:5000,status:"succeeded",paid:true,captured:true,disputed:false,refunded:false,amount_refunded:0}];
 const paths=[`/checkout/sessions/${reference.sessionId}?expand[]=line_items`,`/payment_intents/${reference.paymentIntentId}`,`/charges/${reference.chargeId}`];
 const trace={startedUtcMs:1793556000000,finishedUtcMs:1793556000200,expiresUtcMs:1793556030000,startedMonotonicMs:10,finishedMonotonicMs:210,expiresMonotonicMs:30010,
  reads:paths.map((path,i)=>({method:"GET",accountId:reference.accountId,path,status:200,body:bodies[i]}))};
 return {reference,bodies,trace};
}

/** Harness-only capacity, NOT an authentic reservation or provider permission.
 * Every test request is to a fixed loopback server; no real credential exists.
 */
export async function collectLoopbackObservation(base:string,plan:{reads:readonly {method:"GET";accountId:string;path:string}[]},capacity:number){
 if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error("Synthetic loopback required");
 const events:string[]=[],reads:{method:string;accountId:string;path:string;status:number;body:unknown}[]=[];
 for(const [i,step]of plan.reads.entries()){
  events.push(`test-capacity-${i}`);if(capacity<=0)return {events,reads,capacityDenied:true};capacity--;
  events.push(`get-${i}`);const response=await fetch(base+step.path,{method:step.method,headers:{"x-synthetic-account":step.accountId},signal:AbortSignal.timeout(2000)});
  reads.push({...step,status:response.status,body:await response.json()});
 }
 return {events,reads,capacityDenied:false};
}
