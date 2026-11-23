/**
 * Codex L-20261119-1636 (#5010 row 84, HIGH, money and erasure): createTipCheckout waited on Stripe's
 * POST /checkout/sessions and then wrote the tip mark with a plain SET EX and handed the checkout URL out. A store
 * whose erasure began while that call was in flight still gave the buyer a payment page, and its mark came back for
 * two days after the erasure had passed it.
 *
 * Checked with the real createTipCheckout against the in-memory Redis, Stripe stood in by a fetch stub that begins
 * the store's erasure (its erasing mark, lib/store.ts ERASING_KEY) inside the checkout's POST:
 * - the checkout is refused, no URL handed out;
 * - no tip mark is written back;
 * - the control, a live store, still opens its checkout and keeps its mark.
 *
 * Synthetic store and replies only; nothing real is called.
 */
import { createHash } from "node:crypto";
import { claimHandle, ensureStatsId, erasingField, ERASING_KEY, setStripeAccount, setSubscription, setTips, storeForEmail, storeRef } from "@/lib/store";
import { createTipCheckout } from "@/lib/store-tip-checkout";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "tip-erasure@example.com";
const HANDLE = "tiperasure";
process.env.STRIPE_SECRET_KEY = "sk_test_tip_erasure_only";
const OPENED = `cs_test_${"e".repeat(24)}`;

let erase: (() => Promise<void>) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "POST") {
    // The store's erasure begins while Stripe is answering.
    if (erase) await erase();
    return answer({ id: OPENED, url: "https://checkout.stripe.com/c/pay/test" });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// lib/store-tip-checkout.ts tipMarkKey, for this store and the checkout the stub opens.
const tipMarks = (ref: string) => Number(redis.run(["EXISTS", `nl:tip:co:${createHash("sha256").update(`${ref}|${OPENED}`).digest("hex")}`]));

async function main() {
  await claimHandle(OWNER, HANDLE, "Tip Erasure", "Pots.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_tiperasure01", subscriptionId: "sub_tiperasure01", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_tiperasure0001", true);
  await setTips(OWNER, { on: true, heading: "", line: "", amounts: [] });
  const store = (await storeForEmail(OWNER))!;

  part("A store whose erasure begins during the checkout's POST");
  erase = async () => { redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]); };
  let refused = "";
  let opened: unknown = null;
  try {
    opened = await createTipCheckout(store, "https://marktmorgen.com", 500);
  } catch (error) {
    refused = (error as Error).message;
  }
  is("no checkout URL is handed out", opened, null);
  is("the checkout is refused", refused !== "", true);
  is("no tip mark is written back", tipMarks(storeRef(store)), 0);

  part("Control: a live store");
  erase = null;
  redis.run(["HDEL", ERASING_KEY, await erasingField(storeRef(store))]);
  is("the checkout opens", await createTipCheckout(store, "https://marktmorgen.com", 500), { url: "https://checkout.stripe.com/c/pay/test", id: OPENED });
  is("and its mark is kept", tipMarks(storeRef(store)), 1);
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
