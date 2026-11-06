/** G derivative: reuses author synthetic creation fixture; all assertions below are independent. */
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
import { readListing, readProduct } from "@/lib/catalog";
import { openGroup, readGroup, revokeRefundedGroups, settleGroup, startGroup } from "@/lib/group-buy";
import { createCheckout } from "@/lib/store-checkout";
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


  part("G control: a refund on the tenth full page is reached");
  const control = await paidGroup("pi_GControl00001", 3);
  pages = Array.from({ length: 10 }, (_, page) => list(Array.from({ length: 100 }, (_, row) => other(page * 100 + row + 100)), page < 9));
  (pages[9] as { data: unknown[] }).data[99] = refund("re_GControl00001", "pi_GControl00001", now - 2000);
  reads.length = 0;
  await run();
  is("ten pages really read and valid refund closes the paid group", [reads.length, (await openGroup(store, control)) === null], [10, true]);

  part("G residual: an eleventh page is never reached by repeated capped runs");
  await redis.pipeline([["DEL", anchorKey]]);
  const beyond = await paidGroup("pi_GBeyond00001", 4);
  pages = Array.from({ length: 11 }, (_, page) => list(Array.from({ length: page === 10 ? 1 : 100 }, (_, row) => page === 10 ? refund("re_GBeyond00001", "pi_GBeyond00001", now - 5000) : other(page * 100 + row + 3000)), page < 10));
  const attempts: { after: (string | null)[]; anchor: unknown; open: boolean }[] = [];
  for (let repeat = 0; repeat < 3; repeat += 1) {
    reads.length = 0;
    await run();
    attempts.push({ after: reads.map((r) => r.after), anchor: await anchor(), open: (await openGroup(store, beyond)) !== null });
  }
  is("each repeat hits its ten-page bound and restarts from the same first page", attempts.map((r) => [r.after.length, r.after[0], r.anchor]), [[10, null, null], [10, null, null], [10, null, null]]);
  console.log("G_CAP", JSON.stringify(attempts));
  is("a later refund makes bounded progress across repeated runs", (await openGroup(store, beyond)) === null, true);

  part("G residual: dedup claim before confirmed group close prevents recovery");
  for (const mode of ["close failed before apply", "payment mapping reply lost"] as const) {
    await redis.pipeline([["DEL", anchorKey]]);
    const pi = mode === "close failed before apply" ? "pi_GCloseFail001" : "pi_GMapping001";
    const refundId = mode === "close failed before apply" ? "re_GCloseFail001" : "re_GMapping001";
    const group = await paidGroup(pi, mode === "close failed before apply" ? 5 : 6);
    pages = [list([refund(refundId, pi)])];
    const real = redis.pipeline.bind(redis);
    let hit = 0;
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (mode === "close failed before apply" && commands[0]?.[0] === "SET" && commands[0]?.[1] === `nl:grp:${group}` && JSON.parse(String(commands[0][2])).revoked) {
        hit += 1;
        throw new Error("G synthetic provider failure before group SET applied");
      }
      const replies = await real(commands);
      if (mode === "payment mapping reply lost" && commands[0]?.[0] === "SADD" && commands[1]?.[1] === `nl:grp:pi:${pi}`) { hit += 1; return [replies[0]]; }
      return replies;
    };
    try { await run().catch(() => 0); } finally { redis.pipeline = real; }
    const seen = (await redis.pipeline([["SISMEMBER", `nl:grp:${store.statsId}:seen`, refundId]]))[0];
    is(`${mode}: one real claim applied but group remains open`, [hit, seen, (await openGroup(store, group)) !== null], [1, 1, true]);
    await run();
    await run();
    is(`${mode}: later healthy runs recover the uncompleted refund`, (await openGroup(store, group)) === null, true);
  }
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
