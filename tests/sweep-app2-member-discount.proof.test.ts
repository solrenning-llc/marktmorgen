/**
 * Sweep APP2 proof (CX-123 rules 24 and 30), synthetic only: app/api/store/member-discount/route.ts with
 * lib/member-discount.ts.
 *
 * lib/member-discount.ts:43 `list` reads a Stripe list as `Array.isArray(value.data) ? data : []`, and :46-49
 * `hasDiscount` reads a `discounts` that is not an array as "no discount". The file's own rule is that "a membership
 * that already has a discount is refused rather than having it replaced without a word: a better one could be lost".
 *
 *   (a) The membership's `discounts` in an unknown shape: hasDiscount says none, applyMemberDiscount sends
 *       `discounts[0][promotion_code]`, which replaces the subscription's discounts at Stripe: the member's earlier
 *       discount is gone and the next renewals charge more.
 *   (b) A customers or subscriptions list in an unknown shape: memberSubs answers [] (not null, its "could not read"),
 *       so the studio is told "no running membership at your store under that address", and apply says "not_member".
 */
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { applyMemberDiscount, memberSubs } from "@/lib/member-discount";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sweep_app2_only_a_stand_in";

let discounts: unknown = ["di_earlier001"];
let subsPage: unknown = null;
let customersPage: unknown = null;
const posted: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const sub = {
    id: "sub_disc000001",
    status: "active",
    metadata: { store: "memberstore", product: "prod000001" },
    items: { object: "list", data: [{ price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] },
    ...(discounts === undefined ? {} : { discounts }),
  };
  if (path === "/customers") return answer(customersPage ?? { object: "list", has_more: false, data: [{ id: "cus_member0001" }] });
  if (path === "/subscriptions") return answer(subsPage ?? { object: "list", has_more: false, data: [sub] });
  if (path === "/promotion_codes") return answer({ object: "list", data: [{ id: "promo_active0001", code: "THANKS", active: true, promotion: { type: "coupon", coupon: { id: "co_1", percent_off: 10, duration: "once" } } }] });
  if (init?.method === "POST" && path.startsWith("/subscriptions/")) {
    posted.push(`${path} ${decodeURIComponent(String(init.body))}`);
    return answer({ id: path.split("/")[2] });
  }
  return answer({ object: "list", data: [] });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "member-discount@example.com";
  await claimHandle(owner, "memberstore", "Member Store", "");
  await setStripeAccount(owner, "acct_1Memberxxxxxxxx", true);
  const store = (await storeForEmail(owner))!;

  part("Healthy control: a membership with a discount is refused, never replaced; the member is found");
  is("found, and seen as discounted", (await memberSubs(store, "member@example.com"))?.map((s) => [s.id, s.discounted]), [["sub_disc000001", true]]);
  is("apply: refused as discounted", await applyMemberDiscount(store, "member@example.com", "sub_disc000001", "promo_active0001"), { ok: false, reason: "discounted" });
  is("nothing sent to Stripe", posted.length, 0);

  part("DEFECT (a): the membership's `discounts` read in an unknown shape");
  for (const [label, shape] of [["a list object", { object: "list", data: ["di_earlier001"] }], ["one id as text", "di_earlier001"]] as const) {
    discounts = shape;
    posted.length = 0;
    const applied = await applyMemberDiscount(store, "member@example.com", "sub_disc000001", "promo_active0001");
    is(`DEFECT (${label}): the code is put on, replacing the discount already there`, [applied, posted], [{ ok: true }, ["/subscriptions/sub_disc000001 discounts[0][promotion_code]=promo_active0001"]]);
  }
  discounts = ["di_earlier001"];

  part("DEFECT (b): the customers or the subscriptions list in an unknown shape reads as 'no membership'");
  for (const [label, set] of [
    ["customers without data", () => { customersPage = { object: "list" }; }],
    ["subscriptions with data as an object", () => { subsPage = { object: "list", data: { 0: {} } }; }],
  ] as const) {
    customersPage = null;
    subsPage = null;
    set();
    const found = await memberSubs(store, "member@example.com");
    is(`DEFECT (${label}): memberSubs answers [] (the studio says no running membership), not null (could not read)`, found, []);
    is(`DEFECT (${label}): apply answers not_member, not stripe`, await applyMemberDiscount(store, "member@example.com", "sub_disc000001", "promo_active0001"), { ok: false, reason: "not_member" });
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
