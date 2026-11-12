// Money hunt A: a closing refund Stripe refuses on the closing day, on a payment the creator had already partly
// refunded at Stripe. The member is told (and the record keeps as "want") what is still owed: the same `give` the
// refund was just attempted for (unused less what the charge already gave back), never the whole unused part.
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const SUB = "sub_mhaunmade";
const INTENT = "pi_mhaunmade01";
let asked = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  // The creator refunded 300 of this 1,000 payment at Stripe before the closing (no closing_refund mark).
  if (path === `/payment_intents/${INTENT}`) return Response.json({ id: INTENT, amount: 1000, currency: "usd", latest_charge: { id: "ch_mhaunmade01", amount: 1000, currency: "usd", amount_refunded: 300, disputed: false, balance_transaction: null } });
  if (path === "/refunds" && init?.method === "POST") {
    asked = new URLSearchParams(String(init.body)).get("amount") ?? "";
    return Response.json({ id: "re_mhaunmade01", object: "refund", amount: Number(asked), currency: "usd", payment_intent: INTENT, status: "failed" });
  }
  if (path === "/refunds") return Response.json({ object: "list", data: [{ id: "re_bycreator01", object: "refund", amount: 300, currency: "usd", payment_intent: INTENT, status: "succeeded", metadata: {} }], has_more: false });
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_mha_synthetic_only";
  part("a refused closing refund on a partly refunded payment: the member is owed what was attempted, not the whole unused part");
  redis.clear();
  const email = "mha-unmade@example.com";
  await claimHandle(email, "mhaunmade", "Refund fixture", "");
  const seller: Store = { ...(await storeForEmail(email))!, stripeAccountId: "acct_mhaunmade" };
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: "in_mhaunmade01", pi: INTENT, amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 20, "rcalls", 10],
  ]);
  const out = await giveBackUnused(seller, DAY, { final: true });
  is("the refund attempted was the unused 500 less the 300 already given back", asked, "200");
  const unmade = typeof out === "object" && out ? out.unmade.map((u) => u.amount) : out;
  is("the member is told 200 is left to give, the amount that was attempted", unmade, [200]);
  const [raw] = await redis.pipeline([["HGET", paidKey(folder), SUB]]);
  const saved = JSON.parse(String(raw)) as { r?: string; want?: number };
  is("and the record keeps 200 as what is wanted", [saved.r, saved.want], ["over", 200]);
  done();
}

void main();
