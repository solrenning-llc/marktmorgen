/**
 * 616 [WP15](8): a creator's code on one member's running membership
 * (lib/member-discount.ts), with Stripe faked through fetch. Only this
 * store's running memberships of that address, never a payment plan; a
 * membership with a discount is refused, never replaced; only an active code
 * of the store's; the code goes on with Stripe's promotion code field and an
 * idempotency key; Stripe refusing it by the code's rules is said as such.
 */
import { readFileSync } from "node:fs";
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
/** A customer row that is not one: an empty object, an array, an id that is not a customer's. */
const OFF_CUSTOMERS: Record<string, unknown> = { "rowobject@example.com": {}, "rowarray@example.com": [], "rowbadid@example.com": { id: 42 } };
/** A subscription row that is not one: an empty object, an array, no status, metadata that is not an object, an id that is not a subscription's. */
const OFF_SUBS: Record<string, unknown> = {
  "subobject@example.com": {},
  "subarray@example.com": [],
  "subnostatus@example.com": { id: "sub_nostatus01", metadata: { store: "memberstore" } },
  "submeta@example.com": { id: "sub_badmeta001", status: "active", metadata: "memberstore" },
  "subbadid@example.com": { id: 7, status: "active", metadata: { store: "memberstore" } },
};
const posted: { path: string; body: string; key: string | null }[] = [];
let refuse = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  // Stripe's lists carry has_more: an answer without it is not one this code reads (rule 24).
  // Rows Stripe could not have sent, one per address (Codex S second review of #2912, residual of M2):
  // a customer or a subscription row that is not a readable one is unknown, never "no membership".
  if (path === "/customers") {
    const email = url.searchParams.get("email") ?? "";
    const data = email === "member@example.com" ? [{ id: "cus_member0001" }] : email in OFF_CUSTOMERS ? [OFF_CUSTOMERS[email]] : email in OFF_SUBS ? [{ id: `cus_${email.split("@")[0]}01` }] : [];
    return answer({ object: "list", data, has_more: false });
  }
  if (path === "/subscriptions") {
    const customer = url.searchParams.get("customer") ?? "";
    const off = Object.keys(OFF_SUBS).find((email) => customer === `cus_${email.split("@")[0]}01`);
    return answer({ object: "list", data: customer === "cus_member0001" ? subs : off ? [OFF_SUBS[off]] : [], has_more: false });
  }
  if (path === "/promotion_codes") return answer({ object: "list", data: codes, has_more: false });
  if (init?.method === "POST" && path.startsWith("/subscriptions/")) {
    const headers = new Headers(init.headers);
    posted.push({ path, body: String(init.body), key: headers.get("Idempotency-Key") });
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

  part("What the studio is shown");
  is("a discount, old or new shape, is seen", [hasDiscount({ discount: { id: "di" } }), hasDiscount({ discounts: ["di"] }), hasDiscount({ discounts: [] })], [true, true, false]);
  is("another store's or a payment plan is not a membership here", [readMemberSub(subs[2], new Set(["memberstore"])), readMemberSub(subs[3], new Set(["memberstore"]))], [null, null]);
  const found = await memberSubs(store, "member@example.com");
  is("only this store's running memberships of that address", found?.map((s) => [s.id, s.discounted]), [["sub_live000001", false], ["sub_disc000001", true]]);
  is("with what each renewal costs", found?.[0] ? [found[0].amount, found[0].currency, found[0].interval, found[0].product] : null, [2900, "usd", "month", "prod000001"]);
  is("nobody under that address: none", (await memberSubs(store, "nobody@example.com"))?.length, 0);

  part("A row Stripe could not have sent is unknown, never no membership (Codex S second review of #2912)");
  for (const email of [...Object.keys(OFF_CUSTOMERS), ...Object.keys(OFF_SUBS)]) {
    is(`${email}: the lookup says Stripe could not be read`, await memberSubs(store, email), null);
    is(`${email}: putting a code on says Stripe, never not a member`, await applyMemberDiscount(store, email, "sub_live000001", "promo_active0001"), { ok: false, reason: "stripe" });
  }
  is("a readable but ended membership still is not one", (await memberSubs(store, "member@example.com"))?.some((s) => s.id === "sub_gone000001"), false);
  is("nothing was sent to Stripe for an unreadable row", posted.length, 0);

  part("Putting a code on");
  is("not this member's membership: refused", await applyMemberDiscount(store, "member@example.com", "sub_else000001", "promo_active0001"), { ok: false, reason: "not_member" });
  is("one with a discount already: refused, never replaced", await applyMemberDiscount(store, "member@example.com", "sub_disc000001", "promo_active0001"), { ok: false, reason: "discounted" });
  is("a code that is not active: refused", await applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_stopped001"), { ok: false, reason: "code" });
  is("nothing was sent to Stripe for any of them", posted.length, 0);
  is("the code goes on", await applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_active0001"), { ok: true });
  is("with Stripe's promotion code field, on that membership, once", [posted[0]?.path, decodeURIComponent(posted[0]?.body ?? ""), posted[0]?.key], ["/subscriptions/sub_live000001", "discounts[0][promotion_code]=promo_active0001", "member-discount:sub_live000001:promo_active0001"]);
  refuse = true;
  is("Stripe refusing it by the code's rules is said as such", await applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_active0001"), { ok: false, reason: "refused" });

  part("The studio");
  const page = readFileSync("app/studio/memberships/page.tsx", "utf8");
  const component = readFileSync("components/member-discount.tsx", "utf8");
  is("only for a role that may change the store's codes", page.includes('can(access.role, "settings") ? ('), true);
  is("the address field is labeled, the result announced, errors said", component.includes("The member&apos;s email") && component.includes('role="status"') && component.includes('role="alert"'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
