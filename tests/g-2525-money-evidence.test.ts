/** Independent G review: actual functions/route, synthetic Stripe and Redis. */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/member-discount/route";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { memberSubs, applyMemberDiscount } from "@/lib/member-discount";
import { claimHandle, ensureStoreId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as memory } from "./redis-stub";
import { done, is, part } from "./check";

const owner = "g2525@example.test", email = "member@example.test";
const customer = "cus_g252500001", id = "sub_g252500001", promo = "promo_g252500001";
const price = { unit_amount: 2900, currency: "usd", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } };
const item = { id: "si_g252500001", object: "subscription_item", quantity: 1, price };
const page = (data: unknown[]) => ({ object: "list", data, has_more: false });
const base = () => ({ id, object: "subscription", customer, status: "active", discounts: [], metadata: { store: "g2525store", product: "prod000001" }, items: page([item]) });
let row: Record<string, unknown>, postReply: unknown, posts = 0, applied = false, lost = false;
const previousFetch = globalThis.fetch, previousKey = process.env.STRIPE_SECRET_KEY;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw Error("No external request allowed");
  const respond = (v: unknown) => new Response(JSON.stringify(v));
  if (url.pathname === "/v1/customers") return respond(page([{ id: customer, object: "customer", email }]));
  if (url.pathname === "/v1/subscriptions") return respond(page([row]));
  if (url.pathname === "/v1/promotion_codes") return respond(page([{ id: promo, code: "SYNTHETIC", active: true, promotion: { type: "coupon", coupon: { id: "co_g2525", percent_off: 20, duration: "once" } } }]));
  if (url.pathname === `/v1/subscriptions/${id}` && init?.method === "POST") {
    posts++;
    if (lost) { applied = true; throw Error("Synthetic response lost AFTER application"); }
    return respond(postReply);
  }
  throw Error("Unexpected synthetic request " + url.pathname);
}) as typeof fetch;

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_g2525_synthetic_only";
  memory.clear();
  await claimHandle(owner, "g2525store", "Synthetic", "");
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_g2525synthetic", true);
  const store = (await storeForEmail(owner))!, session = await openSession(owner);
  const reset = () => { row = base(); posts = 0; applied = false; lost = false; postReply = { ...base(), discounts: ["di_g2525"] }; };
  part("Controls: known single-item membership and genuine acknowledged discount");
  reset();
  is("known one-item renewal remains 2900", (await memberSubs(store, email))?.[0]?.amount, 2900);
  is("known changed subscription remains success", [await applyMemberDiscount(store, email, id, promo), posts], [{ ok: true }, 1]);
  row = { ...base(), discounts: ["di_existing"] }; posts = 0;
  is("existing discount is never replaced", [await applyMemberDiscount(store, email, id, promo), posts], [{ ok: false, reason: "discounted" }, 0]);

  part("Incomplete/unsupported pricing cannot authorize a financial write");
  for (const [name, items] of [
    ["partial item page", { ...page([item]), has_more: true }],
    ["missing item completion", { data: [item] }],
    ["second unreadable item", page([item, {}])],
    ["quantity three", page([{ ...item, quantity: 3 }])],
    ["missing quantity", page([{ id: item.id, object: item.object, price }])],
    ["three-month interval", page([{ ...item, price: { ...price, recurring: { ...price.recurring, interval_count: 3 } } }])],
  ] as const) {
    reset(); row = { ...base(), items };
    const shown = await memberSubs(store, email);
    const result = await applyMemberDiscount(store, email, id, promo);
    console.log("OBSERVED pricing", name, JSON.stringify({ shown, result, posts }));
    // Supporting the precise total/period is also valid; current representation
    // cannot express it. Unknown must not be presented as the first unit price.
    if (name === "quantity three" || name === "three-month interval") {
      const exact = shown === null || (name === "quantity three"
        ? shown[0]?.amount === 8700
        : (shown[0] as unknown as { intervalCount?: unknown })?.intervalCount === 3);
      is(`${name}: total/period is exact or explicitly unknown`, exact, true);
      is(`${name}: unknown pricing cannot authorize POST`, shown === null ? posts === 0 : true, true);
    } else {
      is(`${name}: unsupported evidence remains unknown`, shown, null);
      is(`${name}: unsupported evidence makes no POST`, [result, posts], [{ ok: false, reason: "stripe" }, 0]);
    }
  }

  part("A matching id alone cannot prove that the requested discount was applied");
  for (const reply of [{ id }, { id, object: "charge" }, { ...base(), discounts: [] }, { id, object: "subscription", customer: "cus_other00001", discounts: ["di_g2525"] }]) {
    reset(); postReply = reply;
    const result = await applyMemberDiscount(store, email, id, promo);
    console.log("OBSERVED receipt", JSON.stringify({ reply, result, posts }));
    is("partial/contradictory update receipt is unknown, one POST only", [result, posts], [{ ok: false, reason: "stripe" }, 1]);
  }

  part("Real authenticated route must not claim rollback after a lost response");
  reset(); lost = true;
  const response = await POST(new NextRequest("https://marktmorgen.com/api/store/member-discount", {
    method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
    body: JSON.stringify({ action: "apply", email, subscription: id, code: promo }),
  }));
  const body = await response.json();
  console.log("OBSERVED real route", JSON.stringify({ status: response.status, body, posts, applied }));
  is("lost-response route is authenticated and sends only once", [response.status, body.error, posts, applied], [502, "stripe", 1, true]);
  is("lost-response message does not falsely assert nothing changed", /nothing was changed/i.test(String(body.message)), false);
}
main().finally(() => {
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey;
}).then(done).catch(error => { console.error(error); process.exit(1); });
