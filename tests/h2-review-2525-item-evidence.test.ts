import { applyMemberDiscount, memberSubs } from "@/lib/member-discount";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as memory } from "./redis-stub";
import { done, is, part } from "./check";
import { readFileSync } from "node:fs";

const customer = "cus_review2525";
const subscriptionId = "sub_review2525";
const promotion = "promo_review2525";
const price = { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } };
const page = (data: unknown[]) => ({ object: "list", data, has_more: false });
const sub = (items: unknown, discounts: unknown = []) => ({
  id: subscriptionId,
  status: "active",
  discounts,
  metadata: { store: "review2525", product: "prod_review2525" },
  items,
});

let subscription: unknown;
let postReply: unknown;
let posts = 0;
const savedFetch = globalThis.fetch;
const savedKey = process.env.STRIPE_SECRET_KEY;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const reply = (value: unknown) => new Response(JSON.stringify(value));
  if (url.pathname === "/v1/customers") return reply(page([{ id: customer }]));
  if (url.pathname === "/v1/subscriptions" && init?.method !== "POST") return reply(page([subscription]));
  if (url.pathname === "/v1/promotion_codes") {
    return reply(page([{ id: promotion, code: "SAVE", active: true, promotion: { type: "coupon", coupon: { id: "co_review", percent_off: 20, duration: "once" } } }]));
  }
  if (url.pathname === `/v1/subscriptions/${subscriptionId}` && init?.method === "POST") {
    posts += 1;
    return reply(postReply);
  }
  throw Error("Unexpected Stripe operation");
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_h2_review_2525";
  memory.clear();
  await claimHandle("review-2525@example.com", "review2525", "Review 2525", "");
  await setStripeAccount("review-2525@example.com", "acct_1Review2525xxxx", true);
  const store = (await storeForEmail("review-2525@example.com"))!;

  part("A partial or plural price list cannot authorize a subscription-wide discount");
  for (const [name, items] of [
    ["partial item page", { object: "list", data: [{ price }], has_more: true }],
    ["two renewal items", { object: "list", data: [{ price }, { price: { ...price, unit_amount: 7100 } }], has_more: false }],
  ] as const) {
    subscription = sub(items);
    postReply = { id: subscriptionId, discounts: [{ promotion_code: promotion }] };
    posts = 0;
    is(`${name}: membership evidence stays unknown`, await memberSubs(store, "member@example.com"), null);
    is(`${name}: no subscription mutation starts`, [await applyMemberDiscount(store, "member@example.com", subscriptionId, promotion), posts], [{ ok: false, reason: "stripe" }, 0]);
  }

  part("The update receipt must prove the requested discount is present");
  subscription = sub({ object: "list", data: [{ price }], has_more: false });
  for (const value of [
    { id: subscriptionId },
    { id: subscriptionId, discounts: [] },
    { id: subscriptionId, discounts: [{ promotion_code: "promo_other2525" }] },
  ]) {
    postReply = value;
    posts = 0;
    is("an incomplete or contradictory update receipt is unknown and never retried", [await applyMemberDiscount(store, "member@example.com", subscriptionId, promotion), posts], [{ ok: false, reason: "stripe" }, 1]);
  }
  const route = readFileSync("app/api/store/member-discount/route.ts", "utf8");
  is("the response after an uncertain POST does not promise that nothing changed", route.includes("This try may have changed the membership."), true);
}

void main().finally(() => {
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = savedKey;
}).then(done).catch(error => {
  console.error(error);
  process.exit(1);
});
