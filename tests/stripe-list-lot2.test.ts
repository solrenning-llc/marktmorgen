/**
 * CX-123 rules 24 and 30, lists from Stripe, lot 2 (lib/review-proof.ts):
 *
 *   - a membership bought through a subscription checkout is proved for a
 *     review from its first invoice's payment. A list of the invoice's
 *     payments read in another shape, or a failure to read it, was taken as
 *     "no payment", so the membership counted as not refunded and its review
 *     was let in. It is now not known: the proof says "error" (a 404 is
 *     still "no");
 *   - the pass that marks reviews of refunded orders read a refunds page in
 *     another shape, or with a row not readable, as the last page, and moved
 *     its anchor past refunds it never read. It now keeps the anchor.
 */
import { markRefundedReviews, provePurchase } from "@/lib/review-proof";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_stripe_list_lot2_only";

const OWNER = "lot2-reviews@example.com";
type Handler = (method: string, path: string, query: URLSearchParams) => Response | null;
let handler: Handler = () => null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  return handler(init?.method ?? "GET", path, url.searchParams) ?? Response.json({ error: { message: `no stand-in for ${path}` } }, { status: 404 });
}) as typeof fetch;
const list = (data: unknown[], hasMore = false) => Response.json({ object: "list", data, has_more: hasMore });
const GARBLED: [string, unknown][] = [
  ["no data", { object: "list", has_more: false }],
  ["data not a list", { object: "list", data: {}, has_more: false }],
  ["has_more missing", { object: "list", data: [] }],
  ["not an object", []],
];

async function membershipProof(): Promise<void> {
  part("review-proof.ts:95, a membership's first payment: not known from a list read in another shape");
  redis.clear();
  await claimHandle(OWNER, "lottworeviews", "Lot two reviews", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1LotTwoReview1", true);
  await setSubscription(OWNER, { customerId: "cus_LotTwo000001", subscriptionId: "sub_LotTwo000001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  const made = await addProduct(OWNER, "Weekly Club", "", "10", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const session = {
    id: "cs_test_lottwomembership01",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    amount_total: 1000,
    created: Math.floor(Date.now() / 1000) - 600,
    customer_details: { email: "buyer@example.com" },
    metadata: { store: "lottworeviews", product: made.product.id },
    payment_intent: null,
    invoice: "in_LotTwoFirst01",
  };
  let payments: unknown = null;
  handler = (method, path) => {
    if (method !== "GET") return null;
    if (path === `/checkout/sessions/${session.id}`) return Response.json(session);
    if (path === "/invoices/in_LotTwoFirst01") return Response.json({ id: "in_LotTwoFirst01", object: "invoice", payment_intent: null });
    if (path === "/invoice_payments") return Response.json(payments);
    if (path === "/payment_intents/pi_LotTwoPaid0001") return Response.json({ id: "pi_LotTwoPaid0001", object: "payment_intent", status: "succeeded", latest_charge: { id: "ch_LotTwo1", refunded: true, amount_refunded: 1000, amount: 1000, disputed: false } });
    return null;
  };
  for (const [label, page] of [...GARBLED, ["a row not readable", { object: "list", data: ["inpay_garbled"], has_more: false }] as [string, unknown]]) {
    payments = page;
    is(`its payments answered ${label}: not known, never a review let in on a guess`, (await provePurchase(store, session.id)).state, "error");
  }
  payments = { object: "list", data: [{ id: "inpay_LotTwo1", object: "invoice_payment", payment: { type: "payment_intent", payment_intent: "pi_LotTwoPaid0001" } }], has_more: false };
  const refunded = await provePurchase(store, session.id);
  is("read whole: its payment found, and the refund in full seen", [refunded.state, refunded.state === "ok" ? refunded.proof.refunded : null], ["ok", true]);
}

async function refundPass(): Promise<void> {
  part("review-proof.ts:305, the refunds pass: the anchor never moves past refunds it did not read");
  const store = (await storeForEmail(OWNER))!;
  const anchorKey = `nl:rev:refunds:since:${store.statsId}`;
  const before = Math.floor(Date.now() / 1000) - 3 * 86_400;
  const newer = before + 86_400;
  // A refund in full, newer than the anchor, readable: what moves the anchor when the page is read whole.
  const fresh = { id: "re_LotTwoNewer001", object: "refund", status: "succeeded", amount: 1000, created: newer, payment_intent: "pi_LotTwoPaid0001", charge: { id: "ch_LotTwo1", object: "charge", refunded: true, amount: 1000, amount_refunded: 1000, disputed: false } };
  let refunds: unknown = null;
  handler = (method, path) => {
    if (method !== "GET") return null;
    if (path === "/refunds") return Response.json(refunds);
    if (path === "/events") return list([]);
    if (path === "/payment_intents/pi_LotTwoPaid0001") return Response.json({ id: "pi_LotTwoPaid0001", object: "payment_intent", status: "succeeded" });
    return null;
  };
  const cases: [string, unknown][] = [
    ["no data", { object: "list", has_more: false }],
    ["data not a list", { object: "list", data: {}, has_more: false }],
    ["not an object", []],
    ["has_more missing, a newer refund on it", { object: "list", data: [fresh] }],
    ["has_more as text, a newer refund on it", { object: "list", data: [fresh], has_more: "false" }],
    ["a row not readable beside a newer refund", { object: "list", data: [fresh, "re_garbled"], has_more: false }],
    // Codex P on #2774 (review 5796364571): a refund whose charge does not say whether it was refunded is not
    // readable by the refunds' own rule (refundRowKnown, lib/refunds.ts), even though its status is text.
    ["a refund whose charge's refunded is not readable, beside a newer refund", { object: "list", data: [fresh, { id: "re_LotTwoUnknown1", object: "refund", status: "succeeded", created: before + 3_600, payment_intent: "pi_LotTwoOther001", charge: { id: "ch_LotTwo2", object: "charge", amount: 1000, amount_refunded: 1000 } }], has_more: false }],
  ];
  for (const [label, page] of cases) {
    redis.run(["SET", anchorKey, String(before)]);
    redis.run(["DEL", `nl:rev:refunds:seen:${store.statsId}`]);
    refunds = page;
    await markRefundedReviews(store, Date.now() + 30_000).catch(() => 0);
    is(`refunds answered ${label}: the anchor stays`, Number(redis.run(["GET", anchorKey])), before);
  }
  redis.run(["SET", anchorKey, String(before)]);
  refunds = { object: "list", data: [fresh], has_more: false };
  await markRefundedReviews(store, Date.now() + 30_000);
  is("read whole and readable: the anchor moves to the newest refund read", Number(redis.run(["GET", anchorKey])), newer);
}

async function main(): Promise<void> {
  await membershipProof();
  await refundPass();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
