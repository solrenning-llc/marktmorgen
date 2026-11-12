/**
 * #2979, Claude 2's LEVE 2 (6759030511), held by Claude 4 and Claude 3 (cloud J, 6814138162): the discount POST on a
 * membership that fails with a server error (5xx) or gets no answer at all (a timeout, a network failure) may still
 * have landed on Stripe. lib/member-discount.ts applyMemberDiscount said it as "stripe", and the route as "could not be
 * reached just now, so nothing was changed": a sentence the creator acts on that may be false (VR item 2). Now:
 *   - 400 is Stripe refusing by the code's own rules: "refused", nothing changed (unchanged);
 *   - another 4xx is Stripe refusing the request: nothing changed, "stripe" (unchanged);
 *   - a 5xx or no answer is not known: "unknown", said as "may have been applied; find the member again", never
 *     "nothing was changed". The idempotency key keeps a second press from applying it twice.
 * Synthetic Stripe through fetch; no real account.
 */
import { NextRequest } from "next/server";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { applyMemberDiscount } from "@/lib/member-discount";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_member_apply_unknown";

let post: "ok" | 400 | 402 | 500 | 503 | "timeout" = "ok";
let posts = 0;
const membership = { id: "sub_ApplyUnknown01", status: "active", metadata: { store: "applyunknown", product: "prod000001" }, items: { data: [{ price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] }, discounts: [] };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/customers") return answer({ object: "list", has_more: false, data: [{ id: "cus_ApplyUnknown01" }] });
  if (path === "/subscriptions" && (init?.method ?? "GET") === "GET") return answer({ object: "list", has_more: false, data: [membership] });
  if (path === "/promotion_codes") return answer({ object: "list", has_more: false, data: [{ id: "promo_active0001", code: "THANKS", active: true, promotion: { type: "coupon", coupon: { id: "co_1", percent_off: 20, duration: "once" } } }] });
  if (init?.method === "POST" && path.startsWith("/subscriptions/")) {
    posts += 1;
    if (post === "timeout") throw new TypeError("fetch failed");
    if (post === "ok") return answer({ id: membership.id });
    return answer({ error: { type: post === 400 ? "invalid_request_error" : "api_error", message: "synthetic" } }, post);
  }
  return answer({ error: { message: "no such" } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  const owner = "apply-unknown@example.com";
  await claimHandle(owner, "applyunknown", "Apply Unknown", "");
  await setStripeAccount(owner, "acct_ApplyUnknown1", true);
  const store = (await storeForEmail(owner))!;
  const quiet = console.error;
  console.error = () => {};
  const apply = async (how: typeof post) => {
    post = how;
    return applyMemberDiscount(store, "member@example.com", membership.id, "promo_active0001");
  };

  part("What Stripe answered decides what is said");
  is("accepted", await apply("ok"), { ok: true });
  is("400: refused by the code's own rules", await apply(400), { ok: false, reason: "refused" });
  is("another 4xx: Stripe refused the request, nothing changed", await apply(402), { ok: false, reason: "stripe" });
  is("a 500 may have landed: not known", await apply(500), { ok: false, reason: "unknown" });
  is("a 503 may have landed: not known", await apply(503), { ok: false, reason: "unknown" });
  is("no answer at all may have landed: not known", await apply("timeout"), { ok: false, reason: "unknown" });

  part("The route never says nothing was changed when it is not known");
  const { POST } = await import("@/app/api/store/member-discount/route");
  const source = (await import("node:fs")).readFileSync("app/api/store/member-discount/route.ts", "utf8");
  const words = /unknown: \["([^"]*)", (\d+)\]/.exec(source);
  is("an answer for unknown exists", Boolean(words), true);
  is("it never says nothing was changed", /nothing was changed/i.test(words?.[1] ?? ""), false);
  is("it says to find the member again before pressing again", /find the member again/i.test(words?.[1] ?? ""), true);
  is("and that a second press does not apply it twice", /twice/i.test(words?.[1] ?? ""), true);
  is("as a 502", words?.[2], "502");
  is("the route is still the one checked", typeof POST, "function");
  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
