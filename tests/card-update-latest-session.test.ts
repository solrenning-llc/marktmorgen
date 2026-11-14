/**
 * Only the card page opened last for a membership sets its card, and finishing it never clears a newer page (Codex
 * X5's MEDIUM on #3644). openCardUpdate keeps the latest Stripe page under nl:card:open:<account>:<subscription>,
 * but finishCardUpdate never compared it: a page A opened before page B, and returned after it, could still set A's
 * card over B's, and its plain DEL took B off the daily job's way back (lib/payment-recovery.ts). Now a finish sets
 * the card only for the page kept for the membership; a page that is not it (an older one, none, an answer that
 * cannot be read) changes nothing and says "error"; a finish replaces the page with a done mark only while it is
 * still its own, so finishing the same page again runs as before (the same card, no second payment) and a newer
 * page is never cleared.
 * Synthetic Stripe and Redis; nothing is reached.
 */
import { finishCardUpdate, openKey } from "@/lib/card-update";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ACCOUNT = "acct_1TestCardLatest01";
const SUB = "sub_CardLatest0001";
const CUSTOMER = "cus_CardLatest01";
const set: string[] = [];
const sessions: Record<string, string> = { cs_test_pageAaaaaaaaaa01: "pm_cardAaaaaa01", cs_test_pageBbbbbbbbbb01: "pm_cardBbbbbb01" };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const session = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/)?.[1];
  if (session && sessions[session]) {
    return ok({ id: session, object: "checkout.session", mode: "setup", status: "complete", customer: CUSTOMER, metadata: { kind: "card", store: "cardshop", subscription: SUB }, setup_intent: { status: "succeeded", payment_method: sessions[session], metadata: { subscription: SUB } } });
  }
  if (url.pathname === `/v1/subscriptions/${SUB}` && (init?.method ?? "GET") === "GET") {
    return ok({ id: SUB, object: "subscription", status: "active", customer: CUSTOMER, metadata: { store: "cardshop" }, latest_invoice: null });
  }
  if (url.pathname === `/v1/subscriptions/${SUB}` && init?.method === "POST") {
    const method = new URLSearchParams(String(init.body)).get("default_payment_method") ?? "";
    set.push(method);
    return ok({ id: SUB, object: "subscription", status: "active", customer: CUSTOMER, default_payment_method: method });
  }
  return new Response(JSON.stringify({ error: { message: "not stubbed" } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_card_latest_only";
  redis.clear();
  const made = await claimHandle("owner@example.com", "cardshop", "Card Shop", "");
  if (!made.ok) throw new Error("no store");
  await setStripeAccount("owner@example.com", ACCOUNT, true);
  const store = (await storeForEmail("owner@example.com"))!;
  const kept = async () => (await redis.pipeline([["GET", openKey(ACCOUNT, SUB)]]))[0];

  part("Page A was opened, then page B for the same membership; A comes back after");
  await redis.pipeline([["SET", openKey(ACCOUNT, SUB), "cs_test_pageBbbbbbbbbb01", "EX", 3600]]);
  is("the older page does not set its card", [await finishCardUpdate(store, "cs_test_pageAaaaaaaaaa01"), set], ["error", []]);
  is("and the newer page is still kept for the daily job", await kept(), "cs_test_pageBbbbbbbbbb01");

  part("The page kept for the membership sets its card");
  is("B sets B's card", [await finishCardUpdate(store, "cs_test_pageBbbbbbbbbb01"), set], ["updated", ["pm_cardBbbbbb01"]]);
  is("and is marked done, no longer waiting", await kept(), "done:cs_test_pageBbbbbbbbbb01");
  is("finishing B again is safe: updated, the same card again", [await finishCardUpdate(store, "cs_test_pageBbbbbbbbbb01"), set], ["updated", ["pm_cardBbbbbb01", "pm_cardBbbbbb01"]]);
  is("still marked done", await kept(), "done:cs_test_pageBbbbbbbbbb01");
  is("A after B finished still sets nothing", [await finishCardUpdate(store, "cs_test_pageAaaaaaaaaa01"), set.length], ["error", 2]);

  part("No page kept, or one that cannot be read: nothing is set");
  await redis.pipeline([["DEL", openKey(ACCOUNT, SUB)]]);
  is("none kept", [await finishCardUpdate(store, "cs_test_pageAaaaaaaaaa01"), set.length], ["error", 2]);
  await redis.pipeline([["HSET", openKey(ACCOUNT, SUB), "x", "y"]]);
  is("a kept value of another shape", [await finishCardUpdate(store, "cs_test_pageAaaaaaaaaa01"), set.length], ["error", 2]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
