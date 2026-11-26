/**
 * Issue #4754 (erasure, MEDIUM), the thanks page's path: a buyer erased from the store opens their old thanks page
 * again, which notes their purchase in the purchase library (lib/buyer-library.ts). A checkout paid before the
 * erasure must leave the library as the erasure left it; one paid after it is noted as any.
 * Synthetic store; in-memory Redis; Stripe stood in; nothing real is reached.
 */
import { renderToReadableStream } from "react-dom/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { storesBoughtFrom } from "@/lib/buyer-library";
import { erasePerson } from "@/lib/person-erasure";
import ThanksPage from "@/app/[handle]/thanks/page";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_i4754_thanks_stand_in";
const ACCOUNT = "acct_1TestThanksLib1";
const OWNER = "thanks-library@example.test";
const HANDLE = "thankslibrary";
const ORIGIN = "https://marktmorgen.com";
const BUYER = "erased-thanks-buyer@example.test";

let productId = "";
/** The checkouts Stripe knows, by id. */
const sessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  const id = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname)?.[1];
  if (id && sessions.has(id)) return new Response(JSON.stringify(sessions.get(id)));
  if (url.pathname === "/v1/account") return new Response(JSON.stringify({ id: ACCOUNT, country: "US" }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

function paid(id: string, created: number): void {
  sessions.set(id, {
    id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", created,
    amount_total: 4900, amount_subtotal: 4900, total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 }, currency: "usd", payment_intent: null,
    customer_details: { email: BUYER }, metadata: { store: HANDLE, product: productId },
  });
}

async function render(tree: unknown): Promise<string> {
  const stream = await renderToReadableStream(tree as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

async function open(session: string): Promise<void> {
  const query = { session_id: session };
  answering(new Request(`${ORIGIN}/@${HANDLE}/thanks?${new URLSearchParams(query)}`, { headers: { "x-forwarded-for": "203.0.113.9" } }));
  await render(await ThanksPage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve(query) }));
}

async function main(): Promise<void> {
  redis.clear();
  if (!(await claimHandle(OWNER, HANDLE, "Fictional Kitchen", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER); await ensureListId(OWNER); await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_thankslib1", subscriptionId: "sub_thankslib1", active: true, tier: "creator", period: paidPeriod() } as never);
  const made = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!made.ok) throw new Error(`no product: ${made.reason}`);
  productId = made.product.id;
  await setProductLink(OWNER, productId, "https://example.com/course");

  part("the thanks page of a checkout paid before the buyer's erasure");
  paid("cs_test_i4754thanks0000001", Math.floor(Date.now() / 1000) - 3600);
  await open("cs_test_i4754thanks0000001");
  is("(control) its first view puts the store in the buyer's library", (await storesBoughtFrom(BUYER)).length, 1);
  const erased = await erasePerson((await storeForEmail(OWNER))!, BUYER, { kind: "person" });
  is("the erasure succeeds", erased.ok, true);
  is("the library is empty after it", (await storesBoughtFrom(BUYER)).length, 0);
  await open("cs_test_i4754thanks0000001");
  is("opening the same thanks page again leaves the library empty", (await storesBoughtFrom(BUYER)).length, 0);

  part("the thanks page of a checkout paid after the erasure");
  paid("cs_test_i4754thanks0000002", Math.floor(Date.now() / 1000) + 5);
  await open("cs_test_i4754thanks0000002");
  is("the new purchase is noted, as any purchase", (await storesBoughtFrom(BUYER)).length, 1);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
