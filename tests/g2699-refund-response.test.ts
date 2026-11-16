// Codex G's proof on #2699 (48c01cad), kept as a permanent test with credit.
import { giveBackUnused, unusedRows } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const SUB = "sub_g2699refund";
const INTENT = "pi_g2699refund";
let response: Record<string, unknown> = {};
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
  if (path === "/refunds") return Response.json({ object: "list", data: [], has_more: false });
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
  process.env.STRIPE_SECRET_KEY = "sk_test_g2699_synthetic_only";
  const valid = { id: "re_g2699refund", object: "refund", amount: 500, currency: "usd", payment_intent: INTENT, status: "succeeded" };
  for (const [label, reply] of [
    ["missing", {}],
    ["failed", { ...valid, status: "failed" }],
    ["requiresaction", { ...valid, status: "requires_action" }],
    ["canceled", { ...valid, status: "canceled" }],
    ["wrongpayment", { ...valid, payment_intent: "pi_g2699other" }],
    ["textamount", { ...valid, amount: "500" }],
  ] as [string, Record<string, unknown>][]) {
    part(label);
    const { out, saved, remaining } = await run(label, reply, false);
    is("one POST reached; provider fixture has applied no refund", [posts, refunded], [1, 0]);
    is("unknown, failed or foreign payment evidence cannot settle this member as refunded", typeof out === "object" ? [out.done.length, saved.r === "done"] : out, [0, false]);
    // Rule 23, Claude 4's decision C4-20261106-1255 (Revisor 1 on #2699): this run is the closing day (final: true), and
    // after it there is no later run. A refund Stripe itself refused (failed, canceled) is final there: the member is
    // settled "over" and told honestly what is left and how to reach the creator, never left held. Every other
    // unconfirmed answer still stays to be reconciled, as Codex G asked.
    if (label === "failed" || label === "canceled") is("a refund Stripe refused on the closing day is told, not left held", [remaining, saved.r], [0, "over"]);
    else is("unconfirmed refund remains discoverable for reconciliation on a later run", remaining, 1);
  }
  part("exact successful refund control");
  const { out, saved } = await run("control", valid, true);
  is("exact response corresponds to one actually applied synthetic refund", [posts, refunded], [1, 500]);
  is("the confirmed refund alone completes the stored member", typeof out === "object" ? [out.done.length, saved.r] : out, [1, "done"]);
  done();
}
void main();
