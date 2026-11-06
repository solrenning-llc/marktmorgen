/**
 * Independent J reproduction; settlement issue first reported by Revisor 1. Synthetic only.
 * Redis answers the PayPal payouts read in an unknown shape (rule 24): never
 * read as "this call wrote it", "not connected" or "store gone".
 *
 *   - settling: a SET NX on a paid item that answers anything but "OK" or
 *     null books nothing, so the affiliate book is never counted twice, and
 *     the item stays on its way for the next run;
 *   - the daily job: a store whose record could not be read stays in the
 *     settle set (only a confirmed absent store leaves it);
 *   - the creator's PayPal link: an unknown answer is not "not connected"
 *     and not "auto-pay off".
 *
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com, the Redis stub.
 */
import { connectPayPal, onTheirWay, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { addPayout, bookedPayouts, readBook } from "@/lib/affiliates";
import { dataKey } from "@/lib/store-data";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsexact01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";
let itemStatus: Record<string, string> = {};
const created: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    created.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING" } }, 201);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+ABC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const items = created[Number(batch.slice(5, -3)) - 1].items as { sender_item_id: string }[];
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: items.map((item, i) => ({
        payout_item_id: `ITEM${batch}${i}`,
        transaction_status: itemStatus[item.sender_item_id] ?? "PENDING",
        payout_item: { sender_item_id: item.sender_item_id },
      })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidexact01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(store: Store): Promise<void> {
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
/** Answers `reply` (after running the commands, when `run`) for a pipeline `match` picks; the rest reach the stub. */
async function intercepted<T>(match: (commands: Commands) => boolean, reply: (commands: Commands) => Promise<unknown[]>, body: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => (match(commands) ? reply(commands) : real(commands))) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = real;
  }
}
async function rejects(body: () => Promise<unknown>): Promise<boolean> {
  try {
    await body();
    return false;
  } catch {
    return true;
  }
}
const paidTo = async (store: Store) => (await readBook(store)).rows.find((r) => r.affiliate.id === "aaaaaaaaaaaa")?.paid ?? -1;
const itemSet = (commands: Commands) => commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:pp:item:");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY="sk_test_j2844_return_only";
  console.error=()=>{};
  const store=shop(),ledger=`nl:aff:${STATS}:payouts`;
  const roomKey=dataKey(store);if(!roomKey)throw new Error("room key missing");
  async function sent(){await seed(store);const sent=await payWithPayPal(store);if(!sent.ok)throw new Error("fixture batch failed");itemStatus={aaaaaaaaaaaa:"SUCCESS"};}
  const roomWrite=(c:Commands)=>c[0]?.[0]==="EVAL"&&String(c[0]?.[1]).includes("marktmorgen:store-data:v1")&&c[0].includes("aff:payouts");
  const ledgerWrite=(c:Commands)=>c[0]?.[0]==="HSETNX"&&c[0]?.[1]===ledger;
  for(const [barrier,match] of [["room",roomWrite],["ledger",ledgerWrite],["mark",itemSet]] as const){
    for(const applied of [false,true]){
      part(`${barrier} / ${applied?"applied ACK lost":"not applied, unknown reply"}`);
      await sent();let injections=0;
      const refused=await intercepted(match,async c=>{injections++;if(applied)await real(c);return [];},()=>rejects(()=>settlePayPal(store)));
      is("one unknown barrier refuses settlement",[injections,refused],[1,true]);
      is("the recipient remains reserved until a known retry",[...await onTheirWay(store)],["aaaaaaaaaaaa"]);
      const retry=await settlePayPal(store);
      const paid=await paidTo(store),entries=redis.run(["HLEN",ledger]);
      is("healthy retry leaves one exact payout and nothing pending",[paid,entries,[...await onTheirWay(store)]],[3000,1,[]]);
      const second=await payWithPayPal(store);
      is("no second synthetic provider batch is dispatched",[second.ok,created.length],[false,1]);
      console.log("BARRIER",JSON.stringify({barrier,applied,retry,paid,entries,room:redis.run(["HGET",roomKey,"aff:payouts"])}));
    }
  }
  part("Two actual concurrent settlements write one deterministic ledger entry");
  await sent();await Promise.all([settlePayPal(store),settlePayPal(store)]);
  is("concurrent settling books the item only once",[await paidTo(store),redis.run(["HLEN",ledger])],[3000,1]);
  const concurrencyAgain=await payWithPayPal(store);
  is("concurrent settling never dispatches another batch",[concurrencyAgain.ok,created.length],[false,1]);

  const ledgerRead=(c:Commands)=>c.length===1&&c[0][0]==="HGETALL"&&c[0][1]===ledger;
  for(const corrupt of [false,true]){
    part(`Real legacy random-id payout / ${corrupt?"unreadable JSON reply":"healthy migration"}`);
    await sent();
    await addPayout(store,{aff:"aaaaaaaaaaaa",cents:3000,currency:"usd",date:"2026-11-01",reference:"PayPal ITEMBATCH1ABC0"});
    // A real legacy writer produced the row. Only its HGETALL response is damaged;
    // the durable legacy payout remains intact and counted by the actual book.
    let reads=0;
    const refused=await intercepted(ledgerRead,async c=>{
      reads++;const reply=await real(c);if(!corrupt)return reply;
      const flat=reply[0];if(!Array.isArray(flat)||flat.length!==2)throw new Error("legacy fixture invalid");
      return [[flat[0],"{"]];
    },()=>rejects(()=>settlePayPal(store)));
    const paid=await paidTo(store),entries=redis.run(["HLEN",ledger]);
    is("legacy ledger is read once and unknown JSON is refused",[reads,refused],[1,corrupt]);
    is("legacy money is never counted a second time",[paid,entries],[3000,1]);
    console.log("LEGACY",JSON.stringify({corrupt,refused,paid,entries,away:[...await onTheirWay(store)]}));
  }
  part("A deterministic field is not proof of a readable booked payout");
  await sent();await settlePayPal(store);
  const refused=await intercepted(ledgerRead,async c=>{
    const reply=await real(c);const flat=reply[0];
    if(!Array.isArray(flat)||flat.length!==2)throw new Error("deterministic fixture invalid");
    return [[flat[0],"{"]];
  },()=>rejects(()=>bookedPayouts(store)));
  is("malformed deterministic row is unknown instead of booked",refused,true);
  done();
}
void main();
