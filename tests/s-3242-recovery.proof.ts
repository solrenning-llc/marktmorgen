/** S SECOND financial review: fixture/helpers adapted from C6 balance-exact test; independent recovery and cost boundary oracles. */
/**
 * CX-123 rule 24 (audit R24 round 6, finding 1): on the closing day (giveBackUnused with final: true) the creator's
 * Stripe balance and the charge's settlement cost are read in their exact shape. A GET /balance in another shape, a
 * row of it that does not read, or a balance transaction / charge currency that does not read is unknown: the member
 * is counted failed and tried again (lib/plan-closing.ts holds the closing while `failed > 0`), never recorded as a
 * final "short" (which sends the "the creator's balance did not cover it" letter) and never refunded on a guess.
 * A confirmed empty balance stays short, and the healthy paths still refund.
 */
import { giveBackUnused, unusedRows, settledCost } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const SUB = "sub_r24balance";
const INTENT = "pi_r24balance";
const healthyCharge = { id: "ch_r24balance", amount: 1000, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null };
let balance: unknown = null;
let charge: Record<string, unknown> = healthyCharge;
let posts = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json(balance);
  if (path === `/payment_intents/${INTENT}`) return Response.json({ id: INTENT, object: "payment_intent", latest_charge: charge });
  if (path === "/refunds" && init?.method === "POST") {
    posts += 1;
    const body = new URLSearchParams(String(init.body));
    return Response.json({ id: "re_r24balance", object: "refund", amount: Number(body.get("amount")), currency: "usd", payment_intent: INTENT, status: "succeeded" });
  }
  if (path === "/refunds") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

async function run(label: string, reply: unknown, chargeReply: Record<string, unknown> = healthyCharge) {
  redis.clear();
  posts = 0;
  balance = reply;
  charge = chargeReply;
  const email = `r24bal-${label}@example.com`;
  await claimHandle(email, `r24bal${label}`, "Balance fixture", "");
  const shop = (await storeForEmail(email))!;
  const seller: Store = { ...shop, stripeAccountId: "acct_r24bal" };
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: "in_r24balance", pi: INTENT, amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 20, "rcalls", 10],
  ]);
  const out = await giveBackUnused(seller, DAY, { final: true });
  const [raw] = await redis.pipeline([["HGET", paidKey(folder), SUB]]);
  const saved = JSON.parse(String(raw)) as { r?: string; f?: number };
  return { out, saved, posts, remaining: (await unusedRows(seller, DAY)).length };
}

const usd = (amount: unknown, currency: unknown = "usd") => ({ amount, currency, source_types: { card: amount } });


async function main() {
 process.env.STRIPE_SECRET_KEY="sk_test_r24_balance_synthetic_only";
 const bad=await run("srecover",{object:"balance",available:[usd("100000")]});
 is("unknown balance does not settle or refund",typeof bad.out==="object"?[bad.out.failed,bad.out.short.length,bad.saved.r??null,bad.saved.f??null,bad.posts]:bad.out,[1,0,null,null,0]);
 const shop=(await storeForEmail("r24bal-srecover@example.com"))!;
 const seller:Store={...shop,stripeAccountId:"acct_r24bal"};
 const folder=await storeFolder(seller.email);
 is("unknown balance consumes none of reserved call budget",await redis.pipeline([["HMGET",workKey(folder),"calls","rcalls"]]),[["20","10"]]);
 balance={object:"balance",available:[usd(100000)]};
 const recovered=await giveBackUnused(seller,DAY,{final:true});
 is("same unsettled payment recovers once after healthy read",typeof recovered==="object"?[recovered.done.length,recovered.failed,posts]:recovered,[1,0,1]);
 const again=await giveBackUnused(seller,DAY,{final:true});
 is("healthy repeat does not ask for a second refund",typeof again==="object"?[again.done.length,again.failed,posts]:again,[0,0,1]);
 const negative=await run("snegative",{object:"balance",available:[usd(-1)]});
 is("confirmed negative balance legitimately stays short",typeof negative.out==="object"?[negative.out.short.length,negative.out.failed,negative.posts,negative.saved.f]:negative.out,[1,0,0,1]);
 const missing=await run("smissing",{object:"balance",available:[usd(100000,"eur")]});
 is("confirmed absent currency follows existing null-transaction policy",typeof missing.out==="object"?[missing.out.short.length,missing.out.failed,missing.posts]:missing.out,[1,0,0]);
 is("settlement rounds an actual fractional cent upward",settledCost(501,{...healthyCharge,balance_transaction:{amount:901,currency:"eur"}}),{cur:"eur",amount:452});
 for(const [label,value] of [["fractional",0.5],["unsafe",2**53],["negative",-1]] as const){
  let threw=false;try{settledCost(500,{...healthyCharge,balance_transaction:{amount:value,currency:"eur"}});}catch{threw=true;}
  is(`settlement cost ${label} is unknown`,threw,true);
 }
 const invalid=await run("sbtarray",{object:"balance",available:[usd(100000)]},{...healthyCharge,balance_transaction:[]});
 is("array transaction never permits final short or refund",typeof invalid.out==="object"?[invalid.out.failed,invalid.out.short.length,invalid.posts,invalid.saved.r??null]:invalid.out,[1,0,0,null]);
 done();
}
void main();
