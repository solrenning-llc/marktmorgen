/** Independent G return: current transport boundary, old proofs untouched. */
/**
 * CX-123 rules 24 and 30, lists from Stripe, lot 3 (a) (money and access; C4-20261106-0450-C5-16): the refunds
 * that take a purchase for several back (lib/group-buy.ts, revokeRefundedGroups) are read in Stripe's exact list
 * shape (lib/stripe-list.ts, refundRowKnown in lib/refunds.ts) and to their end. Against a stand-in for Stripe:
 *
 *   - a page in another shape, or a row not readable, never moves the anchor, so those refunds are read again;
 *   - a refund on a later page is read and takes the purchase back, and the anchor moves only after the last page;
 *   - a refund on a readable row takes its purchase back even beside a row not readable (a "yes" stands), and the
 *     anchor stays;
 *   - more pages than one run reads leave the anchor where it was, and the next run goes on from where the last
 *     stopped, so a refund past them is reached (Codex G on #2781, M1);
 *   - a refund is marked handled only once its work was written: the group's close failing, or the reply that names
 *     its purchase lost, marks nothing, and a later run takes the purchase back (Codex G on #2781, M2);
 *   - a purchase already closed whose places were not all taken back (a run that stopped halfway) has them taken back
 *     now (Claude 4 on #2781, M3);
 *   - a refund whose purchase record does not read never holds back the refunds after it: it is kept on a short
 *     list tried first on every run, and let go once handled; with that list full, the pass stays on its page;
 *     an anchor in another shape starts no pass (Claude 4 on #2781, C4-20261106-0645-C5-25);
 *   - every read is pinned to the lot's version.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { askPlace, openGroup, readGroup, revokeRefundedGroups, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor } from "@/lib/imported-purchases";
import { createCheckout } from "@/lib/store-checkout";
import { STRIPE_LIST_VERSION } from "@/lib/stripe-list";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let pages: unknown[] = [];
const mails: { to: string[]; text: string }[] = [];
const reads: { after: string | null; version: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)) as { to: string[]; text: string });
    return new Response(JSON.stringify({ id: "email_1" }));
  }
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


  part("G return: two bounded runs reach the eleventh page");
  const beyond = await paidGroup("pi_GReturnBeyond01", 20);
  pages = Array.from({ length: 11 }, (_, page) => list(Array.from({ length: page === 10 ? 1 : 100 }, (_, row) => page === 10 ? refund("re_GReturnBeyond01", "pi_GReturnBeyond01", now - 5000) : other(page * 100 + row + 3000)), page < 10));
  reads.length = 0;
  await run();
  is("first run bounded and later group remains pending", [reads.length, (await openGroup(store, beyond)) !== null], [10, true]);
  reads.length = 0;
  await run();
  is("second run resumes after first pass while still bounded and revokes", [reads.length <= 10, reads[1]?.after, (await openGroup(store, beyond)) === null], [true, "re_LotThreeOther3999", true]);
  for (const [i, mode] of ["close", "mapping"].entries()) {
    await redis.pipeline([["DEL", anchorKey], ["DEL", `${anchorKey}:pass`]]);
    const pi = `pi_GReturnRecover${i}`;
    const id = `re_GReturnRecover${i}`;
    const group = await paidGroup(pi, 21 + i);
    pages = [list([refund(id, pi)])];
    const real = redis.pipeline.bind(redis);
    let hit = 0;
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (mode === "close" && commands[0]?.[0] === "SET" && commands[0]?.[1] === `nl:grp:${group}`) { hit += 1; throw new Error("G failure before application"); }
      const result = await real(commands);
      if (mode === "mapping" && commands[1]?.[0] === "GET" && commands[1]?.[1] === `nl:grp:pi:${pi}`) { hit += 1; return [result[0]]; }
      return result;
    };
    try { await run().catch(() => 0); } finally { redis.pipeline = real; }
    const seen = async () => (await redis.pipeline([["SISMEMBER", `nl:grp:${store.statsId}:seen`, id]]))[0];
    is(`${mode}: injection hit exact current boundary and no completion mark`, [hit, await seen(), (await openGroup(store, group)) !== null], [1, 0, true]);
    await run();
    is(`${mode}: healthy retry actually closes and completes`, [(await openGroup(store, group)) === null, await seen()], [true, 1]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
