/**
 * A break from the plan instead of leaving it (added 11 October 2026,
 * lib/plan-pause.ts). What is checked:
 *
 *   - who may take one: paid up, past the trial, monthly, not stopping, with
 *     no change waiting, paid for long enough, once a year;
 *   - a break sets the subscription to stop at the end of the paid period,
 *     writes down when the plan starts again and on which card, and the
 *     closing of what the store keeps waits while it runs;
 *   - taken back before it starts, the plan goes on and the year is given
 *     back; taken back after, the plan simply is not started again;
 *   - a week before the end the creator is told the date and the price,
 *     once; on the day the plan is started again on the same card, charged
 *     at once, and written down on the store;
 *   - a card the bank refuses ends the break and the creator is told; Stripe
 *     not answering is tried again the next day instead;
 *   - a store that started again by hand is left alone.
 */
import { MAX_STORE_BYTES, claimHandle, setSubscription, storeForEmail, storeForRestartSource, storeRef } from "@/lib/store";
import { PAUSE_DUE_OBSERVATION, PAUSE_OBSERVATION, pauseView, confirmPause, onBreak, pauseEmail, pauseOf, pausePlan, pauseRefusal, runBreaks, undoPause } from "@/lib/plan-pause";
import { addPeriods } from "@/lib/plans";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { PLAN_PRICES } from "@/lib/plan";
import { store as pauseRedis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_pause_only";
process.env.RESEND_API_KEY = "re_test_plan_pause_only";

const DAY = 86_400;
const NOW = 1_791_700_000;
const emails: { to: string; subject: string; text: string }[] = [];
const subs: Record<string, Record<string, unknown>> = {};
const created: URLSearchParams[] = [];
let providerCalls = 0;
let keepScheduledStop = false;
let refuseScheduledStop = false;
let loseScheduledStopAck = false;
let scheduledStopWrites = 0;
let beforeRestartAnswer: (() => Promise<void>) | null = null;
let createAnswer: "ok" | "declined" | "down" | "otherCustomer" | "otherTier" | "yearly" | "trial" | "pastDue" | "otherPrice" | "amount" | "currency" | "intervalCount" | "extraItem" | "intervalMismatch" | "quantity" | "missingQuantity" | "missingPeriod" | "expiredPeriod" | "futurePeriod" | "fractionPeriod" | "longPeriod" = "ok";

function subscription(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "active",
    customer: "cus_TestPause0001",
    default_payment_method: "pm_TestCard00001",
    cancel_at: null,
    cancel_at_period_end: false,
    start_date: NOW - 100 * DAY,
    trial_end: NOW - 86 * DAY,
    items: {
      data: [
        {
          current_period_end: NOW + 10 * DAY,
          price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } },
        },
      ],
    },
    ...over,
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    providerCalls++;
    if (url.pathname === "/v1/prices" && method === "POST") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      return new Response(JSON.stringify({
        id: "price_creator_month", unit_amount: Number(body.get("unit_amount")),
        currency: body.get("currency"),
        recurring: { interval: body.get("recurring[interval]"), interval_count: Number(body.get("recurring[interval_count]")) },
      }), { status: 200 });
    }
    if (url.pathname === "/v1/prices" || url.pathname.startsWith("/v1/prices/search") || url.pathname.startsWith("/v1/products")) {
      return new Response(JSON.stringify({ data: [{ id: "price_creator_month", lookup_key: "nimbus_labs_creator_month", active: true, unit_amount: 2900, recurring: { interval: "month" } }], has_more: false, id: "price_creator_month" }), { status: 200 });
    }
    if (url.pathname === "/v1/subscriptions" && method === "POST") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      created.push(body);
      if (createAnswer === "declined") return new Response(JSON.stringify({ error: { code: "card_declined", message: "Your card was declined." } }), { status: 402 });
      if (createAnswer === "down") return new Response(JSON.stringify({ error: { type: "api_error", message: "down" } }), { status: 500 });
      const freshPrice = {
        id: body.get("items[0][price]"), lookup_key: "nimbus_labs_creator_month",
        currency: "usd", unit_amount: PLAN_PRICES.creator.month,
        recurring: { interval: "month", interval_count: 1 },
      };
      if (createAnswer === "otherPrice") freshPrice.id = "price_NotRequested01";
      if (createAnswer === "amount") freshPrice.unit_amount += 1;
      if (createAnswer === "currency") freshPrice.currency = "eur";
      if (createAnswer === "intervalCount") freshPrice.recurring.interval_count = 2;
      if (createAnswer === "intervalMismatch") freshPrice.recurring.interval = "year";
      const observedNow = Math.floor(Date.now() / 1000);
      const items: { current_period_start?: number; current_period_end: number; price: typeof freshPrice; quantity?: number }[] = [{ current_period_start: observedNow - 60, current_period_end: observedNow + 30 * DAY, price: freshPrice, quantity: 1 }];
      if (createAnswer === "missingPeriod") delete items[0].current_period_start;
      if (createAnswer === "expiredPeriod") { items[0].current_period_start = observedNow - 2 * DAY; items[0].current_period_end = observedNow; }
      if (createAnswer === "futurePeriod") { items[0].current_period_start = observedNow + DAY; items[0].current_period_end = observedNow + 2 * DAY; }
      if (createAnswer === "fractionPeriod") items[0].current_period_start = observedNow - 0.5;
      if (createAnswer === "longPeriod") items[0].current_period_end = observedNow + 32 * DAY;
      if (createAnswer === "quantity") items[0].quantity = 2;
      if (createAnswer === "missingQuantity") delete items[0].quantity;
      if (createAnswer === "extraItem") items.push({ ...items[0] });
      const fresh = subscription("sub_Restarted00001", {
        start_date: NOW, trial_end: null,
        customer: { id: body.get("customer"), email: "x@example.com" },
        items: { data: items },
      });
      if (createAnswer === "otherCustomer") fresh.customer = { id: "cus_OtherRestart01", email: "other@example.com" };
      if (createAnswer === "otherTier" || createAnswer === "yearly") {
        fresh.items = { data: [{ current_period_end: NOW + 10 * DAY, price: {
          lookup_key: createAnswer === "otherTier" ? "nimbus_labs_pro_month" : "nimbus_labs_creator_year",
          unit_amount: createAnswer === "otherTier" ? 44900 : 69000,
          recurring: { interval: createAnswer === "yearly" ? "year" : "month" },
        } }] };
      }
      if (createAnswer === "trial") { fresh.status = "trialing"; fresh.trial_end = NOW + DAY; }
      if (createAnswer === "pastDue") fresh.status = "past_due";
      subs.sub_Restarted00001 = fresh;
      const pendingStoreChange = beforeRestartAnswer;
      beforeRestartAnswer = null;
      if (pendingStoreChange) await pendingStoreChange();
      return new Response(JSON.stringify(fresh), { status: 200 });
    }
    const m = url.pathname.match(/^\/v1\/subscriptions\/(sub_[A-Za-z0-9]+)$/);
    if (m && subs[m[1]]) {
      if (method === "POST") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("cancel_at_period_end") === "true") scheduledStopWrites++;
        if (body.has("cancel_at_period_end") && !(keepScheduledStop && body.get("cancel_at_period_end") === "false") && !(refuseScheduledStop && body.get("cancel_at_period_end") === "true")) subs[m[1]].cancel_at_period_end = body.get("cancel_at_period_end") === "true";
      }
      if (loseScheduledStopAck && method === "POST") throw new Error("synthetic lost scheduled-stop acknowledgement");
      return new Response(JSON.stringify(subs[m[1]]), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `no route ${method} ${url.pathname}` } }), { status: 404 });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function storeWith(email: string, handle: string, sub: string) {
  await claimHandle(email, handle, "A store", "");
  await setSubscription(email, { customerId: "cus_TestPause0001", subscriptionId: sub, active: true, tier: "creator", cycle: "month" });
  return (await storeForEmail(email))!;
}

async function main() {
  part("The actual pause view distinguishes missing, known and unreadable");
  {
    const store = await storeWith("pause-view@example.com", "pauseview", "sub_PauseView0001");
    const key = "nl:pause:" + storeRef(store), pipeline = pauseRedis.pipeline;
    is("missing is explicit", await pauseView(store), { kind: "missing" });
    await pipeline([["SET", key, "{broken"]]);
    is("malformed is unknown", await pauseView(store), { kind: "unknown" });
    const raw = { subscription: "sub_PauseView0001", customer: "cus_TestPause0001", paymentMethod: "pm_TestCard00001", tier: "creator", from: NOW + DAY, until: NOW + 32 * DAY, told: 0 };
    await pipeline([["SET", key, JSON.stringify(raw)]]);
    is("known record stays exact", await pauseView(store), { kind: "known", record: raw });
    let reads = 0;
    pauseRedis.pipeline = async commands => { reads++; return []; };
    try {
      is("lost view ACK is unknown", await pauseView(store), { kind: "unknown" });
      is("no extra observation or retry", reads, 1);
    } finally { pauseRedis.pipeline = pipeline; }
    await pipeline([["DEL", key]]);
  }
  part("Undo never reports an unreadable pause as removed");
  {
    const id = "sub_UndoUnknown0001";
    subs[id] = subscription(id);
    const store = await storeWith("undo-unknown@example.com", "undounknown", id);
    const paused = await pausePlan(store, 1, NOW);
    if (paused.kind !== "paused") throw new Error("Synthetic unknown undo fixture failed");
    const ref = storeRef(store), key = `nl:pause:${ref}`, annual = `nl:pause:last:${ref}`;
    const pipeline = pauseRedis.pipeline;
    const original = await pipeline([["GET", key], ["GET", annual], ["ZSCORE", "nl:pause:due", ref]]);
    for (const mode of ["malformed", "wrong-type", "lost-ack", "invalid-shape", "inherited-ack", "throw"] as const) {
      await pipeline([["DEL", key]]);
      if (mode === "wrong-type") await pipeline([["HSET", key, "evidence", "retain"]]);
      else await pipeline([["SET", key, mode === "malformed" ? "{broken" : String(original[0])]]);
      const before = providerCalls;
      let reads = 0, writes = 0;
      pauseRedis.pipeline = async commands => {
        if (commands.some(command => command[0] !== "EVAL" || command[1] !== PAUSE_OBSERVATION)) writes++;
        if (commands.length === 1 && commands[0][0] === "EVAL" && commands[0][1] === PAUSE_OBSERVATION) {
          reads++;
          if (mode === "lost-ack") return [];
          if (mode === "invalid-shape") return [[1]];
          if (mode === "inherited-ack") {
            const reply: unknown[] = new Array(1);
            Object.setPrototypeOf(reply, { 0: [0] });
            return reply;
          }
          if (mode === "throw") throw new Error("synthetic observation unavailable");
        }
        return pipeline(commands);
      };
      let refused = false;
      try { await undoPause(store, NOW + DAY); } catch { refused = true; }
      finally { pauseRedis.pipeline = pipeline; }
      is("unreadable undo refuses " + mode, refused, true);
      is("one bounded observation without retry " + mode, reads, 1);
      is("unknown undo makes no provider or cleanup write " + mode, [providerCalls - before, writes], [0, 0]);
      is("annual and due evidence remain " + mode, await pipeline([["GET", annual], ["ZSCORE", "nl:pause:due", ref]]), original.slice(1));
      if (mode === "wrong-type") is("wrong-type evidence remains", await pipeline([["HGET", key, "evidence"]]), ["retain"]);
      else is("raw evidence remains " + mode, await pipeline([["GET", key]]), [mode === "malformed" ? "{broken" : original[0]]);
    }
    await pipeline([["DEL", key]]);
    const before = providerCalls;
    is("atomic known absence still returns none", await undoPause(store, NOW + DAY), "none");
    is("known absence performs no provider request", providerCalls, before);
    await pipeline([["SET", key, String(original[0])]]);
    is("a later known pause can still be undone", await undoPause(store, NOW + DAY), "kept");
  }

  part("Undo of a stopped break only removes its observed generation");
  {
    const id = "sub_UndoGeneration01";
    subs[id] = subscription(id);
    const store = await storeWith("undo-generation@example.com", "undogeneration", id);
    const ref = storeRef(store), key = `nl:pause:${ref}`, annual = `nl:pause:last:${ref}`;
    const pipeline = pauseRedis.pipeline;
    const record = { subscription: id, customer: "cus_TestPause0001", paymentMethod: "pm_TestCard00001",
      tier: "creator", from: NOW + DAY, until: NOW + 32 * DAY, told: 0 };
    const raw = JSON.stringify(record);
    for (const mode of ["replacement", "due-only", "lost-ack", "funded"] as const) {
      const initial = mode === "funded" ? JSON.stringify({ ...record, funding: { version: 1, grantId: null } }) : raw;
      await pipeline([["SET", key, initial], ["SET", annual, String(NOW)],
        ["ZADD", "nl:pause:due", record.until, ref]]);
      let attempts = 0;
      const before = providerCalls;
      pauseRedis.pipeline = async (commands) => {
        if (commands.length === 1 && commands[0][0] === "EVAL"
          && String(commands[0][1]).startsWith("-- marktmorgen:pause-worker-forget:v1")) {
          attempts++;
          if (mode === "replacement") await pipeline([["SET", key, JSON.stringify({ ...record, told: NOW + DAY })],
            ["SET", annual, String(NOW + DAY)]]);
          if (mode === "due-only") await pipeline([["ZADD", "nl:pause:due", record.until + DAY, ref]]);
          const reply = await pipeline(commands);
          return mode === "lost-ack" ? [] : reply;
        }
        return pipeline(commands);
      };
      let refused = false;
      try { await undoPause(store, NOW + 2 * DAY); } catch { refused = true; }
      finally { pauseRedis.pipeline = pipeline; }
      is("stopped undo refuses unknown or changed evidence " + mode, refused, true);
      is("stopped undo has one cleanup attempt and no provider request " + mode, [attempts, providerCalls - before], [1, 0]);
      const retained = await pipeline([["GET", key], ["GET", annual], ["ZSCORE", "nl:pause:due", ref]]);
      is("stopped undo preserves the exact observed outcome " + mode, retained,
        mode === "lost-ack" ? [null, String(NOW), null] :
        mode === "replacement" ? [JSON.stringify({ ...record, told: NOW + DAY }), String(NOW + DAY), String(record.until)] :
        [initial, String(NOW), String(record.until + (mode === "due-only" ? DAY : 0))]);
    }
    await pipeline([["SET", key, raw], ["SET", annual, String(NOW)],
      ["ZADD", "nl:pause:due", record.until, ref]]);
    is("known stopped generation can still be removed", await undoPause(store, NOW + 2 * DAY), "stopped");
    is("stopped break never returns the annual eligibility", await pipeline([["GET", key], ["GET", annual],
      ["ZSCORE", "nl:pause:due", ref]]), [null, String(NOW), null]);
  }

  part("Stored pause fields must be owned JSON evidence");
  {
    const store = await storeWith("pause-own-fields@example.com", "pauseownfields", "sub_OwnFields0001");
    const ref = storeRef(store), key = `nl:pause:${ref}`;
    const raw = { subscription: "sub_OwnFields0001", customer: "cus_TestPause0001",
      paymentMethod: "pm_TestCard00001", tier: "creator", from: NOW + DAY,
      until: NOW + 32 * DAY, told: 0 };
    const pipeline = pauseRedis.pipeline;
    for (const field of ["subscription", "customer", "paymentMethod", "tier", "from", "until", "told", "funding"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, field);
      const missing = { ...raw } as Record<string, unknown>;
      delete missing[field];
      await pipeline([["SET", key, JSON.stringify(missing)]]);
      let reads = 0;
      try {
        Object.defineProperty(Object.prototype, field, { configurable: true,
          get() { reads++; return field === "funding" ? { version: 1, grantId: null } : raw[field as keyof typeof raw]; } });
        const observed = await pauseOf(store);
        is("inherited " + field + " cannot complete a pause", observed, null);
        is("inherited " + field + " getter is never invoked", reads, 0);
      } finally {
        if (descriptor) Object.defineProperty(Object.prototype, field, descriptor);
        else Reflect.deleteProperty(Object.prototype, field);
      }
    }
    await pipeline([["SET", key, JSON.stringify(raw)]]);
    is("the own legacy record still decodes", await pauseOf(store), raw);
    const funded = { ...raw, funding: { version: 1, grantId: null } };
    await pipeline([["SET", key, JSON.stringify(funded)]]);
    is("the own unknown funded marker remains funded evidence", await pauseOf(store), funded);
    for (const field of ["version", "grantId"] as const) {
      const partial = { ...funded, funding: { ...funded.funding } as Record<string, unknown> };
      delete partial.funding[field];
      await pipeline([["SET", key, JSON.stringify(partial)]]);
      const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, field);
      let reads = 0;
      try {
        Object.defineProperty(Object.prototype, field, { configurable: true,
          get() { reads++; return field === "version" ? 1 : null; } });
        is("inherited funding " + field + " is refused", await pauseOf(store), null);
        is("funding getter remains untouched " + field, reads, 0);
      } finally {
        if (descriptor) Object.defineProperty(Object.prototype, field, descriptor);
        else Reflect.deleteProperty(Object.prototype, field);
      }
    }
    await pipeline([["DEL", key]]);
  }
  part("Who may take a break");
  {
    is("a monthly plan paid for months, never paused", pauseRefusal(subscription("sub_a"), NOW, false), null);
    is("not in the trial", pauseRefusal(subscription("sub_a", { status: "trialing", trial_end: NOW + DAY }), NOW, false), "trial");
    is("not a yearly plan", pauseRefusal(subscription("sub_a", { items: { data: [{ current_period_end: NOW + DAY, price: { lookup_key: "nimbus_labs_creator_year", unit_amount: 30000, recurring: { interval: "year" } } }] } }), NOW, false), "yearly");
    is("not one set to stop", pauseRefusal(subscription("sub_a", { cancel_at_period_end: true }), NOW, false), "canceling");
    is("not with a change waiting", pauseRefusal(subscription("sub_a", { pending_update: { expires_at: NOW + DAY } }), NOW, false), "pending");
    is("not one behind on paying", pauseRefusal(subscription("sub_a", { status: "past_due" }), NOW, false), "standing");
    // One month paid: the trial ended 20 days ago, so only the first charge went through.
    is("not before two months are paid", pauseRefusal(subscription("sub_a", { trial_end: NOW - 20 * DAY, start_date: NOW - 34 * DAY }), NOW, false), "early");
    // Exactly at the second charge.
    const first = NOW - 31 * DAY;
    is("from the second charge on", pauseRefusal(subscription("sub_a", { trial_end: first, start_date: first - 14 * DAY }), addPeriods(first, "month", 1), false), null);
    is("not twice in a year", pauseRefusal(subscription("sub_a"), NOW, true), "recent");
  }

  part("Taking a break");
  {
    subs.sub_Pause0000001 = subscription("sub_Pause0000001");
    const store = await storeWith("pause@example.com", "pausestore", "sub_Pause0000001");
    const result = await pausePlan(store, 2, NOW);
    is("it is set", result.kind, "paused");
    is("the subscription stops at the end of the paid period", subs.sub_Pause0000001.cancel_at_period_end, true);
    const record = await pauseOf(store);
    is("from the end of the paid period", record?.from, NOW + 10 * DAY);
    is("to two months after", record?.until, addPeriods(NOW + 10 * DAY, "month", 2));
    is("on the card the plan is paid with", record?.paymentMethod, "pm_TestCard00001");
    is("the closing waits while it runs", await onBreak(storeRef(store), NOW + 20 * DAY), true);
    is("and not after it", await onBreak(storeRef(store), (record?.until ?? 0) + 1), false);

    const again = await pausePlan(store, 1, NOW);
    is("a second break the same year is refused", again.kind === "refused" ? again.reason : again.kind, "canceling");

    const undone = await undoPause(store, NOW + DAY);
    is("taken back before it starts, the plan goes on", undone, "kept");
    is("the subscription no longer stops", subs.sub_Pause0000001.cancel_at_period_end, false);
    is("and nothing is left set", await pauseOf(store), null);
    const third = await pausePlan(store, 1, NOW + DAY);
    is("the year is given back for a break that never began", third.kind, "paused");
    // Taken back again, so this store's break does not end beside the next part's.
    await undoPause(store, NOW + DAY);
  }

  part("Taking a break requires acknowledgement of the scheduled stop");
  {
    const id = "sub_PauseAck00001";
    subs[id] = subscription(id);
    const store = await storeWith("pause-ack@example.com", "pauseackstore", id);
    refuseScheduledStop = true;
    let refused = false;
    try { await pausePlan(store, 1, NOW); } catch { refused = true; }
    refuseScheduledStop = false;
    is("an active response without the stop is not a confirmed break", refused, true);
    is("the provider has not scheduled a stop", subs[id].cancel_at_period_end, false);
    is("the unconfirmed break retains its exact source", (await pauseOf(store))?.subscription, id);
    const [heldYear, heldDue] = await pauseRedis.pipeline([["GET", `nl:pause:last:${storeRef(store)}`], ["ZRANGEBYSCORE", "nl:pause:due", "-inf", "+inf"]]);
    is("an unconfirmed stop retains annual and due evidence", [heldYear, Array.isArray(heldDue) && heldDue.includes(storeRef(store))], [String(NOW), true]);
    is("an unconfirmed stop does not infer a fresh unused year", await pausePlan(store, 1, NOW), {kind:"refused",reason:"recent"});
    await undoPause(store, NOW + DAY);
    const again = await pausePlan(store, 1, NOW);
    is("after explicit acknowledged undo a new break remains possible", again.kind, "paused");
    is("the later stop is acknowledged by the provider", subs[id].cancel_at_period_end, true);
    await undoPause(store, NOW + DAY);
  }

  part("Unknown persistence acknowledgements never authorize a provider stop");
  {
    const email="pause-write-ack@example.com",id="sub_PauseWriteAck01";
    subs[id]=subscription(id);
    const store=await storeWith(email,"pausewriteack",id),ref=storeRef(store);
    const original=pauseRedis.pipeline;
    let ackGetters=0,oversizedMembers=0;
    const inherited=(values:unknown[])=>{
      const reply=new Array(values.length),prototype=Object.create(Array.prototype);
      values.forEach((value,index)=>Object.defineProperty(prototype,String(index),{value}));
      Object.setPrototypeOf(reply,prototype);return reply;
    };
    const replies:unknown[][]=[[],[null],["OK",1],["OK","1","OK"],["OK",2,"OK"],[true,1,"OK"],["OK",1,null],["OK",1,"OK","extra"]];
    replies.push(inherited(["OK",1,"OK"]));
    for(const index of [0,1,2]){
      const reply:unknown[]=["OK",1,"OK"];
      Object.defineProperty(reply,String(index),{get(){ackGetters++;return ["OK",1,"OK"][index];}});
      replies.push(reply);
    }
    replies.push(new Proxy(["OK",1,"OK","extra"],{getOwnPropertyDescriptor(target,key){if(key==="0"){oversizedMembers++;throw Error("oversized scheduling ACK");}return Reflect.getOwnPropertyDescriptor(target,key);}}));
    for(const reply of replies){
      pauseRedis.pipeline=async commands=>{
        if(commands.length===3&&commands[0][0]==="SET"&&commands[0][1]===`nl:pause:${ref}`){
          await original(commands); // The commit happened; only its reply is uncertain.
          return reply;
        }
        return original(commands);
      };
      try{
        const before=scheduledStopWrites;
        is("uncertain write acknowledgement refuses scheduling",await pausePlan(store,1,NOW),{kind:"refused",reason:"standing"});
        is("no provider mutation follows an uncertain write acknowledgement",scheduledStopWrites-before,0);
        const [record,year,due]=await original([["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`],["ZRANGEBYSCORE","nl:pause:due","-inf","+inf"]]);
        is("committed pause and annual evidence are never rolled back", [typeof record,year,Array.isArray(due)&&due.includes(ref)], ["string",String(NOW),true]);
      }finally{
        pauseRedis.pipeline=original;
        await original([["DEL",`nl:pause:${ref}`],["DEL",`nl:pause:last:${ref}`],["ZREM","nl:pause:due",ref]]);
      }
    }
    is("scheduling ACK getters and invalid-shape members were not read",[ackGetters,oversizedMembers],[0,0]);
  }

  part("A provider-applied stop with a lost acknowledgement retains the pause");
  {
    const email="pause-provider-ack@example.com",id="sub_PauseProviderAck01";
    subs[id]=subscription(id);
    const store=await storeWith(email,"pauseproviderack",id),ref=storeRef(store);
    loseScheduledStopAck=true;
    let uncertain=false;
    try{await pausePlan(store,1,NOW);}catch{uncertain=true;}finally{loseScheduledStopAck=false;}
    is("the caller is not told that an unknown stop succeeded",uncertain,true);
    is("the provider mutation actually happened in the synthetic service",subs[id].cancel_at_period_end,true);
    const [record,year,due]=await pauseRedis.pipeline([["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`],["ZRANGEBYSCORE","nl:pause:due","-inf","+inf"]]);
    is("applied unknown stop retains pause, annual evidence and due member",[typeof record,year,Array.isArray(due)&&due.includes(ref)],["string",String(NOW),true]);
    is("the retained record still protects creator content",await onBreak(ref,NOW+20*DAY),true);
    const before=scheduledStopWrites;
    is("repeating the request cannot schedule another stop", (await pausePlan(store,1,NOW)).kind,"refused");
    is("repeat makes no second provider mutation",scheduledStopWrites-before,0);
    is("explicit acknowledged undo still works",await undoPause(store,NOW+DAY),"kept");
  }

  part("Taking a break back requires acknowledgement of the removed stop");
  {
    const id = "sub_UndoAck00001";
    subs[id] = subscription(id);
    const store = await storeWith("undo-ack@example.com", "undoackstore", id);
    const set = await pausePlan(store, 1, NOW);
    is("the break is available to take back", set.kind, "paused");
    const before = await pauseOf(store);
    keepScheduledStop = true;
    let refused = false;
    try { await undoPause(store, NOW + DAY); } catch { refused = true; }
    keepScheduledStop = false;
    is("an unchanged scheduled stop is not reported as kept", refused, true);
    is("the original pause is retained exactly", await pauseOf(store), before);
    is("the provider still plans to stop it", subs[id].cancel_at_period_end, true);
    is("a later acknowledged undo still works", await undoPause(store, NOW + DAY), "kept");
    is("the pause is removed only after acknowledgement", await pauseOf(store), null);
    is("the provider no longer plans to stop it", subs[id].cancel_at_period_end, false);
  }

  part("The emails say the dates and the price");
  {
    const record = { subscription: "sub_x", customer: "cus_x", paymentMethod: "pm_x", tier: "creator" as const, from: NOW, until: NOW + 61 * DAY, told: 0 };
    const set = pauseEmail("set", record);
    is("set: when the checkout closes and when it opens", set.text.includes("Your store keeps taking payments until") && set.text.includes("starts again by itself, at $69 a month"), true);
    const soon = pauseEmail("soon", record);
    is("a week before: the charge and how to stop it", soon.text.includes("your card is charged $69") && soon.text.includes("one click"), true);
    const failed = pauseEmail("failed", record);
    is("failed: a card refusal does not rule out an earlier charge", failed.text.includes("Nothing was charged."), false);
    is("failed: distinguishes the latest refusal from earlier attempts", failed.text.includes("latest attempt was refused") && failed.text.includes("does not confirm the outcome of any earlier attempt"), true);
    is("failed: asks for billing review before another charge", failed.text.includes("Check your billing in the studio before starting the plan again") && failed.text.includes("do not send card details"), true);
  }

  part("The end of a break");
  {
    subs.sub_Restart00001 = subscription("sub_Restart00001");
    const store = await storeWith("restart@example.com", "restartstore", "sub_Restart00001");
    const set = await pausePlan(store, 1, NOW);
    const until = set.kind === "paused" ? set.record.until : 0;
    // The paid period ends: the store's plan has ended, as cancelling leaves it.
    await setSubscription("restart@example.com", { active: false });

    emails.length = 0;
    await runBreaks(until - 10 * DAY);
    is("nothing yet ten days before", emails.length, 0);
    await runBreaks(until - 6 * DAY);
    is("told a week before", emails.map((e) => e.subject), ["Your Marktmorgen plan starts again on " + new Date(until * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" })]);
    await runBreaks(until - 5 * DAY);
    is("once", emails.length, 1);

    const counts = await runBreaks(until + 60);
    is("started again on the day", counts.restarted, 1);
    is("on the same customer and card, charged at once", [created[0].get("customer"), created[0].get("default_payment_method"), created[0].get("payment_behavior"), created[0].get("off_session")], ["cus_TestPause0001", "pm_TestCard00001", "error_if_incomplete", "true"]);
    const after = await storeForEmail("restart@example.com");
    is("written down on the store", [after?.subscriptionActive, after?.subscriptionId], [true, "sub_Restarted00001"]);
    is("the creator is told", emails[emails.length - 1]?.subject, "Your Marktmorgen plan has started again");
    is("and the break is gone", await pauseOf(after!), null);
  }

  part("When the card is refused, or Stripe does not answer");
  {
    subs.sub_Decline00001 = subscription("sub_Decline00001");
    const store = await storeWith("decline@example.com", "declinestore", "sub_Decline00001");
    const set = await pausePlan(store, 1, NOW);
    const until = set.kind === "paused" ? set.record.until : 0;
    await setSubscription("decline@example.com", { active: false });

    createAnswer = "down";
    await runBreaks(until + 60);
    is("Stripe not answering keeps the break, for the next day", (await pauseOf(store)) !== null, true);
    createAnswer = "declined";
    emails.length = 0;
    const counts = await runBreaks(until + DAY);
    is("a refused card ends the break", [counts.failed, await pauseOf(store)], [1, null]);
    is("and the creator is told", emails.map((e) => e.subject), ["Your Marktmorgen plan could not start again"]);
    const notice = emails[0]?.text ?? "";
    is("a refusal after an unknown attempt never promises no charge", notice.includes("Nothing was charged."), false);
    is("earlier uncertainty remains explicit after the later refusal", notice.includes("does not confirm the outcome of any earlier attempt") && notice.includes("contact us before trying again"), true);
    is("the store does not sell", (await storeForEmail("decline@example.com"))?.subscriptionActive, false);
    createAnswer = "ok";
  }

  part("An unknown provider outcome never promises that nothing was charged");
  {
    subs.sub_Unknown00001 = subscription("sub_Unknown00001");
    const store = await storeWith("unknown@example.com", "unknownrestart", "sub_Unknown00001");
    const set = await pausePlan(store, 1, NOW);
    const until = set.kind === "paused" ? set.record.until : 0;
    await setSubscription("unknown@example.com", { active: false });
    createAnswer = "down";
    emails.length = 0;
    const counts = await runBreaks(until + 4 * DAY);
    is("the existing retry horizon still ends", counts.failed, 1);
    is("unknown outcome has its own truthful notice", emails.map((e) => e.subject), ["Your Marktmorgen plan restart needs a check"]);
    const text = emails[0]?.text ?? "";
    is("it does not claim that no charge occurred", text.includes("Nothing was charged."), false);
    is("it states uncertainty and asks for checking before another restart", text.includes("whether a charge went through") && text.includes("Before starting the plan again, contact us") && text.includes("do not send card details"), true);
    is("it does not claim the plan is taking payments", text.includes("your checkout is taking payments"), false);
    createAnswer = "ok";
  }

  part("A restart response must match the requested paid monthly plan");
  {
    const mismatches = ["otherCustomer", "otherTier", "yearly", "trial", "pastDue", "otherPrice", "amount", "currency", "intervalCount", "extraItem", "intervalMismatch", "quantity", "missingQuantity", "missingPeriod", "expiredPeriod", "futurePeriod", "fractionPeriod", "longPeriod"] as const;
    for (const [index, answer] of mismatches.entries()) {
      const id = `sub_Mismatch0000${index}`;
      const email = `restart-mismatch-${index}@example.com`;
      subs[id] = subscription(id);
      const store = await storeWith(email, `restartmismatch${index}`, id);
      const set = await pausePlan(store, 1, NOW);
      const until = set.kind === "paused" ? set.record.until : 0;
      await setSubscription(email, { active: false });
      createAnswer = answer;
      emails.length = 0;
      const before = created.length;
      const counts = await runBreaks(until + 60);
      const after = await storeForEmail(email);
      is(`${answer}: observed response does not activate the store`, [counts.restarted, counts.failed, after?.subscriptionActive], [0, 1, false]);
      is(`${answer}: no success or no-charge message`, emails.length, 0);
      is(`${answer}: pause remains for existing uncertain-outcome handling`, (await pauseOf(store)) !== null, true);
      is(`${answer}: no additional provider attempt in this pass`, created.length - before, 1);
      await undoPause(store, until + 60);
    }
    createAnswer = "ok";
  }

  part("Unreadable pause evidence is retained without attempting a charge");
  {
    const email = "unreadable-pause@example.com";
    const id = "sub_Unreadable001";
    subs[id] = subscription(id);
    const store = await storeWith(email, "unreadablepause", id);
    const set = await pausePlan(store, 1, NOW);
    const until = set.kind === "paused" ? set.record.until : 0;
    await setSubscription(email, { active: false });
    const ref = storeRef(store);
    const key = `nl:pause:${ref}`;
    const good = set.kind === "paused" ? set.record : {};
    for (const raw of [
      "", "x".repeat(4097), JSON.stringify({ ...good, extra: "é".repeat(2100) }),
      "{", "null", JSON.stringify({ subscription: "sub_InvalidRecord" }),
      JSON.stringify({ ...good, from: -1 }),
      JSON.stringify({ ...good, until: until + 0.5 }),
      JSON.stringify({ ...good, until: Number.MAX_SAFE_INTEGER + 1 }),
      JSON.stringify({ ...good, paymentMethod: "not_a_card" }),
      JSON.stringify({ ...good, told: -1 }),
      JSON.stringify({ ...good, told: "unknown" }),
    ]) {
      await pauseRedis.pipeline([["SET", key, raw]]);
      const before = created.length;
      emails.length = 0;
      const counts = await runBreaks(until + DAY);
      const [retained, due] = await pauseRedis.pipeline([
        ["GET", key],
        ["ZRANGEBYSCORE", "nl:pause:due", "-inf", String(until + DAY)],
      ]);
      is("unreadable evidence is not treated as a missing pause", [counts.failed, counts.dropped, counts.restarted], [1, 0, 0]);
      is("the exact stored evidence remains", retained, raw);
      is("unreadable pause evidence makes closing wait", await onBreak(ref, until + DAY), true);
      is("the pending entry remains available for reconciliation", Array.isArray(due) && due.includes(ref), true);
      is("no provider charge or notice follows unreadable evidence", [created.length - before, emails.length], [0, 0]);
    }
    const originalPipeline = pauseRedis.pipeline;
    for (const reply of [[], [null, "unrelated"], [JSON.stringify(good), "unrelated"], [null], [[0, "extra"]], [[1]], [[1, JSON.stringify(good), "extra"]], [[1, "x".repeat(4097)]], [[2, JSON.stringify(good)]]]) {
      pauseRedis.pipeline = async (commands) => {
        if (commands.length === 1 && commands[0][0] === "EVAL" && commands[0][1] === PAUSE_OBSERVATION && commands[0][3] === key) return reply;
        return originalPipeline(commands);
      };
      try {
        const before = created.length;
        emails.length = 0;
        const counts = await runBreaks(until + DAY);
        const [retained, due] = await originalPipeline([
          ["GET", key], ["ZRANGEBYSCORE", "nl:pause:due", "-inf", String(until + DAY)],
        ]);
        is("ambiguous read cardinality cannot authorize cleanup or restart", [counts.failed, counts.dropped, counts.restarted], [1, 0, 0]);
        is("ambiguous read keeps closing on hold", await onBreak(ref, until + DAY), true);
        is("ambiguous read retains stored evidence and due index", [typeof retained, Array.isArray(due) && due.includes(ref)], ["string", true]);
        is("ambiguous read produces no charge or notice", [created.length - before, emails.length], [0, 0]);
      } finally {
        pauseRedis.pipeline = originalPipeline;
      }
    }
    // An explicit Redis miss remains ordinary stale-index cleanup.
    await pauseRedis.pipeline([["DEL", key]]);
    const before = created.length;
    emails.length = 0;
    const missing = await runBreaks(until + DAY);
    const [due] = await pauseRedis.pipeline([["ZRANGEBYSCORE", "nl:pause:due", "-inf", String(until + DAY)]]);
    is("an explicit missing record is still dropped", [missing.dropped, missing.failed, missing.restarted], [1, 0, 0]);
    is("its stale due entry is removed", Array.isArray(due) && due.includes(ref), false);
    is("absence never initiates a charge or notice", [created.length - before, emails.length], [0, 0]);
    is("explicit absence does not indefinitely hold closing", await onBreak(ref, until + DAY), false);
    const pipeline = pauseRedis.pipeline;
    pauseRedis.pipeline = async () => { throw new Error("synthetic pause read unavailable"); };
    try {
      is("unavailable pause evidence also makes closing wait", await onBreak(ref, until + DAY), true);
    } finally {
      pauseRedis.pipeline = pipeline;
    }
  }

  part("An uncertain due-list reply cannot start unbounded or duplicate work");
  {
    const originalPipeline = pauseRedis.pipeline;
    const replies: unknown[][] = [
      [], [null], [["unknown@example.com"], "unrelated"], [[null]],
      [["unknown@example.com", "unknown@example.com"]], [[""]], [["x".repeat(1281)]], [["é".repeat(641)]],
      [Array.from({length:201},(_,index)=>`over-limit-${index}@example.com`)],
    ];
    for (const reply of replies) {
      let otherCommands=0;
      pauseRedis.pipeline = async (commands) => {
        if (commands.length === 1 && commands[0][0] === "EVAL" && commands[0][1] === PAUSE_DUE_OBSERVATION) return reply;
        otherCommands += commands.length;
        return originalPipeline(commands);
      };
      try {
        const before=created.length;emails.length=0;
        const counts=await runBreaks(NOW+400*DAY);
        is("unknown due batch is reported as failed, not empty success", counts, {told:0,restarted:0,failed:1,dropped:0});
        is("unknown due batch authorizes no per-store operation, charge or notice", [otherCommands,created.length-before,emails.length], [0,0,0]);
      } finally {
        pauseRedis.pipeline=originalPipeline;
      }
    }
    pauseRedis.pipeline=async(commands)=>{
      if(commands.length===1&&commands[0][0]==="EVAL"&&commands[0][1]===PAUSE_DUE_OBSERVATION)return [[]];
      return originalPipeline(commands);
    };
    try {
      is("one explicit empty due list remains a successful no-op", await runBreaks(NOW), {told:0,restarted:0,failed:0,dropped:0});
    } finally {
      pauseRedis.pipeline=originalPipeline;
    }
  }

  part("Unknown annual pause eligibility is refused before scheduling or persistence");
  {
    const email="unknown-eligibility@example.com",id="sub_UnknownEligibility01";
    subs[id]=subscription(id);
    const store=await storeWith(email,"unknowneligibility",id);
    const ref=storeRef(store),lastKey=`nl:pause:last:${ref}`;
    const originalPipeline=pauseRedis.pipeline;
    let ackGetters=0,oversizedMembers=0;
    const inherited=(values:unknown[])=>{
      const reply=new Array(values.length),prototype=Object.create(Array.prototype);
      values.forEach((value,index)=>Object.defineProperty(prototype,String(index),{value}));
      Object.setPrototypeOf(reply,prototype);return reply;
    };
    const replies:unknown[][]=[[],[undefined],[null],["0"],["1"],[true],[-1],[2],[0,"extra"],[1,"extra"]];
    replies.push(inherited([0]),inherited([1]));
    for(const value of [0,1])replies.push(Object.defineProperty(new Array(1),"0",{get(){ackGetters++;return value;}}));
    replies.push(new Proxy([0,"extra"],{getOwnPropertyDescriptor(target,key){if(key==="0"){oversizedMembers++;throw Error("oversized eligibility ACK");}return Reflect.getOwnPropertyDescriptor(target,key);}}));
    for(const reply of replies){
      let otherCommands=0;
      pauseRedis.pipeline=async(commands)=>{
        if(commands.length===1&&commands[0][0]==="EXISTS"&&commands[0][1]===lastKey)return reply;
        otherCommands+=commands.length;
        return originalPipeline(commands);
      };
      try{
        const before=created.length;emails.length=0;
        const result=await pausePlan(store,1,NOW);
        is("uncertain eligibility has no inferred unused year", result, {kind:"refused",reason:"standing"});
        is("uncertain eligibility performs no subsequent Redis mutation",otherCommands,0);
        is("uncertain eligibility does not schedule the provider stop",subs[id].cancel_at_period_end,false);
        is("uncertain eligibility has no charge or notice",[created.length-before,emails.length],[0,0]);
        const [record,last]=await originalPipeline([["GET",`nl:pause:${ref}`],["GET",lastKey]]);
        is("uncertain eligibility leaves both pause and annual marker absent",[record,last],[null,null]);
      }finally{pauseRedis.pipeline=originalPipeline;}
    }
    is("eligibility ACK getters and invalid-shape members were not read",[ackGetters,oversizedMembers],[0,0]);
  }

  part("Pause source identity and customer must match the store before any write");
  {
    const email="source-identity@example.com",id="sub_SourceIdentity01";
    const store=await storeWith(email,"sourceidentity",id);
    const ref=storeRef(store);
    const changes:Record<string,unknown>[]=[
      {id:"sub_OtherSource01"},{id:null},{customer:"cus_OtherOwner01"},
      {customer:{id:"cus_OtherOwner01"}},{customer:null},{customer:"not_a_customer"},{customer:{}},
    ];
    for(const change of changes){
      subs[id]=subscription(id,change);
      const originalPipeline=pauseRedis.pipeline;
      let commandsAfterObservation=0;
      pauseRedis.pipeline=async(commands)=>{commandsAfterObservation+=commands.length;return originalPipeline(commands);};
      try{
        const before=created.length;emails.length=0;
        is("mismatched or missing source ownership is refused",await pausePlan(store,1,NOW),{kind:"refused",reason:"standing"});
        is("source ownership fails before Redis scheduling writes or eligibility reads",commandsAfterObservation,0);
        is("the original subscription is not scheduled to stop",subs[id].cancel_at_period_end,false);
        is("source mismatch has no new charge or notice",[created.length-before,emails.length],[0,0]);
        const [record,last]=await originalPipeline([["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`]]);
        is("source mismatch creates no pause or annual record",[record,last],[null,null]);
      }finally{pauseRedis.pipeline=originalPipeline;}
    }
    subs[id]=subscription(id,{customer:{id:"cus_TestPause0001",email:"ignored@example.com"}});
    const valid=await pausePlan(store,1,NOW);
    is("a matching expanded provider customer remains supported",valid.kind,"paused");
    is("the observed customer is retained exactly",valid.kind==="paused"?valid.record.customer:null,"cus_TestPause0001");
    await undoPause(store,NOW);
  }

  part("An unusable payment method cannot create an unreadable pause");
  {
    const email="invalid-pause-card@example.com",id="sub_InvalidPauseCard01";
    const store=await storeWith(email,"invalidpausecard",id);
    const ref=storeRef(store);
    const changes:Record<string,unknown>[]=[
      {default_payment_method:"not_a_card"},
      {default_payment_method:"pm_short"},
      {default_payment_method:"pm_"+"a".repeat(65)},
      {default_payment_method:{id:"not_a_card"}},
      {default_payment_method:null,default_source:"not_a_card"},
      {default_payment_method:null,default_source:42},
      {default_payment_method:42},
    ];
    for(const change of changes){
      subs[id]=subscription(id,change);
      const originalPipeline=pauseRedis.pipeline;
      let mutationCommands=0;
      pauseRedis.pipeline=async(commands)=>{
        mutationCommands+=commands.filter(command=>command[0]!=="EXISTS").length;
        return originalPipeline(commands);
      };
      try{
        const before=created.length;emails.length=0;
        is("a payment method that cannot be read back is refused",await pausePlan(store,1,NOW),{kind:"refused",reason:"card"});
        is("an unusable card creates no scheduling or annual writes",mutationCommands,0);
        is("an unusable card does not stop the original subscription",subs[id].cancel_at_period_end,false);
        is("an unusable card causes no charge or notice",[created.length-before,emails.length],[0,0]);
        const [record,last]=await originalPipeline([["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`]]);
        is("no unreadable pause or annual marker is persisted",[record,last],[null,null]);
      }finally{pauseRedis.pipeline=originalPipeline;}
    }
    for(const change of [
      {default_payment_method:{id:"pm_ExpandedCard01"}},
      {default_payment_method:null,default_source:"card_LegacyCard01"},
      {default_payment_method:null,default_source:"src_LegacySource01"},
    ]){
      subs[id]=subscription(id,change);
      const result=await pausePlan(store,1,NOW);
      is("supported expanded and legacy card identifiers remain usable",result.kind,"paused");
      is("the successfully written pause can be read back",await pauseOf(store),result.kind==="paused"?result.record:null);
      await undoPause(store,NOW);
    }
  }

  part("An original plan still active at the restart date is not charged again");
  {
    const email="original-still-active@example.com",id="sub_OriginalActive01";
    subs[id]=subscription(id);
    const store=await storeWith(email,"originalstillactive",id);
    const set=await pausePlan(store,1,NOW);
    const until=set.kind==="paused"?set.record.until:0;
    const ref=storeRef(store);
    const before=created.length;emails.length=0;
    const [originalRecord,originalYear]=await pauseRedis.pipeline([
      ["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`],
    ]);
    const counts=await runBreaks(until+60);
    is("an active original plan is an unresolved restart, not a success or stale entry",counts,{told:0,restarted:0,failed:1,dropped:0});
    is("no replacement charge or success/decline notice is made",[created.length-before,emails.length],[0,0]);
    const [retainedRecord,retainedYear,due]=await pauseRedis.pipeline([
      ["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`],
      ["ZRANGEBYSCORE","nl:pause:due","-inf",String(until+60)],
    ]);
    is("the exact pause and annual evidence remain",[retainedRecord,retainedYear],[originalRecord,originalYear]);
    is("the due record remains available for reconciliation",Array.isArray(due)&&due.includes(ref),true);
    is("the original store remains active",(await storeForEmail(email))?.subscriptionActive,true);
    await setSubscription(email,{active:false});
    const reconciled=await runBreaks(until+60);
    is("an ordinary restart still works after the original is recorded inactive",[reconciled.restarted,reconciled.failed],[1,0]);
    is("only that later pass creates the replacement",created.length-before,1);
  }


  part("A restart needs an acknowledged store write before cleanup or notice");
  for (const answer of ["missing", "corrupt", "empty", "unavailable"] as const) {
    const email = "restart-ack-" + answer + "@example.com", id = "sub_RestartAck" + answer;
    subs[id] = subscription(id);
    const store = await storeWith(email, "restartack" + answer, id);
    const paused = await pausePlan(store, 1, NOW);
    if (paused.kind !== "paused") throw new Error("Synthetic restart acknowledgement pause was refused");
    await setSubscription(email, { active: false });
    const ref = storeRef(store), key = `nl:pause:${ref}`, year = `nl:pause:last:${ref}`;
    const pipeline = pauseRedis.pipeline;
    const evidence = await pipeline([["GET", key], ["GET", year]]);
    const before = created.length;
    let refusedReads = 0;
    emails.length = 0;
    pauseRedis.pipeline = async commands => {
      if (created.length > before && commands.length === 1 && commands[0][0] === "GET" &&
          String(commands[0][1]).startsWith("nl:store:owner:")) {
        refusedReads++;
        if (answer === "unavailable") throw new Error("Synthetic restart store write unavailable");
        return answer === "empty" ? [] : [answer === "missing" ? null : "{not-json"];
      }
      return pipeline(commands);
    };
    try {
      is("unknown saved store is held rather than announced as restarted", await runBreaks(paused.record.until + (answer === "unavailable" ? 4 * DAY : 60)),
        { told: 0, restarted: 0, failed: 1, dropped: 0 });
      is("the fixture reaches the nullable writer after one synthetic provider result",
        [created.length - before, refusedReads > 0], [1, true]);
      is("no success or refusal email follows an unacknowledged write", emails.length, 0);
      const [record, last, due] = await pipeline([
        ["GET", key], ["GET", year], ["ZRANGEBYSCORE", "nl:pause:due", "-inf", String(paused.record.until + 4 * DAY)],
      ]);
      is("exact pause and annual evidence survive missing store acknowledgement", [record, last], evidence);
      is("due membership survives missing store acknowledgement", Array.isArray(due) && due.includes(ref), true);
    } finally { pauseRedis.pipeline = pipeline; }
    is("unacknowledged restart never activates the store", (await storeForEmail(email))?.subscriptionActive, false);
    await undoPause(store, paused.record.until + 60);
  }

  part("A restart cannot overwrite a store changed while the provider answered");
  for (const changed of ["subscription", "customer", "inactive"] as const) {
    const email = "restart-race-" + changed + "@example.com", id = "sub_RestartRace" + changed;
    subs[id] = subscription(id);
    const store = await storeWith(email, "restartrace" + changed, id);
    const paused = await pausePlan(store, 1, NOW);
    if (paused.kind !== "paused") throw new Error("Synthetic restart source pause was refused");
    await setSubscription(email, { active: false });
    const ref = storeRef(store), key = `nl:pause:${ref}`, year = `nl:pause:last:${ref}`;
    const evidence = await pauseRedis.pipeline([["GET", key], ["GET", year]]);
    const before = created.length;
    let intervened = false;
    beforeRestartAnswer = async () => {
      const saved = await setSubscription(email, changed !== "customer"
        ? { active: changed === "subscription", subscriptionId: "sub_ManualRestartRace01", period: changed === "subscription" ? paidPeriod() : null }
        : { active: false, customerId: "cus_ChangedRestartRace01" });
      if (!saved) throw new Error("Synthetic intervening store write failed");
      intervened = true;
    };
    emails.length = 0;
    try {
      is("a changed source is unresolved rather than overwritten", await runBreaks(paused.record.until + 60),
        { told: 0, restarted: 0, failed: 1, dropped: 0 });
      is("the race occurs during one synthetic provider response", [intervened, created.length - before], [true, 1]);
      const current = await storeForEmail(email);
      is("the intervening subscription is preserved", current?.subscriptionId, changed !== "customer" ? "sub_ManualRestartRace01" : id);
      is("the intervening customer is preserved", current?.stripeCustomerId, changed === "customer" ? "cus_ChangedRestartRace01" : store.stripeCustomerId);
      is("the intervening active state is preserved", current?.subscriptionActive, changed === "subscription");
      is("no restart success or refusal notice is sent", emails.length, 0);
      const [record, last, due] = await pauseRedis.pipeline([
        ["GET", key], ["GET", year], ["ZRANGEBYSCORE", "nl:pause:due", "-inf", String(paused.record.until + 60)],
      ]);
      is("source mismatch retains exact pause and annual evidence", [record, last], evidence);
      is("source mismatch retains its due member", Array.isArray(due) && due.includes(ref), true);
    } finally { beforeRestartAnswer = null; }
    if (changed !== "subscription") {
      const calls = providerCalls, beforeRetry = created.length;
      is("a changed inactive source remains held on the next due pass", await runBreaks(paused.record.until + 120),
        { told: 0, restarted: 0, failed: 1, dropped: 0 });
      is("a source mismatch performs no provider read or new charge", [providerCalls, created.length], [calls, beforeRetry]);
      is("a source mismatch sends no later notice", emails.length, 0);
    }
    await undoPause(store, paused.record.until + 60);
  }

  part("A restart cannot overwrite a changed plan with the same customer and subscription");
  for (const changed of ["tier", "cycle"] as const) {
    const email = "restart-plan-race-" + changed + "@example.com", id = "sub_PlanRace" + changed;
    subs[id] = subscription(id);
    const store = await storeWith(email, "restartplanrace" + changed, id);
    const paused = await pausePlan(store, 1, NOW);
    if (paused.kind !== "paused") throw new Error("Synthetic plan source pause was refused");
    await setSubscription(email, { active: false });
    const ref = storeRef(store), key = `nl:pause:${ref}`, year = `nl:pause:last:${ref}`;
    const evidence = await pauseRedis.pipeline([["GET", key], ["GET", year]]);
    const before = created.length;
    let intervened = false;
    beforeRestartAnswer = async () => {
      const saved = await setSubscription(email, changed === "tier"
        ? { active: false, tier: "pro" } : { active: false, cycle: "year" });
      if (!saved) throw new Error("Synthetic intervening plan write failed");
      intervened = true;
    };
    emails.length = 0;
    try {
      is("changed plan source remains unresolved", await runBreaks(paused.record.until + 60),
        { told: 0, restarted: 0, failed: 1, dropped: 0 });
      is("plan race happens during one synthetic provider response", [intervened, created.length - before], [true, 1]);
      const current = await storeForEmail(email);
      is("same subscription and customer are preserved", [current?.subscriptionId, current?.stripeCustomerId], [id, store.stripeCustomerId]);
      is("newer tier and interval are preserved", [current?.tier, current?.cycle, current?.subscriptionActive],
        [changed === "tier" ? "pro" : "creator", changed === "cycle" ? "year" : "month", false]);
      is("plan mismatch retains exact pause and annual evidence", await pauseRedis.pipeline([["GET", key], ["GET", year]]), evidence);
      const [due] = await pauseRedis.pipeline([["ZRANGEBYSCORE", "nl:pause:due", "-inf", String(paused.record.until + 60)]]);
      is("plan mismatch retains due membership", Array.isArray(due) && due.includes(ref), true);
      is("no false plan restart notice", emails.length, 0);
      const calls = providerCalls, charges = created.length;
      is("next due pass keeps the changed plan held", await runBreaks(paused.record.until + 120),
        { told: 0, restarted: 0, failed: 1, dropped: 0 });
      is("changed plan causes no later provider read or new charge", [providerCalls, created.length, emails.length], [calls, charges, 0]);
    } finally { beforeRestartAnswer = null; }
    await undoPause(store, paused.record.until + 60);
  }


  part("Worker cleanup cannot erase a replacement pause generation");
  for (const stage of ["missing", "by-hand", "after-provider"] as const) {
    createAnswer = "ok";
    const email = "pause-generation-" + stage + "@example.com", id = "sub_Generation" + stage.replaceAll("-", "");
    subs[id] = subscription(id);
    const store = await storeWith(email, "pg" + stage.replaceAll("-", ""), id);
    const paused = await pausePlan(store, 1, NOW);
    if (paused.kind !== "paused") throw new Error("Synthetic generation fixture failed");
    const ref = storeRef(store), key = `nl:pause:${ref}`, year = `nl:pause:last:${ref}`;
    const pipeline = pauseRedis.pipeline;
    const [old, annual] = await pipeline([["GET", key], ["GET", year]]);
    const replacement = JSON.stringify({ ...paused.record, until: paused.record.until + DAY });
    if (stage === "by-hand") await setSubscription(ref, { active: true, subscriptionId: "sub_GenerationManual", period: paidPeriod() });
    if (stage === "after-provider") await setSubscription(ref, { active: false });
    let changed = false;
    pauseRedis.pipeline = async commands => {
      if (!changed && stage === "missing" && commands.length === 1 && commands[0][0] === "EVAL" && commands[0][1] === PAUSE_OBSERVATION && commands[0][3] === key) {
        changed = true;
        await pipeline([["SET", key, replacement], ["ZADD", "nl:pause:due", paused.record.until + DAY, ref]]);
        return [[0]];
      }
      if (!changed && stage !== "missing" && commands.some(command => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:pause-worker-forget:v1"))) {
        changed = true;
        await pipeline([["SET", key, replacement], ["ZADD", "nl:pause:due", paused.record.until + DAY, ref]]);
      }
      return pipeline(commands);
    };
    emails.length = 0;
    try {
      const counts = await runBreaks(paused.record.until + 60);
      is("the replacement race was actually reached", changed, true);
      is("unacknowledged cleanup never announces restart or drop", [counts.restarted, counts.dropped, counts.failed, emails.length], [0, 0, 1, 0]);
      is("replacement raw and annual eligibility survive", await pipeline([["GET", key], ["GET", year]]), [replacement, annual]);
      is("replacement due score survives", await pipeline([["ZSCORE", "nl:pause:due", ref]]), [String(paused.record.until + DAY)]);
      is("the fixture changed its observed generation", old !== replacement, true);
    } finally {
      pauseRedis.pipeline = pipeline;
      await undoPause(store, paused.record.until + 2 * DAY);
    }
  }


  part("A notice completion cannot overwrite a newer pause");
  for (const change of ["replacement", "removed", "due-score", "unknown-ack", "extra-field"] as const) {
    const suffix = change.replaceAll("-", ""), email = "notice-generation-" + suffix + "@example.com", id = "sub_NoticeGeneration" + suffix;
    subs[id] = subscription(id);
    const store = await storeWith(email, "ng" + suffix, id);
    const paused = await pausePlan(store, 1, NOW);
    if (paused.kind !== "paused") throw new Error("Synthetic notice fixture failed");
    const ref = storeRef(store), key = `nl:pause:${ref}`, year = `nl:pause:last:${ref}`;
    const pipeline = pauseRedis.pipeline, at = paused.record.until - DAY;
    let replacement = JSON.stringify({ ...paused.record, until: paused.record.until + DAY });
    if (change === "extra-field") {
      replacement = JSON.stringify({ ...paused.record, futureEvidence: "must remain" });
    }
    const [annual] = await pipeline([["GET", year]]);
    let reached = false;
    pauseRedis.pipeline = async commands => {
      if (!reached && commands.some(c => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:pause-worker-notice:v1"))) {
        reached = true;
        if (change === "replacement") await pipeline([["SET", key, replacement], ["ZADD", "nl:pause:due", paused.record.until + DAY, ref]]);
        if (change === "extra-field") await pipeline([["SET", key, replacement]]);
        if (change === "removed") await pipeline([["DEL", key], ["ZREM", "nl:pause:due", ref]]);
        if (change === "due-score") await pipeline([["ZADD", "nl:pause:due", paused.record.until + DAY, ref]]);
        if (change === "unknown-ack") { await pipeline(commands); return []; }
      }
      return pipeline(commands);
    };
    emails.length = 0;
    try {
      is("unacknowledged notice marker is held", await runBreaks(at), { told: 0, restarted: 0, failed: 1, dropped: 0 });
      is("notice completion race reached", reached, true);
      is("only the already-sent synthetic notice exists", emails.length, 1);
      const [raw, last, due] = await pipeline([["GET", key], ["GET", year], ["ZSCORE", "nl:pause:due", ref]]);
      is("notice never changes annual eligibility", last, annual);
      if (change === "replacement" || change === "extra-field") is("new raw generation and future evidence retained", raw, replacement);
      if (change === "removed") is("removed pause and due are never recreated", [raw, due], [null, null]);
      if (change === "due-score") is("new due score is never overwritten", due, String(paused.record.until + DAY));
      if (change === "extra-field") {
        is("unknown future fields are held before another email", await runBreaks(at + 60), { told: 0, restarted: 0, failed: 1, dropped: 0 });
        is("future evidence does not cause repeated synthetic notices", emails.length, 1);
      }
      if (change === "unknown-ack") {
        is("lost ACK keeps the committed told marker", typeof raw === "string" && JSON.parse(raw).told, at);
        is("next pass does not send the committed notice again", await runBreaks(at + 60), { told: 0, restarted: 0, failed: 0, dropped: 0 });
        is("committed marker avoids a duplicate synthetic email", emails.length, 1);
      }
      if (change === "due-score") {
        let refused = false;
        try { await undoPause(store, paused.record.until + 2 * DAY); } catch { refused = true; }
        is("explicit stopped undo also preserves the changed due evidence", refused, true);
        is("refused explicit cleanup retains the same evidence",
          await pipeline([["GET", key], ["GET", year], ["ZSCORE", "nl:pause:due", ref]]),
          [raw, last, due]);
      }
    } finally {
      pauseRedis.pipeline = pipeline;
      // Fixture teardown is not a production undo: a deliberately mismatched
      // generation must now refuse that action rather than silently erase it.
      await pipeline([["DEL", key, year], ["ZREM", "nl:pause:due", ref]]);
    }
  }


  part("Funded restart source observation reads one bounded owner record without mutation");
  {
    const id="sub_BoundedPreflight01";
    subs[id]=subscription(id);
    const store=await storeWith("bounded-preflight@example.com","boundedpreflight",id),ref=storeRef(store);
    const pipeline=pauseRedis.pipeline;const calls:(string|number)[][]=[];let raw:unknown;
    pauseRedis.pipeline=async commands=>{
      calls.push(...commands);
      const result=await pipeline(commands);
      if(commands[0]?.[0]==="GETRANGE")raw=result[0];
      return result;
    };
    try{
      const current=await storeForRestartSource(ref);
      is("bounded current owner is readable",current?.subscriptionId,id);
      is("preflight is exactly one bounded command",[calls.length,calls[0]?.[0],calls[0]?.[2],calls[0]?.[3]],[1,"GETRANGE",0,MAX_STORE_BYTES]);
      if(typeof raw!=="string")throw Error("Synthetic bounded raw observation missing");
      for(const reply of [[],[null],["x".repeat(MAX_STORE_BYTES+1)],["é".repeat(Math.floor(MAX_STORE_BYTES/2)+1)],
          [JSON.stringify({...JSON.parse(raw),email:"foreign-preflight@example.com"})]]){
        pauseRedis.pipeline=async commands=>{calls.push(...commands);return reply;};
        is("unknown oversized or foreign preflight refuses",await storeForRestartSource(ref),null);
      }
      const sourceRaw=JSON.parse(raw) as Record<string,unknown>;
      for(const field of ["handle","statsId","subscriptionId","stripeCustomerId","tier","cycle","email","sid","subscriptionActive","extra"]){
        for(const value of [undefined,null,field==="subscriptionActive"?"false":field==="extra"?"false":{}]){
          const malformed={...sourceRaw,[field]:value};
          pauseRedis.pipeline=async()=>[JSON.stringify(malformed)];
          is("missing or malformed raw source never receives legacy defaults",await storeForRestartSource(ref),null);
        }
      }
      let reads=0;const accessor:unknown[]=[];
      Object.defineProperty(accessor,"0",{enumerable:true,get(){reads++;throw Error("unexpected reply getter");}});
      pauseRedis.pipeline=async()=>accessor;
      is("accessor acknowledgement cannot supply a current source",await storeForRestartSource(ref),null);
      is("preflight reply getter is never invoked",reads,0);
    }finally{pauseRedis.pipeline=pipeline;}
  }

  part("An unreadable store cannot erase a known pause");
  {
    const email="unreadable-pause-owner@example.com",id="sub_UnreadableOwner01";
    subs[id]=subscription(id);
    const store=await storeWith(email,"unreadablepauseowner",id);
    const set=await pausePlan(store,1,NOW);
    const until=set.kind==="paused"?set.record.until:0;
    const ref=storeRef(store),key=`nl:pause:${ref}`,year=`nl:pause:last:${ref}`;
    const pipeline=pauseRedis.pipeline;
    const beforeEvidence=await pipeline([["GET",key],["GET",year]]);
    for(const answer of ["missing","corrupt","empty","unavailable"] as const){
      let mutations=0;
      pauseRedis.pipeline=async(commands)=>{
        if(commands.length===1&&commands[0][0]==="GET"&&String(commands[0][1]).startsWith("nl:store:owner:")){
          if(answer==="unavailable")throw new Error("synthetic owner lookup unavailable");
          if(answer==="missing")return [null];
          if(answer==="corrupt")return ["{not-json"];
          return [];
        }
        mutations+=commands.filter(command=>!["GET","ZRANGEBYSCORE"].includes(String(command[0])) && !(command[0]==="EVAL"&&(command[1]===PAUSE_OBSERVATION||command[1]===PAUSE_DUE_OBSERVATION))).length;
        return pipeline(commands);
      };
      try{
        const before=created.length;emails.length=0;
        is("an unknown owner is retained for reconciliation",await runBreaks(until+60),{told:0,restarted:0,failed:1,dropped:0});
        is("unknown ownership performs no mutation, charge or notice",[mutations,created.length-before,emails.length],[0,0,0]);
        const [record,last,due]=await pipeline([["GET",key],["GET",year],["ZRANGEBYSCORE","nl:pause:due","-inf",String(until+60)]]);
        is("exact pause and annual evidence survive an unknown owner",[record,last],beforeEvidence);
        is("the due member survives an unknown owner",Array.isArray(due)&&due.includes(ref),true);
      }finally{pauseRedis.pipeline=pipeline;}
    }
    // A successful later read does not by itself start a replacement while
    // the original subscription is still active.
    is("restored ownership retains the existing active-plan guard",await runBreaks(until+60),{told:0,restarted:0,failed:1,dropped:0});
    await undoPause(store,NOW);
  }

  part("One unavailable pause record cannot abort the bounded batch");
  {
    const entries=[
      {email:"unavailable-pause-read@example.com",handle:"unavailablepauseread",id:"sub_UnavailablePause01"},
      {email:"following-pause-read@example.com",handle:"followingpauseread",id:"sub_FollowingPause01"},
    ];
    const owners: Awaited<ReturnType<typeof storeWith>>[]=[];
    let until=0;
    for(const entry of entries){
      subs[entry.id]=subscription(entry.id);
      const store=await storeWith(entry.email,entry.handle,entry.id);
      owners.push(store);
      const set=await pausePlan(store,1,NOW);
      if(set.kind!=="paused")throw new Error("Synthetic pause fixture could not be created");
      until=set.record.until;
    }
    const refs=owners.map(storeRef),original=pauseRedis.pipeline;
    const beforeEvidence=await original(refs.flatMap(ref=>[["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`]]));
    let followingOwnerReads=0;
    pauseRedis.pipeline=async commands=>{
      if(commands.length===1&&commands[0][0]==="EVAL"&&commands[0][1]===PAUSE_DUE_OBSERVATION)return [refs];
      if(commands.length===1&&commands[0][0]==="EVAL"&&commands[0][1]===PAUSE_OBSERVATION&&commands[0][3]===`nl:pause:${refs[0]}`)throw new Error("Synthetic unavailable pause record");
      if(commands.length===1&&commands[0][0]==="GET"&&String(commands[0][1]).startsWith("nl:store:owner:")){
        const reply=await original(commands);
        const owner=typeof reply[0]==="string"?JSON.parse(reply[0]):null;
        if(owner?.email===owners[1].email&&owner?.sid===owners[1].sid)followingOwnerReads++;
        return reply;
      }
      return original(commands);
    };
    try{
      const before=created.length;emails.length=0;
      is("unavailable pause is failed individually and the following active plan is also retained",await runBreaks(until+60),{told:0,restarted:0,failed:2,dropped:0});
      is("the next owner in the same bounded batch was actually read",followingOwnerReads,1);
      is("unknown pause does not trigger replacement charges or notices",[created.length-before,emails.length],[0,0]);
      is("neither store loses its exact pause or annual evidence",await original(refs.flatMap(ref=>[["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`]])),beforeEvidence);
      const [due]=await original([["ZRANGEBYSCORE","nl:pause:due","-inf","+inf"]]);
      is("both due members remain for reconciliation",Array.isArray(due)&&refs.every(ref=>due.includes(ref)),true);
    }finally{
      pauseRedis.pipeline=original;
      for(const store of owners)await undoPause(store,NOW);
    }
  }


  part("A funded pause keeps its source marker before the store becomes inactive");
  for(const fixture of [
    {suffix:"known",grant:"ctr_pause_source",metadata:{funding_grant:"ctr_pause_source"}},
    {suffix:"unknown",grant:null,metadata:{funding_review:"unknown-source"}},
    {suffix:"switched",grant:"ctr_pause_switch_source",metadata:{funding_grant:"ctr_previous_source",funding_pending_grant:"ctr_pause_switch_source",funding_pending_review:"review"}},
    {suffix:"pendingunknown",grant:null,metadata:{funding_grant:"ctr_previous_source",funding_pending_review:"review"}},
  ]){
    const {suffix,grant:sourceGrant}=fixture,email="funded-pause-"+suffix+"@example.com",id="sub_FundedPause"+suffix;
    subs[id]=subscription(id,{metadata:fixture.metadata});
    const initial=await storeWith(email,"fp"+suffix,id);
    if(!initial)throw new Error("Synthetic funded source store was not created");
    const ref=storeRef(initial);
    const store=await setSubscription(ref,{active:true,period:{...paidPeriod(),funded:true}});
    if(!store)throw new Error("Synthetic funded period was not saved");
    is("the source store initially has an explicit funded period",store.period?.funded,true);
    const set=await pausePlan(store,1,NOW);
    if(set.kind!=="paused")throw new Error("Synthetic funded pause was refused");
    is("provider funding remains an explicit versioned source marker",set.record.funding,{version:1,grantId:sourceGrant});
    is("the marker is read back from the durable pause",(await pauseOf(store))?.funding,set.record.funding);
    await setSubscription(ref,{active:false});
    const current=await storeForEmail(ref);
    is("the ordinary inactive store has no funded period",current?.period,null);
    const original=pauseRedis.pipeline;
    const evidence=await original([["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`]]);
    let ledgerCommands=0,ownerReads=0,mutations=0,ownerRanges=0,ownerGets=0;
    let rawOwner:unknown,overrideSource=false,sourceThrows=false,sourceReply:unknown[]=[];
    pauseRedis.pipeline=async commands=>{
      ledgerCommands+=commands.filter(command=>command.some(value=>value==="nl:contract-reserve:v1")).length;
      const ownerCommands=commands.filter(command=>["GET","GETRANGE"].includes(String(command[0]))&&String(command[1]).startsWith("nl:store:owner:"));
      ownerReads+=ownerCommands.length;
      ownerRanges+=ownerCommands.filter(command=>command[0]==="GETRANGE").length;
      ownerGets+=ownerCommands.filter(command=>command[0]==="GET").length;
      mutations+=commands.filter(command=>!["GET","GETRANGE","ZRANGEBYSCORE"].includes(String(command[0])) && !(command[0]==="EVAL"&&(command[1]===PAUSE_OBSERVATION||command[1]===PAUSE_DUE_OBSERVATION))).length;
      if(overrideSource&&ownerCommands.length){
        if(sourceThrows)throw Error("synthetic funded owner read unavailable");
        return sourceReply;
      }
      const reply=await original(commands);
      if(ownerCommands.some(command=>command[0]==="GETRANGE"))rawOwner=reply[0];
      return reply;
    };
    try{
      for(const offset of [-2*DAY,-DAY,-60]){
        const calls=providerCalls,before=created.length,ownersBefore=ownerReads,writesBefore=mutations;emails.length=0;
        is("a funded notice window stays held before legacy email and told replacement",await runBreaks(set.record.until+offset),{told:0,restarted:0,failed:1,dropped:0});
        is("held notice performs no owner lookup, write, provider call, ledger work or email",[ownerReads-ownersBefore,mutations-writesBefore,providerCalls-calls,created.length-before,ledgerCommands,emails.length],[0,0,0,0,0,0]);
        is("repeated funded notice reads preserve the exact raw pause and annual evidence",await original([["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`]]),evidence);
        const [due]=await original([["ZRANGEBYSCORE","nl:pause:due","-inf","+inf"]]);
        is("held notice retains the due member for later reconciliation",Array.isArray(due)&&due.includes(ref),true);
      }
      for(const offset of [60,4*DAY]){
        const calls=providerCalls,before=created.length,rangesBefore=ownerRanges,getsBefore=ownerGets;emails.length=0;
        is("the closed integrated funded branch stays unresolved beyond the legacy retry window",await runBreaks(set.record.until+offset),{told:0,restarted:0,failed:1,dropped:0});
        is("funded due worker uses one bounded source read and no unbounded owner GET",[ownerRanges-rangesBefore,ownerGets-getsBefore],[1,0]);
        is("coverage refuses before ensurePrice, provider GET/POST, grant or intent IO",[providerCalls-calls,created.length-before,ledgerCommands,emails.length],[0,0,0,0]);
        is("exact pause and annual evidence remain",await original([["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`]]),evidence);
        const [due]=await original([["ZRANGEBYSCORE","nl:pause:due","-inf","+inf"]]);
        is("funded due ownership is retained",Array.isArray(due)&&due.includes(ref),true);
        is("unresolved funded restart cannot authorize content closing",await onBreak(ref,set.record.until+offset),true);
      }
      if(suffix==="known"){
        if(typeof rawOwner!=="string")throw Error("Synthetic funded owner source was not observed");
        const owner=JSON.parse(rawOwner) as Record<string,unknown>;
        let getters=0;
        const accessor:unknown[]=[];
        Object.defineProperty(accessor,"0",{enumerable:true,get(){getters++;throw Error("source reply getter must not run");}});
        const malformed:unknown[][]=[[],[null],["{"],["x".repeat(MAX_STORE_BYTES+1)],["é".repeat(Math.floor(MAX_STORE_BYTES/2)+1)],accessor,
          [JSON.stringify({...owner,email:"foreign-funded-worker@example.com"})]];
        for(const field of ["handle","statsId","subscriptionId","stripeCustomerId","tier","cycle","email","sid","subscriptionActive","extra"]){
          malformed.push([JSON.stringify({...owner,[field]:undefined})]);
        }
        overrideSource=true;
        for(const reply of malformed){
          sourceReply=reply;const calls=providerCalls,writes=mutations,ranges=ownerRanges;emails.length=0;
          is("unknown funded owner source is retained before restart admission",await runBreaks(set.record.until+60),{told:0,restarted:0,failed:1,dropped:0});
          is("unknown source performs one bounded read and no subsequent provider, ledger, write or email",[ownerRanges-ranges,providerCalls-calls,ledgerCommands,mutations-writes,emails.length],[1,0,0,0,0]);
          is("unknown source preserves exact pause and annual evidence",await original([["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`]]),evidence);
        }
        sourceThrows=true;const calls=providerCalls,writes=mutations;
        is("transport-unknown funded owner source stays held",await runBreaks(set.record.until+60),{told:0,restarted:0,failed:1,dropped:0});
        is("transport-unknown source performs no follow-on mutation or provider work",[providerCalls-calls,mutations-writes,ledgerCommands,emails.length,getters],[0,0,0,0,0]);
        overrideSource=false;sourceThrows=false;
        const [due]=await original([["ZRANGEBYSCORE","nl:pause:due","-inf","+inf"]]);
        is("all source refusals retain the funded due member",Array.isArray(due)&&due.includes(ref),true);
      }
      const raw=JSON.parse(evidence[0] as string);
      for(const funding of [null,{version:2,grantId:sourceGrant},{version:1,grantId:"foreign"}]){
        await original([["SET",`nl:pause:${ref}`,JSON.stringify({...raw,funding})]]);
        const calls=providerCalls;
        is("malformed funded evidence is unreadable, never a legacy restart",await runBreaks(set.record.until+60),{told:0,restarted:0,failed:1,dropped:0});
        is("malformed evidence performs no provider operation",providerCalls-calls,0);
      }
      await original([["SET",`nl:pause:${ref}`,evidence[0] as string]]);
    }finally{
      pauseRedis.pipeline=original;
      let refused = false;
      try { await undoPause(store,set.record.until+4*DAY); } catch { refused = true; }
      is("funded stopped cleanup needs its own settlement protocol", refused, true);
      is("funded cleanup refusal keeps exact source evidence",
        await original([["GET",`nl:pause:${ref}`],["GET",`nl:pause:last:${ref}`]]), evidence);
      await original([["DEL",`nl:pause:${ref}`,`nl:pause:last:${ref}`],["ZREM","nl:pause:due",ref]]);
    }
  }

  part("A store that started again by hand");
  {
    subs.sub_ByHand000001 = subscription("sub_ByHand000001");
    const store = await storeWith("byhand@example.com", "byhandstore", "sub_ByHand000001");
    const set = await pausePlan(store, 1, NOW);
    const until = set.kind === "paused" ? set.record.until : 0;
    await setSubscription("byhand@example.com", { subscriptionId: "sub_OtherOne00001", active: true, period: paidPeriod() });
    const before = created.length;
    const counts = await runBreaks(until + 60);
    is("is left alone", [counts.dropped, created.length - before], [1, 0]);
  }

  part("Funded immediate confirmation cannot use the unreserved company email meter");
  {
    const store = await storeWith("pause-notice-admission@example.com", "pausenoticeadmission", "sub_PauseNoticeAdmission");
    const record = {subscription:"sub_PauseNoticeAdmission",customer:"cus_TestPause0001",paymentMethod:"pm_TestCard00001",
      tier:"creator" as const,from:NOW+DAY,until:NOW+31*DAY,told:0};
    emails.length=0;
    await confirmPause(store,record);
    is("the existing legacy transactional confirmation is still sent",emails.length,1);
    let getters=0;
    const fundingGetter=Object.defineProperty({...record},"funding",{get(){getters++;throw new Error("funding getter must not run");}});
    const periodGetter=Object.defineProperty({...store},"period",{get(){getters++;throw new Error("period getter must not run");}});
    const fundedGetter=Object.defineProperty({...paidPeriod()},"funded",{get(){getters++;throw new Error("funded getter must not run");}});
    const cases=[
      {store,record:{...record,funding:{version:1 as const,grantId:"ctr_notice_source"}}},
      {store,record:{...record,funding:{version:1 as const,grantId:null}}},
      {store,record:{...record,funding:null}},
      {store,record:{...record,funding:undefined}},
      {store,record:fundingGetter},
      {store:periodGetter,record},
      {store:{...store,period:{...paidPeriod(),funded:true as const}},record},
      {store:{...store,period:fundedGetter},record},
    ];
    const original=pauseRedis.pipeline;let redisCalls=0;
    pauseRedis.pipeline=async commands=>{redisCalls++;return original(commands);};
    try {
      for(const candidate of cases){
        const before=providerCalls;emails.length=0;
        await confirmPause(candidate.store,candidate.record as Parameters<typeof confirmPause>[1]);
        is("funded, unknown or accessor evidence sends no unreserved confirmation",[emails.length,providerCalls-before,redisCalls],[0,0,0]);
      }
      is("notice admission does not invoke funding or period accessors",getters,0);
    }finally{pauseRedis.pipeline=original;}
  }


  part("Due selection bounds returned bytes without deleting malformed evidence");
  {
    const key="nl:pause:due",original=pauseRedis.pipeline;
    const [prior]=await original([["ZRANGEBYSCORE",key,"-inf","+inf","WITHSCORES"]]);
    try{
      await original([["DEL",key]]);
      is("missing due index is an explicit empty batch",await original([["EVAL",PAUSE_DUE_OBSERVATION,1,key,NOW]]),[[]]);
      for(const ref of ["x".repeat(1280),"é".repeat(640)]){
        await original([["DEL",key],["ZADD",key,NOW,ref],["EXPIRE",key,600]]);
        is("ASCII and UTF8 1280byte boundary remains exact",await original([["EVAL",PAUSE_DUE_OBSERVATION,1,key,NOW]]),[[ref]]);
      }
      for(const ref of ["","x".repeat(1281),"é".repeat(641)]){
        await original([["DEL",key],["ZADD",key,NOW,ref],["EXPIRE",key,600]]);
        is("oversize member yields no member payload",await original([["EVAL",PAUSE_DUE_OBSERVATION,1,key,NOW]]),[[-1]]);
        is("malformed member remains stored",await original([["ZRANGEBYSCORE",key,"-inf","+inf"]]),[[ref]]);
      }
      await original([["DEL",key],["SET",key,"foreign"]]);
      is("wrong due type remains unreadable",await original([["EVAL",PAUSE_DUE_OBSERVATION,1,key,NOW]]),[[-1]]);
      is("wrong due type is retained",await original([["GET",key]]),["foreign"]);
      let calls=0;
      pauseRedis.pipeline=async commands=>{calls+=commands.length;return original(commands);};
      for(const time of [NaN,Infinity,-1,1.5,1_000_000_000_000]){
        is("invalid due clock cannot authorize any IO",await runBreaks(time),{told:0,restarted:0,failed:1,dropped:0});
      }
      is("invalid clocks consume no Redis/provider request",calls,0);
    }finally{
      pauseRedis.pipeline=original;
      await original([["DEL",key]]);
      if(Array.isArray(prior))for(let i=0;i<prior.length;i+=2)await original([["ZADD",key,String(prior[i+1]),String(prior[i])]]);
    }
  }


  part("Lost due observation and accessor replies never start per-store work");
  {
    const original=pauseRedis.pipeline;let extra=0,getters=0;
    const refs:string[]=[];
    Object.defineProperty(refs,"0",{get(){getters++;return"synthetic@example.com";},enumerable:true});
    try{
      for(const mode of ["lost","accessor"]){
        pauseRedis.pipeline=async commands=>{
          if(commands.length===1&&commands[0][0]==="EVAL"&&commands[0][1]===PAUSE_DUE_OBSERVATION){
            if(mode==="lost")throw new Error("Synthetic lost read acknowledgement");
            return [refs];
          }
          extra+=commands.length;return original(commands);
        };
        const before=providerCalls;emails.length=0;
        is("unknown due observation is held without throwing or effects",await runBreaks(NOW),{told:0,restarted:0,failed:1,dropped:0});
        is("unknown due reply has no per-store/provider/mail operation",[extra,providerCalls-before,emails.length],[0,0,0]);
      }
      is("due reply accessors are never invoked",getters,0);
    }finally{pauseRedis.pipeline=original;}
  }


  part("Due acknowledgement bounds are checked before visiting members");
  {
    const original=pauseRedis.pipeline;
    let memberReads=0,extra=0;
    const oversized=new Proxy(Array.from({length:201},(_,i)=>"synthetic-"+i+"@example.com"),{
      getOwnPropertyDescriptor(target,key){
        if(typeof key === "string" && String(Number(key)) === key)memberReads++;
        return Reflect.getOwnPropertyDescriptor(target,key);
      },
    });
    Object.getOwnPropertyDescriptor(oversized,"0");
    is("instrumented ACK observes actual member descriptor reads",memberReads,1);
    memberReads=0;
    const replies:unknown[]=[[oversized],[["x".repeat(1281)]],[["é".repeat(641)]],
      [["same@example.com","same@example.com"]],[new Array(1)],[["ok@example.com"],[]]];
    try{
      for(const reply of replies){
        pauseRedis.pipeline=async commands=>{
          if(commands.length===1&&commands[0][0]==="EVAL"&&commands[0][1]===PAUSE_DUE_OBSERVATION)return reply as unknown[];
          extra+=commands.length;return original(commands);
        };
        const before=providerCalls;emails.length=0;
        is("oversized, duplicate, sparse or malformed due ACK is held",await runBreaks(NOW),{told:0,restarted:0,failed:1,dropped:0});
        is("rejected due ACK starts no owner, provider, email or cleanup work",[extra,providerCalls-before,emails.length],[0,0,0]);
      }
      is("over-limit batch is rejected before visiting any member",memberReads,0);
    }finally{pauseRedis.pipeline=original;}
  }


  part("Pause record acknowledgement bounds precede traversal and retain funded evidence");
  {
    const email="bounded-pause-ack@example.com",id="sub_BoundedAck01";
    subs[id]=subscription(id);
    const store=await storeWith(email,"boundedpauseack",id);
    const set=await pausePlan(store,1,NOW);
    if(set.kind!=="paused")throw new Error("Synthetic pause setup refused");
    const ref=storeRef(store),key=`nl:pause:${ref}`;
    const raw=JSON.stringify({...set.record,funding:{version:1,grantId:null}});
    const original=pauseRedis.pipeline;
    await original([["SET",key,raw]]);
    let outerReads=0,innerReads=0,getters=0,extra=0;
    const outer=new Proxy(new Array(2),{
      getOwnPropertyDescriptor(target,key){
        if(typeof key==="string"&&String(Number(key))===key)outerReads++;
        return Reflect.getOwnPropertyDescriptor(target,key);
      },
    });
    const inner=new Proxy(new Array(3),{
      getOwnPropertyDescriptor(target,key){
        if(typeof key==="string"&&String(Number(key))===key)innerReads++;
        return Reflect.getOwnPropertyDescriptor(target,key);
      },
    });
    Object.getOwnPropertyDescriptor(outer,"0");Object.getOwnPropertyDescriptor(inner,"0");
    is("outer and inner ACK instrumentation observes descriptor reads",[outerReads,innerReads],[1,1]);
    outerReads=0;innerReads=0;
    const accessor:unknown[]=[1,"unused"];
    Object.defineProperty(accessor,"1",{get(){getters++;throw new Error("pause raw getter must not run");}});
    const symbolAck:unknown[]=[1,raw];Object.defineProperty(symbolAck,Symbol("synthetic"),{value:1});
    const replies:unknown[]=[outer,[inner],[[1,"x".repeat(4097)]],[[1,"é".repeat(2049)]],
      [accessor],[new Array(2)],[symbolAck],[[0,raw]],[[1,{}]]];
    try{
      for(const reply of replies){
        extra=0;
        pauseRedis.pipeline=async commands=>{
          if(commands.length===1&&commands[0][0]==="EVAL"&&commands[0][1]===PAUSE_DUE_OBSERVATION)return [[ref]];
          if(commands.length===1&&commands[0][0]==="EVAL"&&commands[0][1]===PAUSE_OBSERVATION)return reply as unknown[];
          extra+=commands.length;return original(commands);
        };
        const calls=providerCalls;emails.length=0;
        is("malformed record ACK is unknown rather than missing",await pauseOf(store),null);
        is("unknown record ACK keeps creator content protected",await onBreak(ref,set.record.until+60),true);
        is("due worker retains unknown funded pause",await runBreaks(set.record.until+60),{told:0,restarted:0,failed:1,dropped:0});
        is("rejected record ACK starts no owner/provider/email/cleanup",[extra,providerCalls-calls,emails.length],[0,0,0]);
        const [retained,due,last]=await original([["GET",key],["ZRANGEBYSCORE","nl:pause:due","-inf","+inf"],["EXISTS",`nl:pause:last:${ref}`]]);
        is("funded record, due membership and annual marker remain",[retained,Array.isArray(due)&&due.includes(ref),last],[raw,true,1]);
      }
      is("invalid cardinalities are rejected before visiting their entries",[outerReads,innerReads],[0,0]);
      is("raw ACK accessor is never invoked",getters,0);
    }finally{pauseRedis.pipeline=original;}
  }

  done();
}

main();
