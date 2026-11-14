/**
 * Buyer area hunt (Claude 7, 14 November 2026; synthetic only): "Already a member? Manage or cancel" finds the
 * member's customer on the creator's Stripe account (lib/membership-manage.ts, findMember). Every checkout makes a
 * customer and Stripe lists them newest first, twenty a page: findMember read only the first page, so a member whose
 * membership sits on an older customer was "not a member", and the page said a link was sent while none was. The list
 * is now read whole, up to MEMBER_CUSTOMER_PAGES, or not at all: more pages than that, or a page or a row it cannot
 * read, is unknown and throws (the route then says it could not be checked), never "not a member".
 */
import { MEMBER_CUSTOMER_PAGES, findMember } from "@/lib/membership-manage";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Page = { data: unknown; has_more: unknown };
let pages: Page[] = [];
let memberSubs: unknown = { object: "list", has_more: false, data: [{ id: "sub_Member0001", status: "active", created: 1, metadata: { store: "harbor", product: "p1" } }] };
const subsAsked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const json = (v: unknown) => new Response(JSON.stringify(v));
  if (path === "/customers") {
    const after = url.searchParams.get("starting_after");
    const at = after ? pages.findIndex((p) => Array.isArray(p.data) && (p.data as { id: string }[]).at(-1)?.id === after) + 1 : 0;
    return json({ object: "list", ...(pages[at] ?? { data: [], has_more: false }) });
  }
  if (path === "/subscriptions") {
    const customer = url.searchParams.get("customer") ?? "";
    subsAsked.push(customer);
    return json(customer === "cus_Member0001" ? memberSubs : { object: "list", has_more: false, data: [] });
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

const buyers = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `cus_Buyer${String(from + i).padStart(6, "0")}`, created: 1000 - from - i }));
const outcome = async (run: () => Promise<unknown>) => {
  try {
    return await run();
  } catch (error) {
    return `threw ${(error as Error).name}`;
  }
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_manage_only_a_stand_in";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  const store = (await storeForEmail("owner@example.com"))!;

  part("A live member behind the first page of customers");
  pages = [{ data: buyers(0, 20), has_more: true }, { data: [{ id: "cus_Member0001", created: 1 }], has_more: false }];
  is("the member's own customer is found on the second page", await findMember(store, "dana@example.com"), "cus_Member0001");
  is("and its memberships were read", subsAsked.includes("cus_Member0001"), true);

  part("More customers than are read is unknown, never 'not a member'");
  pages = Array.from({ length: MEMBER_CUSTOMER_PAGES + 1 }, (_, i) => ({ data: buyers(i * 20, 20), has_more: true }));
  is("throws, so the page says it could not be checked", await outcome(() => findMember(store, "dana@example.com")), "threw StripeListUnreadable");

  part("A page or a row it cannot read is unknown");
  pages = [{ data: buyers(0, 3), has_more: "maybe" }];
  is("a page whose has_more is not true or false throws", await outcome(() => findMember(store, "dana@example.com")), "threw StripeListUnreadable");
  pages = [{ data: [...buyers(0, 2), { created: 5 }], has_more: false }];
  is("a customer without an id throws", await outcome(() => findMember(store, "dana@example.com")), "threw StripeListUnreadable");
  pages = [{ data: [{ id: "cus_Member0001", created: 1 }], has_more: false }];
  memberSubs = { object: "list", has_more: true, data: [] };
  is("a customer's memberships past one page throw", await outcome(() => findMember(store, "dana@example.com")), "threw StripeListUnreadable");

  part("A whole list with no running membership is still 'not a member'");
  memberSubs = { object: "list", has_more: false, data: [{ id: "sub_Member0001", status: "canceled", created: 1, metadata: { store: "harbor" } }] };
  is("null", await findMember(store, "dana@example.com"), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
