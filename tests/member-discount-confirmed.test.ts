/**
 * #4721 (Codex X8): putting a code on a member's running membership was confirmed as soon as Stripe's update answer
 * named the subscription, even when that answer showed no discount on it. It is now confirmed only when the answer
 * lists the discount of that very promotion code; otherwise the studio is told it could not be confirmed.
 * Synthetic Stripe stand-in; no real account.
 */
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { applyMemberDiscount } from "@/lib/member-discount";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_member_discount_confirmed";

const sub = {
  id: "sub_live000001",
  status: "active",
  discounts: [],
  metadata: { store: "memberstore", product: "prod000001" },
  items: { data: [{ price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] },
};
const codes = [{ id: "promo_active0001", code: "THANKS", active: true, promotion: { type: "coupon", coupon: { id: "co_1", percent_off: 20, duration: "once" } } }];
let postReply: unknown = {};
let postedBody = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/customers") return answer({ object: "list", data: [{ id: "cus_member0001" }], has_more: false });
  if (path === "/subscriptions") return answer({ object: "list", data: [sub], has_more: false });
  if (path === "/promotion_codes") return answer({ object: "list", data: codes, has_more: false });
  if (init?.method === "POST" && path.startsWith("/subscriptions/")) {
    postedBody = decodeURIComponent(String(init.body));
    return answer(postReply);
  }
  return answer({ object: "list", data: [] });
}) as typeof fetch;

const applied = { id: "di_applied0001", object: "discount", promotion_code: "promo_active0001", coupon: { id: "co_1" } };

async function main(): Promise<void> {
  redis.clear();
  const owner = "member-discount-confirmed@example.com";
  await claimHandle(owner, "memberstore", "Member Store", "");
  await setStripeAccount(owner, "acct_1Memberxxxxxxxx", true);
  const store = (await storeForEmail(owner))!;
  const apply = async (reply: unknown) => {
    postReply = reply;
    return applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_active0001");
  };

  part("Confirmed only when Stripe's answer shows that code's discount on that membership");
  is("(control) the discount of that code is listed: ok", await apply({ ...sub, discounts: [applied] }), { ok: true });
  is("(control) its promotion code read as an object: ok", await apply({ ...sub, discounts: [{ ...applied, promotion_code: { id: "promo_active0001" } }] }), { ok: true });
  is("the update asks Stripe to show the discounts it applied", postedBody.includes("expand[0]=discounts"), true);
  is("an answer with no discount is not confirmed", await apply({ ...sub, discounts: [] }), { ok: false, reason: "stripe" });
  is("an empty body is not confirmed", await apply({}), { ok: false, reason: "stripe" });
  is("another code's discount is not confirmed", await apply({ ...sub, discounts: [{ ...applied, promotion_code: "promo_other00001" }] }), { ok: false, reason: "stripe" });
  is("a discount given only by its id cannot be read, so it is not confirmed", await apply({ ...sub, discounts: ["di_applied0001"] }), { ok: false, reason: "stripe" });
  is("another membership's answer is not confirmed", await apply({ ...sub, id: "sub_else000001", discounts: [applied] }), { ok: false, reason: "stripe" });
  done();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
