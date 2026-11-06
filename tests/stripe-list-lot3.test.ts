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

  part("group-buy.ts: a pass longer than one run goes on from where it stopped (Codex G on #2781, M1)");
  await redis.pipeline([["DEL", anchorKey], ["DEL", `${anchorKey}:pass`]]);
  const beyond = await paidGroup("pi_GBeyond00001", 4);
  pages = Array.from({ length: 11 }, (_, page) => list(Array.from({ length: page === 10 ? 1 : 100 }, (_, row) => (page === 10 ? refund("re_GBeyond00001", "pi_GBeyond00001", now - 5000) : other(page * 100 + row + 3000))), page < 10));
  reads.length = 0;
  await run();
  is("the first run reads its ten pages and stops", [reads.length, reads[0].after, Boolean(await openGroup(store, beyond)), await anchor()], [10, null, true, null]);
  reads.length = 0;
  await run();
  is("the next reads the newest page, then goes on from where the first stopped", reads.map((r) => r.after), [null, "re_LotThreeOther3999"]);
  is("and reaches the refund on the eleventh page", (await openGroup(store, beyond)) === null, true);
  is("the anchor moves once the pass reached the end, to the newest refund read", await anchor(), String(now - 3000));
  reads.length = 0;
  await run();
  is("and the next pass starts from the top again", reads[0]?.after ?? null, null);

  part("group-buy.ts: marked handled only once the work was written (Codex G on #2781, M2)");
  const seen = (id: string) => redis.pipeline([["SISMEMBER", `nl:grp:${store.statsId}:seen`, id]]).then((r) => r[0]);
  const modes = ["the close fails before it is written", "the reply naming its purchase is lost", "the reply marking it handled is lost"] as const;
  for (const [i, mode] of modes.entries()) {
    await redis.pipeline([["DEL", anchorKey], ["DEL", `${anchorKey}:pass`]]);
    const pi = `pi_GMedium00000${i}`;
    const refundId = `re_GMedium00000${i}`;
    const group = await paidGroup(pi, 5 + i);
    pages = [list([refund(refundId, pi)])];
    const real = redis.pipeline.bind(redis);
    let hit = 0;
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (mode === "the close fails before it is written" && commands[0]?.[0] === "SET" && commands[0]?.[1] === `nl:grp:${group}`) {
        hit += 1;
        throw new Error("a stand-in failure before the close was written");
      }
      const replies = await real(commands);
      if (mode === "the reply naming its purchase is lost" && commands[1]?.[1] === `nl:grp:pi:${pi}`) {
        hit += 1;
        return [replies[0]];
      }
      if (mode === "the reply marking it handled is lost" && commands[0]?.[0] === "SADD" && commands[0]?.[2] === refundId) {
        hit += 1;
        return ["QUEUED"];
      }
      return replies;
    };
    try {
      await run().catch(() => 0);
    } finally {
      redis.pipeline = real;
    }
    const after = [hit > 0, await anchor()];
    if (mode === "the reply marking it handled is lost") is(`${mode}: the purchase is taken back, the pass stays on that page`, [...after, (await openGroup(store, group)) === null], [true, null, true]);
    else is(`${mode}: nothing marked handled, the purchase still open, the anchor stays`, [...after, await seen(refundId), (await openGroup(store, group)) !== null], [true, null, 0, true]);
    await run();
    is(`${mode}: the next run takes it back and marks it handled`, [(await openGroup(store, group)) === null, await seen(refundId)], [true, 1]);
  }

  part("group-buy.ts: a purchase closed halfway has its places taken back (Claude 4 on #2781, M3)");
  await redis.pipeline([["DEL", anchorKey], ["DEL", `${anchorKey}:pass`]]);
  const halfway = await paidGroup("pi_GHalfway0001", 8);
  const asked = await askPlace({ store, id: halfway, email: "ana@example.com", product, base: "https://marktmorgen.com/@lotthree", from: '"Lot Three" <hello@marktmorgen.com>', ordersLink: async () => null });
  const token = mails.filter((m) => m.to[0] === "ana@example.com").at(-1)?.text.match(/\?take=([0-9a-f]{64})/)?.[1] ?? "";
  const took = await takePlace({ store, token, recordStart: async () => {} });
  const holder = (await storeForEmail("lotthree@example.com"))!;
  is("a place was taken with the purchase", [asked, took.outcome, (await importedFor(holder, "ana@example.com")).length], ["sent", "taken", 1]);
  // A run that wrote the close and then stopped before the places: the record says closed, the place is still held.
  const record = JSON.parse(String((await redis.pipeline([["GET", `nl:grp:${halfway}`]]))[0])) as Record<string, unknown>;
  await redis.pipeline([["SET", `nl:grp:${halfway}`, JSON.stringify({ ...record, revoked: Math.floor(Date.now() / 1000) })]]);
  pages = [list([refund("re_GHalfway0001", "pi_GHalfway0001")])];
  const dropped: string[] = [];
  const back = await revokeRefundedGroups(holder, Date.now() + 30_000, async (email) => void dropped.push(email));
  is("the place still held is taken back", [back, (await importedFor((await storeForEmail("lotthree@example.com"))!, "ana@example.com")).length, dropped], [1, 0, ["ana@example.com"]]);
  is("and the refund is marked handled", await seen("re_GHalfway0001"), 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
