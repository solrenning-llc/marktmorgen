/** S independent second financial review: helpers adapted from C6 closing-plan-guard test; reply faults after healthy producer. */
/**
 * A plan paid for a store whose closing day has begun (queue item 307
 * [EC1], held to item 569 [NC1]), against a stand-in for our own Stripe
 * account and the email sender. Nothing real is reached.
 *
 * What fails here:
 *   - a plan finished during the closing day that is written down as the
 *     store's, or left running, or not refunded in full;
 *   - a retry of the way back, of the daily sync or of the closing job that
 *     refunds twice or tells the creator twice;
 *   - a refund that failed (an error, or one the bank turned down) that is
 *     not tried again, or that is dropped from the line;
 *   - a payment made before the day began that is refunded;
 *   - an open plan checkout of the store left open when the day starts, or
 *     another store's expired with it;
 *   - a store whose records are gone that is no longer recognized.
 */
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { UNDO_KEY, settleOne, markShut, refusePlanIfClosing } from "@/lib/closing-plan-guard";
import { redisPipeline } from "@/lib/redis";

const S = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;

type PlanSub = { id: string; status: string; customer: string; metadata: Record<string, string>; created: number };
type Invoice = { id: string; subscription: string; status: string; amount_paid: number; payment_intent: string; created: number; paid_at: number };
type Refund = { id: string; object: "refund"; charge: string; payment_intent: string; amount: number; status: string; currency: string; key: string };

const world = {
  subs: new Map<string, PlanSub>(),
  invoices: [] as Invoice[],
  charges: new Map<string, { amount: number; disputed: boolean }>(),
  refunds: [] as Refund[],
  sessions: [] as Record<string, unknown>[],
  customers: new Map<string, string>(),
  /** Refund requests answered with a server error. */
  refundErrors: 0,
  /** Refunds the bank turns down (status failed). */
  refundsTurnedDown: 0,
  /** What Stripe answered to each idempotency key, and when: Stripe replays it for 24 hours, then forgets it. */
  replies: new Map<string, { at: number; body: string }>(),
  /** The refunds list lags behind: it shows none (Stripe's lists are not always up to the moment). */
  listLags: false,
  expired: [] as string[],
};
const sent: { to: string; subject: string; text: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text?: string };
    sent.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text ?? "" });
    return json({ id: `email_${sent.length}` });
  }
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const headers = new Headers(init?.headers);
  if (headers.get("stripe-account")) return json({ error: { message: "only our own account here" } }, 400);
  const key = headers.get("idempotency-key");
  const kept = key && method === "POST" ? world.replies.get(key) : undefined;
  if (kept && Date.now() - kept.at < 24 * 3_600_000) return new Response(kept.body, { status: 200, headers: { "content-type": "application/json" } });
  const remember = (data: unknown) => {
    if (key && method === "POST") world.replies.set(key, { at: Date.now(), body: JSON.stringify(data) });
    return json(data);
  };
  const path = url.pathname.replace(/^\/v1/, "");
  const form = new URLSearchParams(String(init?.body ?? ""));

  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1]);
    if (!row) return json({ error: { message: "No such subscription" } }, 404);
    if (method === "DELETE") {
      if (row.status === "canceled") return json({ error: { code: "resource_missing", message: "already canceled" } }, 400);
      row.status = "canceled";
    }
    return json({ ...row, items: { data: [] } });
  }
  if (path === "/subscriptions" && method === "GET") {
    const data = [...world.subs.values()].map((row) => ({ ...row, customer: { id: row.customer, email: world.customers.get(row.customer) ?? "" }, items: { data: [] } }));
    return json({ object: "list", data, has_more: false });
  }
  if (path === "/subscriptions/search") return json({ object: "search_result", data: [], has_more: false, next_page: null });
  if (path === "/invoices" && method === "GET") {
    const data = world.invoices.filter((row) => row.subscription === url.searchParams.get("subscription")).map((row) => ({ ...row, status_transitions: { paid_at: row.paid_at || null } }));
    return json({ object: "list", data, has_more: false });
  }
  const voided = path.match(/^\/invoices\/(in_\w+)\/void$/);
  if (voided) {
    const row = world.invoices.find((invoice) => invoice.id === voided[1]);
    if (row) row.status = "void";
    return remember({ id: voided[1], status: "void" });
  }
  const intent = path.match(/^\/payment_intents\/(pi_\w+)$/);
  if (intent) {
    const charge = world.charges.get(intent[1]);
    if (!charge) return json({ error: { message: "No such payment_intent" } }, 404);
    // As Stripe keeps it: what refunds that have not failed took back.
    const refunded = world.refunds.filter((row) => row.payment_intent === intent[1] && (row.status === "succeeded" || row.status === "pending")).reduce((sum, row) => sum + row.amount, 0);
    return json({ id: intent[1], latest_charge: { id: `ch_${intent[1].slice(3)}`, currency: "usd", amount: charge.amount, amount_refunded: refunded, disputed: charge.disputed } });
  }
  if (path === "/refunds" && method === "GET") return json({ object: "list", data: world.listLags ? [] : world.refunds.filter((row) => row.charge === url.searchParams.get("charge")), has_more: false });
  if (path === "/refunds" && method === "POST") {
    if (world.refundErrors > 0) {
      world.refundErrors -= 1;
      return json({ error: { type: "api_error", message: "a stand-in failure" } }, 500);
    }
    const pi = String(form.get("payment_intent"));
    const status = world.refundsTurnedDown > 0 ? "failed" : "succeeded";
    if (status === "failed") world.refundsTurnedDown -= 1;
    const refund: Refund = { id: `re_${String(world.refunds.length + 1).padStart(8, "0")}`, object: "refund", charge: `ch_${pi.slice(3)}`, payment_intent: pi, amount: Number(form.get("amount")), status, currency: "usd", key: key ?? "" };
    world.refunds.push(refund);
    return remember(refund);
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) return json({ id: customer[1], email: world.customers.get(customer[1]) ?? null });
  if (path === "/checkout/sessions" && method === "GET") {
    const data = world.sessions.filter((row) => row.status === (url.searchParams.get("status") ?? row.status) && row.customer === url.searchParams.get("customer"));
    return json({ object: "list", data, has_more: false });
  }
  const session = path.match(/^\/checkout\/sessions\/(cs_\w+)(\/expire)?$/);
  if (session) {
    const row = world.sessions.find((one) => one.id === session[1]);
    if (!row) return json({ error: { message: "No such checkout session" } }, 404);
    if (session[2]) {
      if (row.status !== "open") return json({ error: { message: "Only Checkout Sessions with a status of open can be expired." } }, 400);
      row.status = "expired";
      world.expired.push(String(row.id));
      return remember(row);
    }
    return json(row);
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A store whose plan ended, in its closing day since `day`, with a plan checkout finished on that day and paid. */
async function closingStore(handle: string, day: number, amount = 6_900) {
  const email = `${handle}@example.com`;
  const customer = `cus_${handle}0001`;
  await claimHandle(email, handle, `${handle[0].toUpperCase()}${handle.slice(1)} Shop`, "");
  await setSubscription(email, { customerId: customer, subscriptionId: `sub_${handle}old001`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  world.customers.set(customer, email);
  await redisPipeline([["ZADD", FINAL_INDEX, day - 30 * DAY, storeRef((await storeForEmail(email))!)]]);
  await markShut((await storeForEmail(email))!, day);
  const id = `sub_${handle}late01`;
  world.subs.set(id, { id, status: "active", customer, metadata: { store: handle, tier: "creator" }, created: S(day) - 3_600 });
  const pi = `pi_${handle}late01`;
  world.invoices.push({ id: `in_${handle}late01`, subscription: id, status: "paid", amount_paid: amount, payment_intent: pi, created: S(day) - 3_600, paid_at: S(day) + 600 });
  world.charges.set(pi, { amount, disputed: false });
  world.sessions.push({ id: `cs_test_${handle}late0001`, status: "complete", mode: "subscription", customer, subscription: id, metadata: { store: handle } });
  return { email, id, pi, customer };
}

const refundsOf = (pi: string) => world.refunds.filter((row) => row.payment_intent === pi);
const undo = async (id: string) => {
  const [raw] = await redisPipeline([["HGET", UNDO_KEY, id]]);
  return typeof raw === "string" ? (JSON.parse(raw) as { n: number; done?: number; to: string }) : null;
};

async function main(){
 redis.clear();process.env.STRIPE_SECRET_KEY="sk_test_s3234_only_stand_in";process.env.RESEND_API_KEY="re_test_a_stand_in_key_for_tests_only";
 const day=Date.UTC(2026,11,2);
 const healthy=await closingStore("shealthy",day);
 is("healthy payment refunded once",[await refusePlanIfClosing({store:(await storeForEmail(healthy.email))!,handle:"shealthy",subscriptionId:healthy.id,customerId:healthy.customer}),refundsOf(healthy.pi).map(r=>r.amount)],["returned",[6900]]);
 const producer=globalThis.fetch;
 for(const [name,kind] of [["sstatus","invoice-status"],["snegative","refund-negative"],["sunknown","refund-status"]] as const){
  const one=await closingStore(name,day);let used=false;let actualPaid=false;const beforeLetters=sent.length;
  globalThis.fetch=(async(input,init)=>{
   const response=await producer(input,init);const url=new URL(String(input instanceof Request?input.url:input));
   if((init?.method??"GET")!=="GET")return response;
   if(kind==="invoice-status"&&url.pathname==="/v1/invoices"&&url.searchParams.get("subscription")===one.id){
    const body=await response.json();actualPaid=body.data[0]?.status==="paid"&&body.data[0]?.amount_paid===6900;body.data[0].status="transport_unknown";used=true;return Response.json(body);
   }
   if(kind!=="invoice-status"&&url.pathname==="/v1/refunds"&&url.searchParams.get("charge")===`ch_${one.pi.slice(3)}`){
    used=true;return Response.json({object:"list",data:[{id:`re_${name}row001`,status:kind==="refund-negative"?"succeeded":"transport_unknown",amount:kind==="refund-negative"?-6900:6900}],has_more:false});
   }
   return response;
  }) as typeof fetch;
  let result;try{result=await refusePlanIfClosing({store:(await storeForEmail(one.email))!,handle:name,subscriptionId:one.id,customerId:one.customer});}finally{globalThis.fetch=producer;}
  is(`${kind}: unknown row is retained, without refund POST or false settled letter`,[result,refundsOf(one.pi).map(r=>r.amount),Boolean((await undo(one.id))?.done),sent.length-beforeLetters],["returning",[],false,0]);
  is(`${kind}: interception reached healthy producer`,[used,kind==="invoice-status"?actualPaid:true],[true,true]);
  if(kind==="invoice-status"){
   is("unknown invoice status must not claim No payment was taken",sent.slice(beforeLetters).some(m=>m.text.includes("No payment was taken")),false);
   await settleOne(one.id,true);
   is("healthy worker recheck refunds original payment once",refundsOf(one.pi).map(r=>r.amount),[6900]);
  }
 }
 done();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
