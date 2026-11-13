/**
 * Issue #4469, Codex X8 report of 13/11/2026 06:41: a membership whose discount state
 * cannot be read (no `discounts` field, `discounts: null`, or an object in
 * place of the list) is taken for "no discount", so the studio sends an
 * update with only the new code and Stripe replaces the discount list.
 * Controls: an empty list applies the code; a list holding the live discount
 * refuses it.
 */
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { applyMemberDiscount } from "@/lib/member-discount";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_member_discount_only";

const PREV = { id: "di_live0000001", promotion_code: "promo_live000001" };
const SUB = "sub_live000001";
/** What Stripe answers in the membership's `discounts` place. */
let shape: Record<string, unknown> = { discounts: [] };
/** The discounts the subscription really carries, replaced by an update that sends only the new code. */
let live: unknown[] = [];
const posted: string[] = [];

const codes = [{ id: "promo_active0001", code: "THANKS", active: true, promotion: { type: "coupon", coupon: { id: "co_1", percent_off: 20, duration: "once" } } }];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/customers") return answer({ object: "list", data: url.searchParams.get("email") === "member@example.com" ? [{ id: "cus_member0001" }] : [], has_more: false });
  if (path === "/subscriptions") {
    return answer({
      object: "list",
      data: [{ id: SUB, status: "active", metadata: { store: "memberstore", product: "prod000001" }, items: { data: [{ price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] }, ...shape }],
      has_more: false,
    });
  }
  if (path === "/promotion_codes") return answer({ object: "list", data: codes, has_more: false });
  if (init?.method === "POST" && path.startsWith("/subscriptions/")) {
    const body = String(init.body);
    posted.push(body);
    // Stripe replaces the whole discount list with what the update sends.
    const sent = new URLSearchParams(body).get("discounts[0][promotion_code]");
    live = sent ? [{ id: "di_new0000001", promotion_code: sent }] : [];
    return answer({ id: SUB });
  }
  return answer({ object: "list", data: [] });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "member-discount@example.com";
  await claimHandle(owner, "memberstore", "Member Store", "");
  await setStripeAccount(owner, "acct_1Memberxxxxxxxx", true);
  const store = (await storeForEmail(owner))!;

  part("Controls");
  shape = { discounts: [] };
  live = [];
  posted.length = 0;
  is("no discount at all: the code goes on", await applyMemberDiscount(store, "member@example.com", SUB, "promo_active0001"), { ok: true });
  shape = { discounts: [PREV] };
  live = [PREV];
  posted.length = 0;
  is("the live discount listed: refused, never replaced", [await applyMemberDiscount(store, "member@example.com", SUB, "promo_active0001"), posted.length, live], [{ ok: false, reason: "discounted" }, 0, [PREV]]);

  part("A discount state that cannot be read");
  for (const [name, field] of [["no discounts field", {}], ["discounts: null", { discounts: null }], ["an object in place of the list", { discounts: { data: [PREV] } }]] as [string, Record<string, unknown>][]) {
    shape = field;
    live = [PREV];
    posted.length = 0;
    is(`${name}: the live discount is kept and nothing is sent`, [await applyMemberDiscount(store, "member@example.com", SUB, "promo_active0001"), posted.length, live], [{ ok: false, reason: "stripe" }, 0, [PREV]]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
