/** Unapproved cost baseline: real page and domain readers, synthetic transport.
 * Do not open a PR while the actual cost exceeds the existing modeled ceiling.
 * A calls/waiting case is a lower bound, never a complete page/financing approval.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import OrdersPage, { generateMetadata } from "@/app/[handle]/orders/page";
import { addDraftProducts, addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductBundle, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { readSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { createAgreement, saveAgreement } from "@/lib/agreement-store";
import { readDraft as readAgreementDraft } from "@/lib/agreement-rules";
import { createRequest, changeRequest } from "@/lib/payment-request-store";
import { readDraft as readRequestDraft } from "@/lib/payment-request-rules";
import { COMMANDS, COMMAND } from "./traffic-cost";
import { BUMP_KEYS, MAX_BUNDLE_ITEMS, bundleMeta } from "@/lib/bundle-rules";

const OWNER = "buyer-page-cost@example.test", BUYER = "buyer@example.test", ACCOUNT = "acct_1TestLoom00001";
async function world(pending = false, purchases = false, installments = false, bundles = false) {
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
  const digitalTitles = Array.from({ length: purchases ? (bundles ? 1999 : 600) : 0 }, (_, i) => `${i<600?"Cost digital":"Bundle content"} ${String(i).padStart(6, "0")}`);
  let digitalIds: string[] = [];
  if (purchases) {
    const drafts = await addDraftProducts(OWNER, digitalTitles.map((title,i) => ({ title, summary: "Historical paid delivery", priceCents: 1000, link: bundles && i<600 ? null : "https://example.test/paid-digital" })));
    assert.ok(drafts.ok); digitalIds = drafts.ids; assert.equal(digitalIds.length, bundles?1999:600);
  }
  const contentsFor = (index: number) => Array.from({length:MAX_BUNDLE_ITEMS}, (_, i) => digitalIds[600+(index*MAX_BUNDLE_ITEMS+i)%(digitalIds.length-600)]);
  if(bundles) for(let i=0;i<600;i++) {
    const saved=await setProductBundle(OWNER,digitalIds[i],contentsFor(i)); assert.ok(saved.ok);
  }
  const store = (await storeForEmail(OWNER))!; assert.ok(store.callsId);
  if(bundles)assert.equal(store.catalog.items.length,2000,"the actual public catalogue ceiling, including the call product");
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
  const customers = Array.from({ length: 10 }, (_, i) => `cus_BuyerCost${String(i).padStart(8, "0")}`);
  const purchasedAt = Math.floor(Date.now()/1000) - (bundles?1600:600);
  const bought = digitalIds.slice(0,100).map((product, i) => ({
    object: "checkout.session", id: `cs_test_CostPurchase${String(i).padStart(12,"0")}`, mode: installments ? "subscription" : "payment", status: "complete", payment_status: "paid",
    invoice: installments ? `in_CostInvoice${String(i).padStart(12,"0")}` : null,
    created: purchasedAt + (bundles?1000:0) + i, amount_total: bundles?4000:1000, currency: "usd", customer: customers[i%10], customer_details: { email: BUYER },
    payment_intent: installments ? null : { id: `pi_CostPurchase${i}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
    metadata: { store: store.handle, product, ...(installments ? { kind: "plan" } : {}),
      ...(bundles ? { ...bundleMeta("bundle",contentsFor(i)), ...Object.fromEntries(BUMP_KEYS.flatMap((key,j)=>{ const index=(i+j+1)%600; return [[key,digitalIds[index]],...Object.entries(bundleMeta(`${key}_bundle`,contentsFor(index)))]; })) } : {}) },
  }));
  const upsells = digitalIds.slice(100,600).map((product, i) => ({
    object: "payment_intent", id: `pi_CostUpsell${String(i).padStart(12,"0")}`, status: "succeeded", amount: 1000, currency: "usd",
    created: purchasedAt + 100 + i, customer: customers[Math.floor(i/50)], latest_charge: { refunded: false, amount_refunded: 0 },
    metadata: { kind: "upsell", store: store.handle, product, ...(bundles ? bundleMeta("bundle",contentsFor(100+i)) : {}) },
  }));
  assert.ok([...bought,...upsells].every(payment=>payment.created<=Math.floor(Date.now()/1000)),"all historical paid fixture timestamps are in the past");
  const provider = { calls: 0, callPages: 0, returned: 0, purchaseRows: 0, intentPages: 0, intentRows: 0, invoiceGets: 0, invoicePaymentPages: 0, refundIntentGets: 0, responseBytes: 0 };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "api.stripe.com");
    assert.equal(init?.method, "GET"); assert.equal(new Headers(init.headers).get("Stripe-Account"), ACCOUNT);
    provider.calls++;
    let body: unknown;
    if (/^\/v1\/invoices\/in_CostInvoice[0-9]{12}$/.test(url.pathname)) {
      assert.ok(installments); provider.invoiceGets++;
      body = { object: "invoice", id: url.pathname.split("/").at(-1), payment_intent: null };
    } else if (url.pathname === "/v1/invoice_payments") {
      assert.ok(installments); assert.equal(url.searchParams.get("limit"), "10");
      const invoice=url.searchParams.get("invoice"); assert.ok(invoice && /^in_CostInvoice[0-9]{12}$/.test(invoice));
      const index=Number(invoice.slice(-12)); assert.ok(index>=0 && index<100); provider.invoicePaymentPages++;
      body={ object: "list", has_more: false, data: Array.from({length:10}, (_,i)=>({ status: "paid", payment:{ type: "payment_intent", payment_intent: `pi_CostInvoicePayment${String(index*10+i).padStart(12,"0")}` } })) };
    } else if (/^\/v1\/payment_intents\/pi_CostInvoicePayment[0-9]{12}$/.test(url.pathname)) {
      assert.ok(installments); assert.deepEqual(url.searchParams.getAll("expand[]"), ["latest_charge"]); provider.refundIntentGets++;
      body={ object: "payment_intent", id: url.pathname.split("/").at(-1), status: "succeeded", latest_charge: { object: "charge", amount: 1000, amount_refunded: 1, refunded: false } };
    } else if (url.pathname === "/v1/payment_intents") {
      assert.ok(purchases, "empty purchase cases have no intent follow-up");
      assert.equal(url.searchParams.get("limit"), "50");
      const customer = url.searchParams.get("customer"); assert.ok(customer && customers.includes(customer));
      const data = upsells.filter(intent => intent.customer === customer); assert.equal(data.length, 50);
      provider.intentPages++; provider.intentRows += data.length;
      body = { object: "list", data, has_more: false };
    } else if (url.pathname === "/v1/checkout/sessions" && url.searchParams.has("created[gte]")) {
      assert.equal(url.searchParams.get("limit"), "100");
      const after = url.searchParams.get("starting_after"), from = after ? sessions.findIndex(s => s.id===after)+1 : 0;
      assert.ok(from>=0 && from<500); const data=sessions.slice(from,from+100);
      provider.callPages++; provider.returned+=data.length;
      body={ object:"list", data, has_more:from+100<500 };
    } else {
      assert.equal(url.pathname, "/v1/checkout/sessions"); assert.equal(url.searchParams.get("customer_details[email]"), BUYER);
      assert.equal(url.searchParams.get("limit"), "100"); provider.purchaseRows += bought.length;
      body={ object:"list",data:bought,has_more:false };
    }
    const json=JSON.stringify(body); provider.responseBytes+=Buffer.byteLength(json); return new Response(json,{headers:{"Content-Type":"application/json"}});
  };
  const link=await ordersLinkFor(store,BUYER,`https://example.test/@${store.handle}`); assert.ok(link);
  const params={params:Promise.resolve({handle:"@"+store.handle}),searchParams:Promise.resolve({token:new URL(link).searchParams.get("token")!})};
  const visit=async()=>{await generateMetadata(params);return renderToStaticMarkup(await OrdersPage(params));};
  return { provider,visit,sessions,requestIds,agreementIds,digitalTitles: digitalTitles.slice(0,600) };
}
for(const scenario of ["calls", "waiting", "purchases", "installments", "bundles"] as const) for(const warm of [false,true]) test(`real buyer page cost baseline (${scenario}): ${warm?"existing":"new"} rooms`,async()=>{
  const pending=scenario!=="calls", purchases=scenario!=="calls" && scenario!=="waiting", installments=scenario==="installments", bundles=scenario==="bundles";
  const w=await world(pending,purchases,installments,bundles); if(warm)await w.visit();
  Object.assign(w.provider,{calls:0,callPages:0,returned:0,purchaseRows:0,intentPages:0,intentRows:0,invoiceGets:0,invoicePaymentPages:0,refundIntentGets:0,responseBytes:0});
  const actual=redis.pipeline.bind(redis),commands:(string|number)[][]=[];let requestBytes=0,responseBytes=0;
  redis.pipeline=async list=>{commands.push(...list);requestBytes+=Buffer.byteLength(JSON.stringify(list));const replies=await actual(list);responseBytes+=Buffer.byteLength(JSON.stringify(replies));return replies;};
  let html:string;
  try{html=await w.visit();}finally{redis.pipeline=actual;}
  assert.equal(w.provider.callPages,5);assert.equal(w.provider.returned,500);assert.equal(w.provider.calls,installments?1216:purchases?16:6);
  assert.equal(w.provider.invoiceGets,installments?100:0); assert.equal(w.provider.invoicePaymentPages,installments?100:0); assert.equal(w.provider.refundIntentGets,installments?1000:0);
  assert.equal(w.provider.purchaseRows,purchases?100:0); assert.equal(w.provider.intentPages,purchases?10:0); assert.equal(w.provider.intentRows,purchases?500:0);
  if(purchases) {
    const topTitles=[...html.matchAll(/<li class="rounded-2xl p-5"[^>]*><p class="font-semibold">([^<]+)<\/p>/g)].map(m=>m[1]).filter(title=>title.startsWith("Cost digital "));
    const expected=w.digitalTitles.slice(bundles?60:560,bundles?100:600).reverse();
    assert.deepEqual(topTitles,expected,"only the newest forty primary paid records render, preserving their order even with nested bundle/addition titles");
    if(bundles)assert.equal(html.split('href="https://example.test/paid-digital"').length-1,40*(1+BUMP_KEYS.length)*MAX_BUNDLE_ITEMS,"all twenty deliveries in the main bundle and each of three added bundles remain available");
  }
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
  const catalogReads=commands.filter(c=>c[0]==="GET" && /^nl:catalog:[^:]+:l:/.test(String(c[1]))).length;
  if(purchases)assert.ok(catalogReads>=(bundles?1999:600),"all distinct historical paid products actually reach the catalogue reader");
  const modeled=COMMANDS.laterPage+COMMANDS.laterCount;
  const profile={source:"actual OrdersPage+generateMetadata+render",scenario:warm?"existing-rooms":"new-rooms",pending,purchases,installments,bundles,catalogReads,waitingCommands,redisCommands:commands.length,moves,roomReads,roomWrites,
    logicalRedisRequestBytes:requestBytes,logicalRedisResponseBytes:responseBytes,htmlBytes:Buffer.byteLength(html),provider:w.provider,
    modeledCommands:modeled,redisCommandCostOnly:commands.length*COMMAND,financialApproval:false,completeWorstCase:false};
  console.log(JSON.stringify(profile));
  assert.ok(commands.length<=modeled,`actual buyer page ${commands.length} exceeds modeled ${modeled}; preserve MR ceiling and finish whole-page costing`);
});
