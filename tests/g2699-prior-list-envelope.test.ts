// Codex G's proof on #2699 (codex/g-review-2699-prior-list-return 59a36070), kept as a permanent test with credit.
// Codex G's proof on #2699 (codex/g-review-2699-refund-schema-return dca2f156), kept as a permanent test with credit.
import { giveBackUnused, unusedRows } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const SUB = "sub_g2699refund";
const INTENT = "pi_g2699refund";
let response: Record<string, unknown> = {};
const listRows: Record<string, unknown>[] = [];
let listEnvelope:Record<string,unknown>|null=null;
let posts = 0;
let refunded = 0;
let apply = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  if (path === `/payment_intents/${INTENT}`) return Response.json({ id: INTENT, amount: 1000, currency: "usd", latest_charge: { id: "ch_g2699refund", amount: 1000, currency: "usd", amount_refunded: refunded, disputed: false, balance_transaction: null } });
  if (path === "/refunds" && init?.method === "POST") {
    posts += 1;
    const body = new URLSearchParams(String(init.body));
    is("request is for the real fixture payment and exactly its unused 500 cents", [body.get("payment_intent"), body.get("amount")], [INTENT, "500"]);
    if (apply) refunded += Number(body.get("amount"));
    return Response.json(response);
  }
  if (path === "/refunds") return Response.json(listEnvelope??{ object: "list", data: listRows, has_more: false });
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

async function run(label: string, reply: Record<string, unknown>, applied: boolean) {
  redis.clear();
  posts = 0;
  refunded = 0;
  response = reply;
  apply = applied;
  const email = `g2699-${label}@example.com`;
  await claimHandle(email, `g2699${label}`, "Refund fixture", "");
  const shop = (await storeForEmail(email))!;
  const seller: Store = { ...shop, stripeAccountId: "acct_g2699refund" };
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: "in_g2699refund", pi: INTENT, amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 20, "rcalls", 10],
  ]);
  const out = await giveBackUnused(seller, DAY, { final: true });
  const [raw] = await redis.pipeline([["HGET", paidKey(folder), SUB]]);
  const saved = JSON.parse(String(raw)) as { r?: string };
  console.log(JSON.stringify({ label, posts, refunded, out, saved: saved.r ?? null }));
  return { out, saved, remaining: (await unusedRows(seller, DAY)).length };
}

async function main() {
 process.env.STRIPE_SECRET_KEY="sk_test_g2699_synthetic_only";
 const valid={id:"re_g2699refund",object:"refund",amount:500,currency:"usd",payment_intent:INTENT,status:"succeeded"};
 const bads:Record<string,unknown>[]=[
 {object:"list",data:[null],has_more:false},
 {object:"list",data:[7],has_more:false},
 {object:"list",data:[{}],has_more:false},
 {object:"list",data:[{...valid,metadata:"unreadable"}],has_more:false},
 {object:"invoice",data:[],has_more:false},
 ];
 for(const [i,body] of bads.entries()) {
  listEnvelope=body;const {out,saved,remaining}=await run("unknown"+i,valid,true);
  is("G unknown list: no money-moving POST on unreadable reconciliation",[posts,refunded],[0,0]);
  is("G unknown list: no settlement while reconciliation is unknown",[typeof out==="object"?out.done.length:out,saved.r==="done"],[0,false]);
  is("G unknown list: keep reconciliation discoverable",remaining,1);
 }
 listEnvelope={object:"list",data:[],has_more:false};const control=await run("emptyknown",valid,true);
 is("G known empty list: actual synthetic refund allowed",[posts,refunded],[1,500]);
 is("G known empty list: real completion is recorded",[typeof control.out==="object"?control.out.done.length:control.out,control.saved.r],[1,"done"]);
 done();
}
void main();
