/** Unapproved cost baseline: real page and domain readers, synthetic transport.
 * Do not open a PR while the actual cost exceeds the existing modeled ceiling.
 * A calls/waiting case is a lower bound, never a complete page/financing approval.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import OrdersPage, { generateMetadata } from "@/app/[handle]/orders/page";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { readSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { createAgreement, saveAgreement } from "@/lib/agreement-store";
import { readDraft as readAgreementDraft } from "@/lib/agreement-rules";
import { createRequest, changeRequest } from "@/lib/payment-request-store";
import { readDraft as readRequestDraft } from "@/lib/payment-request-rules";
import { COMMANDS, COMMAND } from "./traffic-cost";

const OWNER = "buyer-page-cost@example.test", BUYER = "buyer@example.test", ACCOUNT = "acct_1TestLoom00001";
async function world(pending = false) {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_tax_journey_only";
  process.env.RESEND_API_KEY = "re_SYNTHETIC_ACCESS_ONLY";
  await claimHandle(OWNER, "buyer-page-cost", "Buyer page cost baseline", "");
  await ensureStatsId(OWNER); await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_BuyerCostOwner01", subscriptionId: "sub_BuyerCostOwner01", active: true, tier: pending ? "scale" : "creator", period: paidPeriod() });
  const added = await addProduct(OWNER, "Coaching cost baseline", "", "45", null); assert.ok(added.ok);
  const setup = readSetup({ kind: "weekly", minutes: 30, tz: "UTC", weekly: [[], [[540,1020]], [[540,1020]], [[540,1020]], [[540,1020]], [[540,1020]], []],
    noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "", video: true, meet: null, seats: 1, sessions: [] });
  assert.ok(setup && typeof setup === "object"); await setProductCall(OWNER, added.product.id, setup);
  const store = (await storeForEmail(OWNER))!; assert.ok(store.callsId);
  const requestIds: string[] = [], agreementIds: string[] = [];
  if (pending) {
    const requestDraft = readRequestDraft({ email: BUYER, name: "Synthetic Buyer", consent: true, lines: [{ text: "A private session", quantity: 1, amount: "10" }], note: "", dueDate: "", autoReminders: 0 }, "usd");
    assert.ok(requestDraft.ok);
    for (let i=0;i<24;i++) {
      const created = await createRequest(store, requestDraft.draft); assert.ok(created.ok);
      const saved = await changeRequest(store, created.request.id, current => ({ next: { ...current, sent: [Date.now()] }, answer: true }));
      assert.ok(saved?.answer); requestIds.push(created.request.id);
    }
    for (let i=0;i<20;i++) {
      const draft = readAgreementDraft({ kind: "agreement", email: BUYER, name: "Synthetic Buyer", title: `Cost agreement ${i}`, body: "One private coaching session under the agreed synthetic terms.", lines: [{ text: "A private session", quantity: 1, amount: "10" }], consent: true }, "usd");
      assert.ok(draft.ok); const created = await createAgreement(store, draft.draft); assert.ok(created.ok);
      await saveAgreement({ ...created.agreement, sent: [Date.now()] }); agreementIds.push(created.agreement.id);
    }
    // Sent-state fixtures only: no email or real provider delivery is claimed.
  }
  const sessions = Array.from({ length: 500 }, (_, i) => {
    const start = Date.now() + 86_400_000 + i*3_600_000;
    return { object: "checkout.session", id: `cs_test_CostCall${String(i).padStart(12,"0")}`, mode: "payment", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now()/1000), amount_total: 4500, currency: "usd",
      customer_details: { email: i<40 ? BUYER : `other${i}@example.test` },
      payment_intent: { id: `pi_CostCall${i}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
      metadata: { store: store.handle, kind: "call", product: added.product.id, title: "Coaching cost baseline", start: String(start), end: String(start+1_800_000), tz: "UTC" } };
  });
  const provider: { calls: number; callPages: number; returned: number; responseBytes: number } = { calls: 0, callPages: 0, returned: 0, responseBytes: 0 };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "api.stripe.com");
    assert.equal(init?.method, "GET"); assert.equal(new Headers(init.headers).get("Stripe-Account"), ACCOUNT);
    assert.equal(url.pathname, "/v1/checkout/sessions", "empty purchases require no customer/intent/refund follow-up in this partial case");
    provider.calls++;
    let body: unknown;
    if (url.searchParams.has("created[gte]")) {
      assert.equal(url.searchParams.get("limit"), "100");
      const after = url.searchParams.get("starting_after"), from = after ? sessions.findIndex(s => s.id===after)+1 : 0;
      assert.ok(from>=0 && from<500); const data=sessions.slice(from,from+100);
      provider.callPages++; provider.returned+=data.length;
      body={ object:"list", data, has_more:from+100<500 };
    } else { assert.equal(url.searchParams.get("customer_details[email]"), BUYER); body={ object:"list",data:[],has_more:false }; }
    const json=JSON.stringify(body); provider.responseBytes+=Buffer.byteLength(json); return new Response(json,{headers:{"Content-Type":"application/json"}});
  };
  const link=await ordersLinkFor(store,BUYER,`https://example.test/@${store.handle}`); assert.ok(link);
  const params={params:Promise.resolve({handle:"@"+store.handle}),searchParams:Promise.resolve({token:new URL(link).searchParams.get("token")!})};
  const visit=async()=>{await generateMetadata(params);return renderToStaticMarkup(await OrdersPage(params));};
  return { provider,visit,sessions,requestIds,agreementIds };
}
for(const pending of [false,true]) for(const warm of [false,true]) test(`real buyer page cost baseline (${pending?"full waiting":"calls only"}): ${warm?"existing":"new"} rooms`,async()=>{
  const w=await world(pending); if(warm)await w.visit();
  Object.assign(w.provider,{calls:0,callPages:0,returned:0,responseBytes:0});
  const actual=redis.pipeline.bind(redis),commands:(string|number)[][]=[];let requestBytes=0,responseBytes=0;
  redis.pipeline=async list=>{commands.push(...list);requestBytes+=Buffer.byteLength(JSON.stringify(list));const replies=await actual(list);responseBytes+=Buffer.byteLength(JSON.stringify(replies));return replies;};
  let html:string;
  try{html=await w.visit();}finally{redis.pipeline=actual;}
  assert.equal(w.provider.callPages,5);assert.equal(w.provider.returned,500);assert.equal(w.provider.calls,6);
  assert.equal(html.split("Coaching cost baseline").length-1,40,"the actual page renders forty of the buyer's calls");
  for(const s of w.sessions.slice(0,40))assert.ok(html.includes(s.id));
  for(const s of w.sessions.slice(40))assert.equal(html.includes(s.id),false,"other buyers' session IDs stay out of the rendered copy");
  const moves=commands.filter(c=>c[0]==="GET" && String(c[1]).startsWith("nl:call:moved:")).length;
  const roomReads=commands.filter(c=>c[0]==="GET" && (String(c[1]).startsWith("nl:call:room:")||String(c[1]).startsWith("nl:meet:r:"))).length;
  const roomWrites=commands.filter(c=>c[0]==="SET" && String(c[1]).startsWith("nl:call:room:")).length;
  assert.equal(moves,500);assert.equal(roomReads,warm?160:200);assert.equal(roomWrites,warm?0:40);
  const waitingCommands=commands.filter(c=>["SMEMBERS","MGET","GET"].includes(String(c[0])) && (String(c[1]).startsWith("nl:payreq:")||String(c[1]).startsWith("nl:agree:"))).length;
  assert.equal(waitingCommands,pending?14:2,"full waiting reaches two person sets, two MGETs and ten version GETs");
  if(pending) {
    assert.equal(w.requestIds.filter(id=>html.includes(id)).length,10);
    assert.equal(w.agreementIds.filter(id=>html.includes(id)).length,10);
  }
  const modeled=COMMANDS.laterPage+COMMANDS.laterCount;
  const profile={source:"actual OrdersPage+generateMetadata+render",scenario:warm?"existing-rooms":"new-rooms",pending,waitingCommands,redisCommands:commands.length,moves,roomReads,roomWrites,
    logicalRedisRequestBytes:requestBytes,logicalRedisResponseBytes:responseBytes,htmlBytes:Buffer.byteLength(html),provider:w.provider,
    modeledCommands:modeled,redisCommandCostOnly:commands.length*COMMAND,financialApproval:false,completeWorstCase:false};
  console.log(JSON.stringify(profile));
  assert.ok(commands.length<=modeled,`actual buyer page ${commands.length} exceeds modeled ${modeled}; preserve MR ceiling and finish whole-page costing`);
});
