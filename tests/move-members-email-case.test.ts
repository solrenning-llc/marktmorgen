/**
 * Whether a moved member already kept their membership (lib/move-members.ts, keptAlready), read whatever capitals
 * Stripe holds the address with (Claude 5, rule 30 sibling of claude5/member-discount-email-case). Stripe's hosted
 * checkout keeps the address as the buyer typed it on the customer it makes, and the `email` filter of Stripe's
 * customer list is case-sensitive; keptAlready read the address exactly once and loosely, so:
 *
 *   - a member Stripe holds as "ana@example.com" was not found for "Ana@Example.com" (and the other way round):
 *     the reminder to pay went to somebody who pays already, who could pay twice;
 *   - a row of another address, or of none, was taken as the member's: "kept" was said of somebody who did not;
 *   - a customers list past its ceiling, with more pages, or that is no list at all, and a subscriptions page
 *     with more pages or an unreadable row, were read as "not kept".
 *
 * Now the address is read as typed and in small letters (lib/address-customers.ts, one read when they are the
 * same), each customer once within KEPT_CUSTOMERS_MAX; a customer counts only when its own address is the one
 * asked for, ignoring capitals. A live membership found on a readable row is "kept"; "not kept" is said only of
 * lists read whole with every row readable; anything else throws, so sendMoveReminders puts the reminder back an
 * hour and sends nothing, never "not kept".
 * Synthetic only: a stand-in for Stripe through `fetch` that filters by email exactly, as Stripe does.
 */
import type { Store } from "@/lib/store";
import { keptAlready } from "@/lib/move-members";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_move_members_case_only";
const PRODUCT = "prod_MoveCase0001";
const store = { stripeAccountId: "acct_MoveCase000001" } as Store;

const customer = (id: string, email: string | undefined, created: number) => ({ id, object: "customer", ...(email === undefined ? {} : { email }), created });
const sub = (id: string, status: string, product = PRODUCT) => ({ id, object: "subscription", status, metadata: { store: "casestore", product } });
const many = (prefix: string, email: string, n: number) => Array.from({ length: n }, (_, i) => customer(`cus_${prefix}${String(i).padStart(8, "0")}`, email, 100 + i));

/** Customers as Stripe holds them; the stand-in filters by `email` exactly (case-sensitive), as Stripe does. */
const CUSTOMERS = [
  customer("cus_AnaLower00001", "ana@example.com", 1),
  customer("cus_BeaUpper00001", "Bea@Example.com", 2),
  customer("cus_IvyLower00001", "ivy@example.com", 3),
  customer("cus_JoTyped000001", "Jo@Example.com", 4),
  customer("cus_JoLower000001", "jo@example.com", 5),
  ...many("Gil", "gil@example.com", 11),
  ...many("Kim", "Kim@Example.com", 6),
  ...many("kim", "kim@example.com", 6),
];
const SUBS: Record<string, unknown> = {
  cus_AnaLower00001: { object: "list", data: [sub("sub_AnaLower00001", "active")], has_more: false },
  cus_BeaUpper00001: { object: "list", data: [sub("sub_BeaUpper00001", "trialing")], has_more: false },
  cus_IvyLower00001: { object: "list", data: [sub("sub_IvyLower00001", "canceled")], has_more: false },
  cus_JoTyped000001: { object: "list", data: [sub("sub_JoTyped000001", "canceled")], has_more: false },
  cus_JoLower000001: { object: "list", data: [sub("sub_JoLower000001", "past_due")], has_more: false },
};
/** Answers Stripe would never give for an exact filter, or garbled ones, by the address asked. */
const ODD_CUSTOMERS: Record<string, unknown> = {};
const reads: { path: string; email: string | null }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if ((init?.method ?? "GET") !== "GET") return new Response("{}", { status: 404 });
  const email = url.searchParams.get("email");
  reads.push({ path, email });
  if (path === "/customers") {
    if (email !== null && email in ODD_CUSTOMERS) return answer(ODD_CUSTOMERS[email]);
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const all = CUSTOMERS.filter((c) => c.email === email).sort((x, y) => y.created - x.created);
    return answer({ object: "list", data: all.slice(0, limit), has_more: all.length > limit });
  }
  if (path === "/subscriptions") return answer(SUBS[url.searchParams.get("customer") ?? ""] ?? { object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

/** true / false as keptAlready says it, or "unknown" when it refuses to say. */
async function kept(email: string): Promise<boolean | "unknown"> {
  try {
    return await keptAlready(store, email, PRODUCT);
  } catch {
    return "unknown";
  }
}
const customerReads = (from: number) => reads.slice(from).filter((r) => r.path === "/customers").map((r) => r.email);

async function main(): Promise<void> {
  part("The address is found whatever capitals Stripe holds it with");
  let mark = reads.length;
  is("Stripe holds ana@example.com; the address asked is Ana@Example.com: kept", await kept("Ana@Example.com"), true);
  is("read as asked and in small letters, two exact reads", customerReads(mark), ["Ana@Example.com", "ana@example.com"]);
  is("Stripe holds Bea@Example.com, asked as typed: kept", await kept("Bea@Example.com"), true);
  mark = reads.length;
  is("an address in small letters already: kept when it is", await kept("ana@example.com"), true);
  is("and read once, no read past need", customerReads(mark), ["ana@example.com"]);
  is("both spellings held: the live one on the small-letter customer counts", await kept("Jo@Example.com"), true);
  is("a membership that ended is not kept, every list read whole", await kept("ivy@example.com"), false);
  is("nobody under the address at all: not kept", await kept("nobody@example.com"), false);

  part("A row of another address proves nothing");
  ODD_CUSTOMERS["dan@example.com"] = { object: "list", data: [customer("cus_BeaUpper00001", "Bea@Example.com", 2)], has_more: false };
  is("another person's live membership is never taken as Dan's: unknown", await kept("dan@example.com"), "unknown");
  ODD_CUSTOMERS["eli@example.com"] = { object: "list", data: [customer("cus_EliNoMail0001", undefined, 7)], has_more: false };
  is("a row without its address: unknown, never 'not kept'", await kept("eli@example.com"), "unknown");
  ODD_CUSTOMERS["fay@example.com"] = { object: "list", data: [customer("cus_IvyLower00001", "ivy@example.com", 3), { object: "customer" }], has_more: false };
  is("a row of another address beside one without an id: unknown", await kept("fay@example.com"), "unknown");
  ODD_CUSTOMERS["ann@example.com"] = { object: "list", data: [customer("cus_AnaLower00001", "ann@example.com", 1), customer("cus_StrayNoMail01", undefined, 9)], has_more: false };
  is("a live membership on a readable row still stands beside a stray one", await kept("ann@example.com"), true);

  part("Past the ceiling, more pages, or no list: unknown, never 'not kept'");
  is("eleven customers under one spelling (the page has more)", await kept("gil@example.com"), "unknown");
  is("six and six under two spellings, past the ten together", await kept("Kim@Example.com"), "unknown");
  ODD_CUSTOMERS["hal@example.com"] = { object: "list", data: [], has_more: true };
  is("an empty page that says there is more", await kept("hal@example.com"), "unknown");
  ODD_CUSTOMERS["max@example.com"] = { object: "list", has_more: false };
  is("a customers answer that is no list", await kept("max@example.com"), "unknown");
  ODD_CUSTOMERS["ned@example.com"] = { object: "list", data: [] };
  is("a customers list that does not say whether it has more", await kept("ned@example.com"), "unknown");

  part("The member's subscriptions are read whole too");
  CUSTOMERS.push(customer("cus_OlaLower00001", "ola@example.com", 10), customer("cus_PiaLower00001", "pia@example.com", 11), customer("cus_RayLower00001", "ray@example.com", 12), customer("cus_SuzLower00001", "suz@example.com", 13));
  SUBS.cus_OlaLower00001 = { object: "list", data: [sub("sub_OlaLower00001", "canceled")], has_more: true };
  is("a page of ended ones that says there is more", await kept("ola@example.com"), "unknown");
  SUBS.cus_PiaLower00001 = { object: "list", has_more: false };
  is("a subscriptions answer that is no list", await kept("pia@example.com"), "unknown");
  SUBS.cus_RayLower00001 = { object: "list", data: [{ status: "canceled", metadata: { product: PRODUCT } }, { id: "sub_RayLower00002", status: "active" }], has_more: false };
  is("rows without an id or without metadata", await kept("ray@example.com"), "unknown");
  SUBS.cus_SuzLower00001 = { object: "list", data: [sub("sub_SuzLower00001", "active", "prod_Other000001"), sub("sub_SuzLower00002", "active")], has_more: true };
  is("a live one on a readable row is kept though the page has more", await kept("suz@example.com"), true);

  done();
}

void main();
