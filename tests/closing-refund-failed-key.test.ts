// Codex X8: a confirmed-failed closing refund is retried under the same Idempotency-Key, so Stripe replays the first answer.
import { giveBackUnused } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const SUB = "sub_x8refund";
const INTENT = "pi_x8refund";
const stored = new Map<string, Record<string, unknown>>();
let keys: string[] = [];
let executed = 0;
let nextStatus: string[] = [];
let listed: Record<string, unknown>[] = [];
let dropNext = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  if (path === `/payment_intents/${INTENT}`) return Response.json({ id: INTENT, amount: 1000, currency: "usd", latest_charge: { id: "ch_x8", amount: 1000, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null } });
  if (path === "/refunds" && init?.method === "POST") {
    const headers = new Headers(init.headers);
    const key = headers.get("Idempotency-Key") ?? "";
    keys.push(key);
    // A request lost on the way (a timeout before Stripe ran it): the outcome is unknown to the caller.
    if (dropNext) {
      dropNext = false;
      throw new TypeError("synthetic network failure");
    }
    if (!stored.has(key)) {
      executed += 1;
      stored.set(key, { id: `re_x8n${executed}`, object: "refund", amount: 500, currency: "usd", payment_intent: INTENT, status: nextStatus.shift() ?? "failed" });
    }
    return Response.json(stored.get(key)!);
  }
  if (path === "/refunds") return Response.json({ object: "list", data: listed, has_more: false });
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

async function setup(label: string) {
  redis.clear();
  stored.clear();
  keys = [];
  executed = 0;
  const email = `x8-${label}@example.com`;
  await claimHandle(email, `x8${label}`, "Refund fixture", "");
  const shop = (await storeForEmail(email))!;
  const seller: Store = { ...shop, stripeAccountId: "acct_x8refund" };
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: "in_x8refund", pi: INTENT, amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", 20, "rcalls", 10],
  ]);
  return seller;
}
const row = (status: string, id = "re_x8n1") => ({ id, object: "refund", amount: 500, currency: "usd", payment_intent: INTENT, status, metadata: { closing_refund: "in_x8refund" } });

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_x8_synthetic_only";
  part("control: a refund that succeeded is made once");
  let seller = await setup("ctl");
  nextStatus = ["succeeded"];
  listed = [];
  const first = await giveBackUnused(seller, DAY);
  is("control: one made", first.done.length, 1);
  is("control: executed once", executed, 1);

  part("failed then confirmed failed: next pass must use a new key and actually retry");
  seller = await setup("fail");
  nextStatus = ["failed", "succeeded"];
  listed = [];
  is("first pass fails", (await giveBackUnused(seller, DAY)).failed, 1);
  listed = [row("failed")];
  const second = await giveBackUnused(seller, DAY);
  is("two distinct keys", new Set(keys).size, 2);
  is("second pass made the refund", second.done.length, 1);

  part("pending then confirmed failed: next pass must not replay the pending answer");
  seller = await setup("pend");
  nextStatus = ["pending", "succeeded"];
  listed = [];
  is("first pass pending", (await giveBackUnused(seller, DAY)).pending, 1);
  listed = [row("failed")];
  const third = await giveBackUnused(seller, DAY);
  is("two distinct keys", new Set(keys).size, 2);
  is("retried and made", third.done.length, 1);

  part("an unknown outcome keeps the key: the retry is never a second refund");
  seller = await setup("unk");
  nextStatus = ["succeeded"];
  listed = [];
  dropNext = true;
  is("first pass lost on the way counts failed", (await giveBackUnused(seller, DAY)).failed, 1);
  const fourth = await giveBackUnused(seller, DAY);
  is("same key on the retry", new Set(keys).size, 1);
  is("the retry made it once", fourth.done.length, 1);
  is("executed once", executed, 1);

  part("each confirmed failure moves the key on once");
  seller = await setup("two");
  nextStatus = ["failed", "failed", "succeeded"];
  listed = [];
  await giveBackUnused(seller, DAY);
  listed = [row("failed")];
  await giveBackUnused(seller, DAY);
  listed = [row("failed", "re_x8n2"), row("failed")];
  const fifth = await giveBackUnused(seller, DAY);
  is("three distinct keys", new Set(keys).size, 3);
  is("the third key", keys[2], "closing-refund:in_x8refund:2");
  is("the first key unchanged", keys[0], "closing-refund:in_x8refund");
  is("made on the third attempt", fifth.done.length, 1);
  done();
}

void main();
