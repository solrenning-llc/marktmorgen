/**
 * The member's discount and free days read Stripe exactly (CX-123 rules 24
 * and 30; sweep APP2 finding 3, docs/reviews/c5-sweep-app2.md), synthetic
 * only, with a stand-in Stripe through fetch and Redis in memory.
 *
 *   - A membership's `discounts` in a shape Stripe does not give (a list
 *     object, one id as text, missing, null) is not read as "no discount":
 *     the code is not put on, since putting it on would replace the one the
 *     member already has, and nothing is sent to Stripe.
 *   - A customers or subscriptions list in another shape (no `data` array, no
 *     `has_more`, a row that cannot be read) is "could not check", never "no
 *     running membership": the routes answer 503 "unavailable", the studio
 *     says it could not check, nothing is changed. The free days, which read
 *     the same memberships, inherit it.
 *   - A member's memberships over more than one page are all read.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, storeForEmail } from "@/lib/store";
import { applyMemberDiscount, hasDiscount, memberSubs } from "@/lib/member-discount";
import { freeDaysSubs, giveFreeDays } from "@/lib/member-free-days";
import { POST as discountRoute } from "@/app/api/store/member-discount/route";
import { POST as freeDaysRoute } from "@/app/api/store/member-free-days/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_member_discount_exact_only";

const DAY = 86_400;
const PERIOD_END = Math.floor(Date.now() / 1000) + 20 * DAY;
const MISSING = Symbol("missing");

let discounts: unknown = [];
let customersPage: unknown = null;
let subsPage: unknown = null;
/** When set, the member's memberships come over two pages: the first holds `first`, the next the membership. */
let paged = false;
let endless = false;
const posted: string[] = [];
const subscription = (id: string): Record<string, unknown> => ({
  id,
  object: "subscription",
  status: "active",
  metadata: { store: "exactstore", product: "prod000001" },
  items: { object: "list", has_more: false, data: [{ current_period_end: PERIOD_END, price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] },
  ...(discounts === MISSING ? {} : { discounts }),
});
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/customers") return answer(customersPage ?? { object: "list", has_more: false, data: url.searchParams.get("email") === "member@example.com" ? [{ id: "cus_member0001" }] : [] });
  if (path === "/subscriptions" && (init?.method ?? "GET") === "GET") {
    if (subsPage) return answer(subsPage);
    if (endless) return answer({ object: "list", has_more: true, data: [subscription(`sub_more${url.searchParams.get("starting_after")?.slice(-6) ?? "000000"}x`)] });
    if (paged && !url.searchParams.get("starting_after")) return answer({ object: "list", has_more: true, data: [subscription("sub_first00001")] });
    if (paged) return answer({ object: "list", has_more: false, data: url.searchParams.get("starting_after") === "sub_first00001" ? [subscription("sub_second0001")] : [] });
    return answer({ object: "list", has_more: false, data: [subscription("sub_exact00001")] });
  }
  if (path === "/promotion_codes") return answer({ object: "list", has_more: false, data: [{ id: "promo_active0001", code: "THANKS", active: true, promotion: { type: "coupon", coupon: { id: "co_1", percent_off: 10, duration: "once" } } }] });
  if (init?.method === "POST" && path.startsWith("/subscriptions/")) {
    posted.push(`${path} ${decodeURIComponent(String(init.body))}`);
    return answer({ id: path.split("/")[2] });
  }
  return answer({ object: "list", has_more: false, data: [] });
}) as typeof fetch;

function reset(): void {
  discounts = [];
  customersPage = null;
  subsPage = null;
  paged = false;
  endless = false;
  posted.length = 0;
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "member-exact@example.com";
  await claimHandle(owner, "exactstore", "Exact Store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Exactxxxxxxxxx", true);
  const store = (await storeForEmail(owner))!;
  const session = await openSession(owner);
  const call = async (route: typeof discountRoute, name: string, body: Record<string, unknown>) => {
    const response = await route(
      new NextRequest(`https://marktmorgen.com/api/store/${name}?store=${store.sid}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const apply = () => applyMemberDiscount(store, "member@example.com", "sub_exact00001", "promo_active0001");

  part("Healthy control: Stripe's own shapes read as before");
  reset();
  is("no discount: found, the code goes on once", [(await memberSubs(store, "member@example.com")) as unknown, await apply(), posted], [
    [{ id: "sub_exact00001", status: "active", product: "prod000001", amount: 2900, currency: "usd", interval: "month", discounted: false }],
    { ok: true },
    ["/subscriptions/sub_exact00001 discounts[0][promotion_code]=promo_active0001"],
  ]);
  reset();
  discounts = ["di_earlier001"];
  is("a discount already there (an id): refused, nothing sent", [await apply(), posted.length], [{ ok: false, reason: "discounted" }, 0]);
  discounts = [{ id: "di_earlier001", object: "discount" }];
  is("a discount already there (expanded): refused, nothing sent", [await apply(), posted.length], [{ ok: false, reason: "discounted" }, 0]);
  is("Stripe's shapes: an id, an object, none, the old single field", [hasDiscount({ discounts: ["di_1"] }), hasDiscount({ discounts: [{ id: "di_1" }] }), hasDiscount({ discounts: [] }), hasDiscount({ discount: { id: "di_1" } }), hasDiscount({ discounts: [], discount: null })], [true, true, false, true, false]);

  part("A membership's `discounts` in another shape is not 'no discount'");
  for (const [label, shape] of [
    ["a list object", { object: "list", data: ["di_earlier001"] }],
    ["one id as text", "di_earlier001"],
    ["missing", MISSING],
    ["null", null],
    ["a number", 1],
  ] as const) {
    reset();
    discounts = shape;
    const found = await memberSubs(store, "member@example.com");
    is(`${label}: shown as not known, never as no discount`, Array.isArray(found) ? found.map((s) => s.discounted) : found, [null]);
    is(`${label}: the code is not put on, nothing sent to Stripe`, [await apply(), posted], [{ ok: false, reason: "unavailable" }, []]);
  }
  reset();
  is("an old single `discount` in another shape is not known", [hasDiscount({ discounts: [], discount: "di_1" }), hasDiscount({ discounts: [], discount: [] })], [null, null]);

  part("A list in another shape is 'could not check', never 'no membership'");
  const lists: [string, () => void][] = [
    ["customers without data", () => { customersPage = { object: "list", has_more: false }; }],
    ["customers without has_more", () => { customersPage = { object: "list", data: [{ id: "cus_member0001" }] }; }],
    ["customers as a list of rows", () => { customersPage = [{ id: "cus_member0001" }]; }],
    ["a customer row that cannot be read", () => { customersPage = { object: "list", has_more: false, data: [{ id: 7 }] }; }],
    ["more customers than one page", () => { customersPage = { object: "list", has_more: true, data: [{ id: "cus_member0001" }] }; }],
    ["subscriptions with data as an object", () => { subsPage = { object: "list", has_more: false, data: { 0: {} } }; }],
    ["subscriptions without has_more", () => { subsPage = { object: "list", data: [subscription("sub_exact00001")] }; }],
    ["a subscription row that cannot be read", () => { subsPage = { object: "list", has_more: false, data: [{ id: "sub_exact00001", status: 3 }] }; }],
    ["subscriptions over more pages than are read", () => { endless = true; }],
  ];
  for (const [label, set] of lists) {
    reset();
    set();
    is(`${label}: the memberships are not known`, await memberSubs(store, "member@example.com"), "unreadable");
    is(`${label}: apply is refused as not known, nothing sent`, [await apply(), posted], [{ ok: false, reason: "unavailable" }, []]);
    is(`${label}: free days read none of it as no membership`, await freeDaysSubs(store, "member@example.com"), "unreadable");
    const gave = await giveFreeDays(store, "member@example.com", "sub_exact00001", 5, PERIOD_END, { who: owner, role: "owner" });
    is(`${label}: free days are not given, nothing sent`, [gave, posted], [{ ok: false, reason: "unavailable" }, []]);
  }
  reset();
  customersPage = { object: "list", has_more: false };
  const find = await call(discountRoute, "member-discount", { action: "find", email: "member@example.com" });
  is("the discount route: 503 unavailable, saying it could not check", [find.status, find.body.error, String(find.body.message).includes("could not check")], [503, "unavailable", true]);
  const put = await call(discountRoute, "member-discount", { action: "apply", email: "member@example.com", subscription: "sub_exact00001", code: "promo_active0001" });
  is("the discount route's apply: 503 unavailable, nothing changed", [put.status, put.body.error, String(put.body.message).includes("Nothing was changed"), posted.length], [503, "unavailable", true, 0]);
  const days = await call(freeDaysRoute, "member-free-days", { action: "find", email: "member@example.com" });
  is("the free days route: 503 unavailable, saying it could not check", [days.status, days.body.error, String(days.body.message).includes("could not check")], [503, "unavailable", true]);
  const give = await call(freeDaysRoute, "member-free-days", { action: "give", email: "member@example.com", subscription: "sub_exact00001", days: 5, expected: PERIOD_END });
  is("the free days route's give: 503 unavailable, nothing changed", [give.status, give.body.error, String(give.body.message).includes("Nothing was changed"), posted.length], [503, "unavailable", true, 0]);
  reset();
  const healthy = await call(discountRoute, "member-discount", { action: "find", email: "nobody@example.com" });
  is("healthy control: nobody under that address is still 'none'", [healthy.status, healthy.body.memberships], [200, []]);

  part("A member's memberships over more than one page are all read");
  reset();
  paged = true;
  const both = await memberSubs(store, "member@example.com");
  is("both pages", Array.isArray(both) ? both.map((s) => s.id) : both, ["sub_first00001", "sub_second0001"]);

  part("The studio");
  const component = readFileSync("components/member-discount.tsx", "utf8");
  is("a membership whose discount could not be read gets no button and says so", component.includes("m.discounted === false ? (") && component.includes("whether a discount already comes off could not be read"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
