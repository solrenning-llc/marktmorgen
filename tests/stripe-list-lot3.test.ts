/**
 * CX-123 rules 24 and 30, lists from Stripe, lot 3 (a) (money and access; C4-20261106-0450-C5-16): the refunds
 * that take a purchase for several back (lib/group-buy.ts, revokeRefundedGroups) are read in Stripe's exact list
 * shape (lib/stripe-list.ts, refundRowKnown in lib/refunds.ts) and to their end. Against a stand-in for Stripe:
 *
 *   - a page in another shape, or a row not readable, never moves the anchor, so those refunds are read again;
 *   - a refund on a later page is read and takes the purchase back, and the anchor moves only after the last page;
 *   - a refund on a readable row takes its purchase back even beside a row not readable (a "yes" stands), and the
 *     anchor stays;
 *   - more pages than one run reads leave the anchor where it was;
 *   - every read is pinned to the lot's version.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readGroup, revokeRefundedGroups, settleGroup, startGroup } from "@/lib/group-buy";
import { createCheckout } from "@/lib/store-checkout";
import { readProduct } from "@/lib/catalog";
import { STRIPE_LIST_VERSION } from "@/lib/stripe-list";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let pages: unknown[] = [];
const reads: { after: string | null; version: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") return new Response(JSON.stringify({ id: `cs_test_${"t".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  if (path === "/refunds" && method === "GET") {
    const after = url.searchParams.get("starting_after");
    reads.push({ after, version: new Headers(init?.headers).get("stripe-version") });
    const index = after ? pages.findIndex((p) => ((p as { data?: { id?: string }[] }).data ?? []).some((row) => row?.id === after)) + 1 : 0;
    return new Response(JSON.stringify(pages[Math.min(index, pages.length - 1)]));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const list = (data: unknown[], hasMore = false) => ({ object: "list", data, has_more: hasMore });
const GARBLED: [string, unknown][] = [
  ["no data", { object: "list", has_more: false }],
  ["data not a list", { object: "list", data: {}, has_more: false }],
  ["has_more missing", { object: "list", data: [] }],
  ["has_more as text", { object: "list", data: [], has_more: "false" }],
  ["not an object", []],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_lot_three_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  await claimHandle("lotthree@example.com", "lotthree", "Lot Three", "");
  await ensureStatsId("lotthree@example.com");
  await setStripeAccount("lotthree@example.com", "acct_1LotThreeGroup1", true);
  await setSubscription("lotthree@example.com", { customerId: "cus_LotThree001", subscriptionId: "sub_LotThree001", active: true, period: paidPeriod() });
  const made = await addProduct("lotthree@example.com", "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("lotthree@example.com", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("lotthree@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  const full = (await readProduct(store, product.id))!;
  /** A purchase for two, paid with this payment. */
  const paidGroup = async (pi: string, n: number): Promise<string> => {
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no purchase for several");
    await createCheckout(store, full, "https://marktmorgen.com", "", { group: { id: started.group.id, people: 2 }, digitalConsent: TEST_CONSENT });
    const meta = { store: "lotthree", product: product.id, group: started.group.id, people: "2" };
    const session = { id: "cs_test_" + String(n).repeat(24), created: 1_900_000_000, amount_total: 9800, currency: "usd", payment_intent: pi, metadata: meta, customer_details: { email: `buyer${n}@example.com` } };
    if ((await settleGroup({ store, session, product, base: "https://marktmorgen.com/@lotthree", from: '"Lot Three" <hello@marktmorgen.com>' })) !== "settled") throw new Error("not settled");
    return started.group.id;
  };
  const anchorKey = `nl:grp:${store.statsId}:refunds`;
  const anchor = async () => (await redis.pipeline([["GET", anchorKey]]))[0];
  const run = () => revokeRefundedGroups(store, Date.now() + 30_000, async () => {});
  const now = Math.floor(Date.now() / 1000);
  const refund = (id: string, pi: string, created = now) => ({ id, object: "refund", created, status: "succeeded", payment_intent: pi, charge: { refunded: true } });
  const other = (n: number) => refund(`re_LotThreeOther${String(n).padStart(3, "0")}`, `pi_LotThreeElse${String(n).padStart(3, "0")}`, now - n);

  part("group-buy.ts: refunds read in another shape never move the anchor");
  const later = await paidGroup("pi_LotThreeGroup01", 1);
  for (const [label, page] of GARBLED) {
    pages = [page];
    await run().catch(() => 0);
    is(`refunds answered ${label}: the anchor stays`, await anchor(), null);
  }
  pages = [list([other(1), { id: "re_LotThreeOdd001", created: now, status: "succeeded", payment_intent: 7, charge: { refunded: true } }])];
  await run().catch(() => 0);
  is("a row not readable: the anchor stays", await anchor(), null);

  part("group-buy.ts: refunds are read to their end");
  pages = [list([other(1), other(2)], true), list([other(3)], true), list([refund("re_LotThreeOurs001", "pi_LotThreeGroup01", now - 10)])];
  reads.length = 0;
  await run();
  is("each page is read, after the last row of the one before", reads.map((r) => r.after), [null, "re_LotThreeOther002", "re_LotThreeOther003"]);
  is("its refund on the third page takes the purchase back", Boolean((await readGroup(later))?.revoked), true);
  is("the anchor moves once the last page is read", await anchor(), String(now - 1));
  is("each read pinned to the lot's version", reads.every((r) => r.version === STRIPE_LIST_VERSION), true);

  part("group-buy.ts: a readable refund stands beside a row not readable; the anchor does not move");
  await redis.pipeline([["DEL", anchorKey]]);
  const beside = await paidGroup("pi_LotThreeGroup02", 2);
  pages = [list([refund("re_LotThreeOurs002", "pi_LotThreeGroup02"), "re_garbled"])];
  await run();
  is("the purchase is taken back", Boolean((await readGroup(beside))?.revoked), true);
  is("and the anchor stays", await anchor(), null);

  part("group-buy.ts: more pages than one run reads");
  pages = Array.from({ length: 40 }, (_, n) => list([other(n + 10)], true));
  reads.length = 0;
  await run();
  is("read up to its own ceiling", reads.length > 1 && reads.length < 40, true);
  is("and the anchor stays", await anchor(), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
