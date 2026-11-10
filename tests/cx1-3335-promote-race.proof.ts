/**
 * The open-batch writes around a PayPal payout batch, each read exactly
 * (CX-123 rule 24, Claude 5, 09/11/2026; inventory of tolerant writes, lines
 * 301 and 398 of lib/paypal-payouts.ts).
 *
 * 1. PayPal named the batch and it is held under its id, but taking the "?"
 *    entry away failed. The same people were then counted twice (under the id
 *    and as "being checked"), and the settling sent the creator's money request
 *    to PayPal again, relying on PayPal alone not to make a second batch. The
 *    batch held under its id now names the request it came from, and the "?"
 *    entry it left is dropped without asking PayPal anything.
 * 2. The "?" entry could not be confirmed written (a reply of another shape, or
 *    no reply at all after Redis may have applied it). The press used to say
 *    "Nothing was sent" while the entry could still be there, and the daily
 *    settling then sent the batch. Now "Nothing was sent" is said only when the
 *    entry is confirmed gone; otherwise the press says the batch may still go.
 * 3. PayPal refused the batch (its balance, say), and taking the "?" entry away
 *    was not confirmed (pre-review of 09/11/2026). The press said "nothing was
 *    sent" and the payday email "Nothing left your PayPal", and the daily
 *    settling then sent the same request again, which PayPal could pay. The same
 *    rule now holds there: the press says the batch may still go.
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com.
 */
import { readFileSync } from "node:fs";
import { connectPayPal, onTheirWay, payoutUnknownMonth, paypalChecks, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { autoPayEmail } from "@/lib/affiliate-payday";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statswex01";
const OPEN = `nl:pp:open:${STATS}`;
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";
/** Every money request PayPal received, and the batches it made: one per PayPal-Request-Id, as PayPal does. */
let posts = 0;
/** When true, PayPal refuses the next money request for its balance (a 422 that names its error), and makes nothing. */
let refuseNext = false;
/** When true, PayPal refuses every token request (it is down), so the settling has no way to read a batch. */
let tokenDown = false;
const batches = new Map<string, string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token" && tokenDown) return json({ name: "INTERNAL_SERVICE_ERROR" }, 500);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    posts += 1;
    if (refuseNext) {
      refuseNext = false;
      return json({ name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds." }, 422);
    }
    const key = String((init.headers as Record<string, string>)["PayPal-Request-Id"] ?? "");
    if (!batches.has(key)) batches.set(key, `BATCH${batches.size + 1}WEX`);
    return json({ batch_header: { payout_batch_id: batches.get(key), batch_status: "PENDING" } }, 201);
  }
  const read = /^\/v1\/payments\/payouts\/([A-Z0-9]+)$/.exec(url.pathname);
  if (read && [...batches.values()].includes(read[1])) {
    return json({
      batch_header: { batch_status: "SUCCESS" },
      items: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"].map((aff) => ({ payout_item: { sender_item_id: aff }, transaction_status: "SUCCESS", payout_item_id: `ITEM${read[1]}${aff.slice(0, 4).toUpperCase()}` })),
      total_pages: 1,
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidwritesexact01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd", email: "owner@example.com",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(store: Store): Promise<void> {
  redis.clear();
  posts = 0;
  batches.clear();
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:people`, "bbbbbbbbbbbb", person("bbbbbbbbbbbb", "tom@example.com", "tom")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", "bbbbbbbbbbbb", 5000)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
/** Runs `body` with one kind of pipeline answered by `fault` instead of Redis, the first time only. */
async function withFault<T>(match: (commands: Commands) => boolean, fault: (commands: Commands) => Promise<unknown[]>, body: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  let hit = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!hit && match(commands)) {
      hit = true;
      return fault(commands);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return { value: await body(), hit };
  } finally {
    redis.pipeline = real;
  }
}
const isUnknownDelete = (commands: Commands) => commands[0]?.[0] === "HDEL" && commands[0][1] === OPEN && String(commands[0][2]).startsWith("?");
const isUnknownWrite = (commands: Commands) => commands[0]?.[0] === "HSET" && commands[0][1] === OPEN && String(commands[0][2]).startsWith("?");
const openFields = async () => {
  const [all] = await real([["HGETALL", OPEN]]);
  return (Array.isArray(all) ? all.filter((_, i) => i % 2 === 0) : Object.keys((all ?? {}) as object)).map(String).sort();
};

/** CX1-only real writer/settle interleaving; fixture above is derived from the author's test. */
async function main(): Promise<void> {
 process.env.STRIPE_SECRET_KEY="sk_test_paypal_writes_exact_only";
 const store=shop();await seed(store);
 const initial=await withFault(commands=>commands[0]?.[0]==="HSET"&&commands[0][1]===OPEN&&!String(commands[0][2]).startsWith("?"),async()=>["QUEUED"],()=>payWithPayPal(store));
 // Corrected fixture premise, justified in the channel before this change: PayPal DID name the accepted batch.
 // promoteBatch failing keeps the '?' record; payWithPayPal still reports that known provider acceptance.
 is('the first provider-accepted batch is known despite an unconfirmed local promotion',initial.value.ok?[initial.value.batch,initial.value.people]:initial.value.reason,['BATCH1WEX',2]);
 const [field]=(await openFields());
 const [raw]=await real([["HGET",OPEN,field]]);
 let reads=0;
 redis.pipeline=async commands=>{
  if(commands.length===1&&commands[0][0]==="HGETALL"&&commands[0][1]===OPEN){
   reads++;
   if(reads===2){
    // Another run promotes the exact same request after the initial snapshot and before the locked reread.
    // Its HDEL is not applied, leaving the old '?' entry beside the correctly named batch.
    const held={...JSON.parse(String(raw)),s:field.slice(1)};
    await real([["HSET",OPEN,[...batches.values()][0],JSON.stringify(held)]]);
   }
  }
  return real(commands);
 };
 let result:Awaited<ReturnType<typeof settlePayPal>>;
 try{result=await settlePayPal(store);}finally{redis.pipeline=real;}
 is('the second read really met the concurrent promotion',reads>=2,true);
 is('no second money request for a known held batch',[posts,result.waiting],[1,2]);
 const healed=await settlePayPal(store);
 is('later cleanup settles both recipients without a second send',[posts,healed.paid,healed.waiting,await openFields()],[1,2,0,[]]);
 done();
}
void main();
