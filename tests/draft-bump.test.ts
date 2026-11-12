/**
 * MM-SA-33 (docs/security-audit-2026-10-28.md): a draft product is never
 * offered, shown or sold as a checkout box (order bump) on another, published
 * product. canSellProduct says "A draft is not on sale until the creator
 * publishes it", the exit offer refuses a draft and the offers after paying
 * pass a draft over; the box now does the same (bumpTargetPause "targetDraft"):
 *
 *   1. a box the studio sets on a draft is kept, paused, and the studio says why;
 *   2. a box set on a product the creator later turns back into a draft is not
 *      one of activeBumps, so the public product page never draws its title or price;
 *   3. createCheckout never charges it as a line when the form names it.
 *
 * Synthetic data and stand-ins only: in-memory Redis, Stripe answered here.
 */
import { NextRequest } from "next/server";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { POST } from "@/app/api/store/extras/route";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { activeBumps, bumpStates, bumpTargets } from "@/lib/product-extras";
import { createCheckout } from "@/lib/store-checkout";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const checkouts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"d".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_draft_bump_stand_in";

  await claimHandle(OWNER, "draftbump", "Draft Bump", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDraftBump01", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const ids: Record<string, string> = {};
  for (const [title, price] of [["Course", "49"], ["Secret", "19"], ["Later", "29"]]) {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error(`no ${title}`);
    ids[title] = made.product.id;
    await setProductLink(OWNER, made.product.id, `https://example.com/${title.toLowerCase()}`);
  }
  // "Secret" is a draft from the start.
  await setProductHidden(OWNER, ids.Secret, true);

  let store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/extras", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as { ok: boolean; error?: string } };
  };

  // 1. The studio route takes a draft as a box's target.
  const asDraft = await call({ id: ids.Course, bump: { productId: ids.Secret, price: "9", pitch: "" }, slot: 0 });
  store = (await storeForEmail(OWNER))!;
  const kept = (await readProduct(store, ids.Course))!;
  const keptTargets = (await Promise.all(bumpTargets(kept).map((id) => readListing(store, id)))).filter((l) => l !== null);
  is(
    "a box set on a draft is kept, paused as a draft, and not offered",
    [asDraft.data.ok, bumpStates(keptTargets, kept).map((state) => ("paused" in state ? state.paused : "shown")), activeBumps(keptTargets, kept).length],
    [true, ["targetDraft"], 0],
  );

  // 2. A box set on a published product, which the creator then turns back into a draft.
  await setProductExtras(OWNER, ids.Course, { bump: { productId: ids.Later, priceCents: 1500, pitch: "" }, slot: 1 });
  await setProductHidden(OWNER, ids.Later, true);
  store = (await storeForEmail(OWNER))!;
  const course = (await readProduct(store, ids.Course))!;
  const listings = (await Promise.all(bumpTargets(course).map((id) => readListing(store, id)))).filter((l) => l !== null);
  const shown = activeBumps(listings, course).map((b) => b.target.title);
  is("no draft is drawn as a box on the public product page", shown, []);

  // 3. Ticked at checkout: a draft is not sold.
  checkouts.length = 0;
  await createCheckout(store, course, "https://marktmorgen.com", "", { bumps: [ids.Secret, ids.Later], digitalConsent: TEST_CONSENT });
  const sent = checkouts[0];
  const names: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const name = sent?.get(`line_items[${i}][price_data][product_data][name]`);
    if (name) names.push(name);
  }
  is("a draft ticked at checkout is not charged as a line", names, ["Course"]);
  done();
}

void main();
