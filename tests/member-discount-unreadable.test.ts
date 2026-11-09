/**
 * Fourth pre-review of claude5/closed-store-deadline, member-discount proof, copied as it is: an HTML 400 page in
 * front of Stripe is not Stripe refusing the code (lib/stripe-http-error.ts). Its harness is tests/member-discount's.
 *
 * 616 [WP15](8): a creator's code on one member's running membership
 * (lib/member-discount.ts), with Stripe faked through fetch. Only this
 * store's running memberships of that address, never a payment plan; a
 * membership with a discount is refused, never replaced; only an active code
 * of the store's; the code goes on with Stripe's promotion code field and an
 * idempotency key; Stripe refusing it by the code's rules is said as such.
 */
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { applyMemberDiscount, hasDiscount, memberSubs, readMemberSub } from "@/lib/member-discount";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_member_discount_only";

const subscription = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "active",
  metadata: { store: "memberstore", product: "prod000001" },
  items: { data: [{ price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] },
  ...extra,
});
const subs = [
  subscription("sub_live000001"),
  subscription("sub_disc000001", { discounts: ["di_1"] }),
  subscription("sub_plan000001", { metadata: { store: "memberstore", kind: "plan" } }),
  subscription("sub_else000001", { metadata: { store: "another" } }),
  subscription("sub_gone000001", { status: "canceled" }),
];
const codes = [
  { id: "promo_active0001", code: "THANKS", active: true, promotion: { type: "coupon", coupon: { id: "co_1", percent_off: 20, duration: "once" } } },
  { id: "promo_stopped001", code: "OLD", active: false, promotion: { type: "coupon", coupon: { id: "co_2", percent_off: 10, duration: "once" } } },
];
const posted: { path: string; body: string; key: string | null }[] = [];
let refuse = false;
let html = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/customers") return answer({ object: "list", data: url.searchParams.get("email") === "member@example.com" ? [{ id: "cus_member0001" }] : [], has_more: false });
  if (path === "/subscriptions") return answer({ object: "list", data: url.searchParams.get("customer") === "cus_member0001" ? subs : [], has_more: false });
  if (path === "/promotion_codes") return answer({ object: "list", data: codes, has_more: false });
  if (init?.method === "POST" && path.startsWith("/subscriptions/")) {
    const headers = new Headers(init.headers);
    posted.push({ path, body: String(init.body), key: headers.get("Idempotency-Key") });
    if (html) return new Response("<html><body>400 Bad Request (a proxy)</body></html>", { status: 400, headers: { "content-type": "text/html" } });
    return refuse ? answer({ error: { message: "This promotion code cannot be applied." } }, 400) : answer({ id: path.split("/")[2] });
  }
  return answer({ object: "list", data: [] });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "member-discount@example.com";
  await claimHandle(owner, "memberstore", "Member Store", "");
  await setStripeAccount(owner, "acct_1Memberxxxxxxxx", true);
  const store = (await storeForEmail(owner))!;
  part("PROOF member-discount: an HTML 400 page in front of Stripe is not Stripe refusing the code");
  html = true;
  const real = console.error; console.error = () => {};
  const got = await applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_active0001");
  console.error = real;
  is("HTML 400 -> stripe (not refused)", got, { ok: false, reason: "stripe" });
  html = false; refuse = true;
  is("Stripe's own JSON 400 still refused", await applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_active0001"), { ok: false, reason: "refused" });
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
