/**
 * A member who typed their address with capitals at checkout (Claude 5, the sibling of the manage link's fix on
 * claude5/manage-email-case). Stripe's hosted checkout keeps the address as typed on the customer it makes, and the
 * `email` filter of Stripe's customer list is case-sensitive. The studio's member tools (a discount code on one
 * membership, lib/member-discount.ts; free days, lib/member-free-days.ts) read the customers of the address in
 * small letters only, so a member Stripe holds as "Ana@Example.com" was never found: the code was not put on, and
 * the studio said the address had no running membership.
 * Synthetic only: the in-memory Redis double and a stand-in for Stripe through `fetch` that filters by email
 * exactly, as Stripe does. Nothing leaves the process.
 *
 *   - The address is read as typed and in small letters (two exact reads at most, never a sweep of the account),
 *     every customer of either once, newest first, within the one ceiling of 20 customers.
 *   - An address typed in small letters already is read once: no read past need.
 *   - Identity: a customer counts only when its own address is the one typed, ignoring capitals. A row of another
 *     address, or with none, proves nothing: the answer is unknown (null, "stripe"), never "not a member".
 *   - Past the ceiling, both spellings together are unknown, never a list missing one.
 *   - The studio routes hand the address as the creator typed it (trimmed), not in small letters.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStoreId, setStripeAccount, storeForEmail } from "@/lib/store";
import { applyMemberDiscount, memberSubs } from "@/lib/member-discount";
import { freeDaysSubs, giveFreeDays } from "@/lib/member-free-days";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_member_discount_case_only";
const now = 1_794_200_000;
const next = now + 86_400;

const sub = (id: string) => ({
  id,
  object: "subscription",
  status: "active",
  metadata: { store: "casestore", product: "prod_case00001" },
  items: { data: [{ current_period_end: next, price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] },
});
const customer = (id: string, email: string | undefined, created: number) => ({ id, object: "customer", ...(email === undefined ? {} : { email }), created });
const many = (prefix: string, email: string, n: number) => Array.from({ length: n }, (_, i) => customer(`cus_${prefix}${String(i).padStart(8, "0")}`, email, 100 + i));

/** Customers as Stripe holds them; the stand-in filters by `email` exactly (case-sensitive), as Stripe does. */
const CUSTOMERS = [
  customer("cus_Upper0000001", "Ana@Example.com", 1),
  customer("cus_Lower0000001", "ana@example.com", 2),
  customer("cus_Cleo00000001", "Cleo@Example.com", 3),
  customer("cus_Dee000000001", "Dee@Example.com", 4),
  customer("cus_Bea000000001", "BEA@EXAMPLE.COM", 5),
  ...many("Gil", "Gil@Example.com", 11),
  ...many("gil", "gil@example.com", 11),
];
const SUBS: Record<string, unknown[]> = {
  cus_Upper0000001: [sub("sub_Upper0000001")],
  cus_Lower0000001: [sub("sub_Lower0000001")],
  cus_Cleo00000001: [sub("sub_Cleo00000001")],
  cus_Dee000000001: [sub("sub_Dee000000001")],
  cus_Bea000000001: [sub("sub_Bea000000001")],
};
/** Rows Stripe would never give for the filter: another person's address, or none at all. */
let stray: ReturnType<typeof customer> | null = null;
let duplicate = false;
const reads: { path: string; email: string | null; customer: string | null }[] = [];
const posts: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("No external service");
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (init?.method === "POST") {
    posts.push(path);
    return answer({ id: path.split("/")[2] });
  }
  reads.push({ path, email: url.searchParams.get("email"), customer: url.searchParams.get("customer") });
  if (path === "/customers") {
    const email = url.searchParams.get("email") ?? "";
    const data: unknown[] = CUSTOMERS.filter((c) => c.email === email).sort((x, y) => y.created - x.created);
    if (stray && email === "Ana@Example.com") data.push(stray);
    // The same customer answered under both spellings: it must be read once.
    if (duplicate && email === "ana@example.com") data.push(customer("cus_Upper0000001", "Ana@Example.com", 1));
    return answer({ object: "list", data, has_more: false });
  }
  if (path === "/subscriptions") return answer({ object: "list", data: SUBS[url.searchParams.get("customer") ?? ""] ?? [], has_more: false });
  if (path === "/promotion_codes") return answer({ object: "list", data: [{ id: "promo_case000001", code: "THANKS", active: true, promotion: { type: "coupon", coupon: { id: "co_1", percent_off: 20, duration: "once" } } }], has_more: false });
  throw new Error(`Unexpected synthetic read ${path}`);
}) as typeof fetch;

const ids = (list: { id: string }[] | null) => (list === null ? null : list.map((s) => s.id));
const customerReads = () => reads.filter((r) => r.path === "/customers").map((r) => r.email);

async function main(): Promise<void> {
  redis.clear();
  const owner = "member-discount-case@example.com";
  await claimHandle(owner, "casestore", "Case Store", "");
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1CaseStorexxxxx", true);
  const store = (await storeForEmail(owner))!;
  const by = { who: owner, role: "owner" as const };

  part("A member Stripe holds with capitals is found");
  reads.length = 0;
  is("typed as Stripe holds it: the capitals' membership is found", ids(await memberSubs(store, "Cleo@Example.com")), ["sub_Cleo00000001"]);
  is("the address is read as typed and in small letters, nothing else", customerReads(), ["Cleo@Example.com", "cleo@example.com"]);
  is("free days find it too", ids(await freeDaysSubs(store, "Cleo@Example.com", now)), ["sub_Cleo00000001"]);
  is("the creator's code goes on it", await applyMemberDiscount(store, "Cleo@Example.com", "sub_Cleo00000001", "promo_case000001"), { ok: true });
  is("the code was put on that membership", posts, ["/subscriptions/sub_Cleo00000001"]);
  is("typed with spaces around it, the same member", ids(await memberSubs(store, "  Cleo@Example.com ")), ["sub_Cleo00000001"]);

  part("Both spellings of one address: every membership, newest customer first, each once");
  reads.length = 0;
  is("capitals and small letters together", ids(await memberSubs(store, "Ana@Example.com")), ["sub_Lower0000001", "sub_Upper0000001"]);
  is("two reads of customers, one per spelling", customerReads(), ["Ana@Example.com", "ana@example.com"]);
  duplicate = true;
  reads.length = 0;
  is("a customer answered under both spellings is listed once", ids(await memberSubs(store, "Ana@Example.com")), ["sub_Lower0000001", "sub_Upper0000001"]);
  is("and its memberships are read once", reads.filter((r) => r.path === "/subscriptions").length, 2);
  duplicate = false;

  part("Small letters typed: one read, no more than before");
  reads.length = 0;
  is("small letters find the small-letter customer", ids(await memberSubs(store, "ana@example.com")), ["sub_Lower0000001"]);
  is("one read of customers", customerReads(), ["ana@example.com"]);

  part("Identity: a row of another address proves nothing; unknown is never 'not a member'");
  for (const [what, row] of [
    ["another person's address", customer("cus_Mallory00001", "mallory@example.com", 9)],
    ["no address at all", customer("cus_Noaddress001", undefined, 9)],
    ["an address that is not text", { id: "cus_Badaddress01", object: "customer", email: 42, created: 9 } as unknown as ReturnType<typeof customer>],
  ] as const) {
    stray = row;
    reads.length = 0;
    is(`${what}: the member list is unknown, not a list without it`, await memberSubs(store, "Ana@Example.com"), null);
    is(`${what}: putting a code on is "stripe", never "not_member"`, await applyMemberDiscount(store, "Ana@Example.com", "sub_Upper0000001", "promo_case000001"), { ok: false, reason: "stripe" });
    is(`${what}: free days lookup is unknown`, await freeDaysSubs(store, "Ana@Example.com", now), null);
    is(`${what}: giving free days is "stripe", never "not_member"`, await giveFreeDays(store, "Ana@Example.com", "sub_Upper0000001", 7, next, by, now), { ok: false, reason: "stripe" });
    is(`${what}: the stray customer's memberships are never read`, reads.some((r) => r.path === "/subscriptions" && r.customer === row.id), false);
  }
  stray = null;

  part("The ceiling: both spellings together within 20 customers, past it unknown");
  reads.length = 0;
  is("11 + 11 customers of one address are past 20: unknown, never a list missing two", await memberSubs(store, "Gil@Example.com"), null);
  is("no membership of theirs was read past the ceiling", reads.filter((r) => r.path === "/subscriptions").length, 0);
  is("putting a code on is \"stripe\"", await applyMemberDiscount(store, "Gil@Example.com", "sub_Upper0000001", "promo_case000001"), { ok: false, reason: "stripe" });
  is("11 of one spelling alone are within it", (await memberSubs(store, "gil@example.com"))?.length, 0);

  part("The limit, said honestly: a spelling neither read asks for is not found, and the studio never says 'no membership'");
  reads.length = 0;
  is("member 'Dee@Example.com' typed in small letters, as the People list shows it: not found (Stripe's filter is exact)", ids(await memberSubs(store, "dee@example.com")), []);
  is("member 'BEA@EXAMPLE.COM' typed 'Bea@Example.com': not found either", ids(await memberSubs(store, "Bea@Example.com")), []);
  is("free days: the same limit", ids(await freeDaysSubs(store, "dee@example.com", now)), []);
  is("only the two spellings were asked, never a sweep of the account", customerReads(), ["dee@example.com", "Bea@Example.com", "bea@example.com", "dee@example.com"]);
  for (const [what, file] of [
    ["discount code", "components/member-discount.tsx"],
    ["free days", "components/member-free-days.tsx"],
  ] as const) {
    const screen = readFileSync(file, "utf8");
    is(`${what}: an empty list never says the address has no running membership`, /has no running membership/.test(screen), false);
    const status = screen.slice(screen.indexOf('role="status"'));
    const empty = status.slice(status.indexOf("found.memberships.length === 0 ?"), status.indexOf(") : "));
    is(
      `${what}: inside the status region, it says none was found and how to type the address so Stripe finds it`,
      [screen.includes('role="status"'), empty.includes("No running membership was found under ${found.email}."), empty.includes("Stripe matches capital letters exactly, so type the address the way the member typed it at checkout.")],
      [true, true, true],
    );
  }

  part("The studio routes hand the address as typed");
  const discountRoute = readFileSync("app/api/store/member-discount/route.ts", "utf8");
  const daysRoute = readFileSync("app/api/store/member-free-days/route.ts", "utf8");
  is("the discount's find reads the address as typed", discountRoute.includes("memberSubs(store, raw)"), true);
  is("the discount's apply reads the address as typed", discountRoute.includes("applyMemberDiscount(store, raw,"), true);
  is("free days' find reads the address as typed", daysRoute.includes("freeDaysSubs(store, raw)"), true);
  is("giving free days reads the address as typed", daysRoute.includes("giveFreeDays(store, raw,"), true);
  is("only one code was ever put on in this file", posts.length, 1);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
