/**
 * A member's Stripe lists cut short are unknown, never complete (CX-123 rule
 * 24; r24 inventory, money item PR-F, member-discount half). memberSubs
 * (lib/member-discount.ts) read a member's customers and their memberships
 * with one page each and never looked at has_more, and a page in a shape that
 * cannot be read became an empty list: a running membership past the page
 * read as "not a running one of this member", and an unreadable answer as
 * "nobody under that address", so the studio was told something Stripe never
 * said and the discount decision was made on a guess.
 *
 * Now every page is read in its exact shape (a list and a has_more): the
 * memberships of a customer are followed page by page up to a bound, and past
 * it, or with more customers under the address than are read, or on a page or
 * a customer row that cannot be read, Stripe "could not be read": memberSubs
 * answers "unreadable" (null stays "Stripe could not be reached") and
 * applyMemberDiscount changes nothing ("unavailable"), which the route says as
 * "Stripe's answer could not be read ... Nothing was changed".
 * Healthy controls: a whole list decides as before, and a confirmed empty list
 * is still "nobody". The read is bounded by one budget of Stripe pages for the
 * whole find (the base's worst: the customers' page and one a customer at the
 * most customers read), counted here call by call, so a larger bound or a
 * smaller page fails; past it the answer is unknown, as any cut list is.
 */
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { applyMemberDiscount, memberSubs } from "@/lib/member-discount";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_member_lists_cut_short";

const posted: string[] = [];
/** Every list page asked of Stripe (customers and memberships), and the page size each membership page asked. */
let gets = 0;
const sizes = new Set<string>();
/** Answers for /customers, and for /subscriptions by the `starting_after` asked (the first page under ""). */
let customersPage: unknown = { object: "list", data: [], has_more: false };
let subscriptionPages: Record<string, unknown> = {};

const membership = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "active",
  metadata: { store: "cutshortmember", product: "prod000001" },
  items: { data: [{ price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] },
  // Stripe's own shape: an empty list when no discount is on it (a missing one is "not known", #2979).
  discounts: [],
  ...extra,
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/customers") {
    gets += 1;
    return answer(customersPage);
  }
  if (path === "/subscriptions") {
    gets += 1;
    sizes.add(url.searchParams.get("limit") ?? "");
    const page = subscriptionPages[url.searchParams.get("starting_after") ?? ""];
    return page === undefined ? answer({ error: { message: "no such page" } }, 404) : answer(page);
  }
  if (path === "/promotion_codes") {
    return answer({ object: "list", has_more: false, data: [{ id: "promo_active0001", code: "THANKS", active: true, promotion: { type: "coupon", coupon: { id: "co_1", percent_off: 20, duration: "once" } } }] });
  }
  if (init?.method === "POST" && path.startsWith("/subscriptions/")) {
    posted.push(path);
    return answer({ id: path.split("/")[2] });
  }
  return answer({ error: { message: "no such" } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  part("Member discount: a whole list decides as before (controls)");
  const owner = "cut-short-member@example.com";
  await claimHandle(owner, "cutshortmember", "Member Store", "");
  await setStripeAccount(owner, "acct_1CutShortMember", true);
  const store = (await storeForEmail(owner))!;
  const quiet = console.error;
  console.error = () => {};
  try {
    customersPage = { object: "list", data: [{ id: "cus_member0001" }], has_more: false };
    subscriptionPages = { "": { object: "list", data: [membership("sub_live000001")], has_more: false } };
    is("a whole list: the membership is found", (await memberSubs(store, "member@example.com"))?.map((s) => s.id), ["sub_live000001"]);
    is("and the code goes on", await applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_active0001"), { ok: true });
    customersPage = { object: "list", data: [], has_more: false };
    is("nobody under that address, said so whole: none", await memberSubs(store, "nobody@example.com"), []);
    customersPage = { object: "list", data: [{ id: "cus_member0001" }], has_more: false };
    subscriptionPages = { "": { object: "list", data: [], has_more: false } };
    is("a member with no membership, said so whole: none, and 'not a member'", [await memberSubs(store, "member@example.com"), await applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_active0001")], [[], { ok: false, reason: "not_member" }]);

    part("Member discount: a list cut short or unreadable is unknown");
    posted.length = 0;
    customersPage = { object: "list", data: [{ id: "cus_member0001" }], has_more: true };
    is("more customers under that address than were read: Stripe could not be read", await memberSubs(store, "member@example.com"), "unreadable");
    customersPage = { object: "list", data: [{ id: "cus_member0001" }], has_more: false };
    subscriptionPages = {
      "": { object: "list", data: Array.from({ length: 100 }, (_, i) => membership(`sub_other${String(i).padStart(5, "0")}`, { status: "canceled" })), has_more: true },
      sub_other00099: { object: "list", data: [membership("sub_later000001")], has_more: false },
    };
    is("a membership past the first page is found, not 'not a member'", (await memberSubs(store, "member@example.com"))?.map((s) => s.id), ["sub_later000001"]);
    is("and the code goes on it", await applyMemberDiscount(store, "member@example.com", "sub_later000001", "promo_active0001"), { ok: true });
    posted.length = 0;
    subscriptionPages = {};
    let after = "";
    for (let page = 0; page < 40; page += 1) {
      const rows = Array.from({ length: 100 }, (_, i) => membership(`sub_p${String(page).padStart(2, "0")}x${String(i).padStart(4, "0")}`, { status: "canceled" }));
      subscriptionPages[after] = { object: "list", data: rows, has_more: true };
      after = rows[rows.length - 1].id;
    }
    is("more memberships than the bound of pages: Stripe could not be read, nothing is changed", [await memberSubs(store, "member@example.com"), await applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_active0001"), posted.length], ["unreadable", { ok: false, reason: "unavailable" }, 0]);

    part("Member discount: one find waits on no more Stripe pages than the base's worst (21)");
    const twenty = { object: "list", data: Array.from({ length: 20 }, (_, i) => ({ id: `cus_crowd${String(i).padStart(4, "0")}` })), has_more: false };
    customersPage = twenty;
    subscriptionPages = { "": { object: "list", data: [membership("sub_one0000001", { status: "canceled" })], has_more: false } };
    gets = 0;
    sizes.clear();
    is("twenty customers of one page each: read whole", await memberSubs(store, "member@example.com"), []);
    is("in exactly 21 pages", gets, 21);
    is("memberships are read 100 to a page", [...sizes], ["100"]);
    // Twenty customers of five pages each: 101 pages at five a customer, so past the budget the answer is unknown.
    subscriptionPages = {};
    let chain = "";
    for (let page = 0; page < 5; page += 1) {
      const rows = Array.from({ length: 100 }, (_, i) => membership(`sub_c${String(page).padStart(2, "0")}x${String(i).padStart(4, "0")}`, { status: "canceled" }));
      subscriptionPages[chain] = { object: "list", data: rows, has_more: page < 4 };
      chain = rows[rows.length - 1].id;
    }
    posted.length = 0;
    gets = 0;
    is("twenty customers of five pages each: Stripe could not be read whole", await memberSubs(store, "member@example.com"), "unreadable");
    is("and the find stopped within 21 pages", gets <= 21, true);
    gets = 0;
    is("apply changes nothing on it", [await applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_active0001"), posted.length], [{ ok: false, reason: "unavailable" }, 0]);
    is("and its read stopped within 21 pages as well", gets <= 21, true);
    customersPage = { object: "list", data: [{ id: "cus_member0001" }], has_more: false };
    gets = 0;
    is("one customer of five pages: within the budget, read whole", await memberSubs(store, "member@example.com"), []);
    is("in 6 pages", gets, 6);

    for (const [name, page] of [
      ["no list at all", { object: "list" }],
      ["no word on whether there is more", { object: "list", data: [] }],
    ] as const) {
      customersPage = page;
      is(`customers, ${name}: Stripe could not be read, not 'nobody'`, await memberSubs(store, "member@example.com"), "unreadable");
    }
    customersPage = { object: "list", data: [{ id: "cus_member0001" }], has_more: false };
    for (const [name, page] of [
      ["no list at all", { object: "list" }],
      ["no word on whether there is more", { object: "list", data: [membership("sub_live000001")] }],
    ] as const) {
      subscriptionPages = { "": page };
      is(`memberships, ${name}: Stripe could not be read, not 'not a member'`, [await memberSubs(store, "member@example.com"), await applyMemberDiscount(store, "member@example.com", "sub_live000001", "promo_active0001")], ["unreadable", { ok: false, reason: "unavailable" }]);
    }
    customersPage = { object: "list", data: [{ id: 42 }], has_more: false };
    is("a customer row with no id that can be read: Stripe could not be read", await memberSubs(store, "member@example.com"), "unreadable");
  } finally {
    console.error = quiet;
  }

  done();
}

main();
