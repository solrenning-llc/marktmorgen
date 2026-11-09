/**
 * CX-123 rules 24 and 30, lists from Stripe, lot 3 (a) (money and access; C4-20261106-0450-C5-16): the refunds
 * that take a purchase for several back (lib/group-buy.ts, revokeRefundedGroups) are read in Stripe's exact list
 * shape (lib/stripe-list.ts, refundRowKnown in lib/refunds.ts) and to their end. Against a stand-in for Stripe:
 *
 *   - a page in another shape never moves the anchor, and a row not readable holds it at that row's time (at the
 *     start of the pass when its time does not read), so those refunds are read again;
 *   - a refund on a later page is read and takes the purchase back, and the anchor moves only after the last page;
 *   - a refund on a readable row takes its purchase back even beside a row not readable (a "yes" stands), and the
 *     anchor holds at the start of the pass;
 *   - more pages than one run reads leave the anchor where it was, and the next run goes on from where the last
 *     stopped, so a refund past them is reached (Codex G on #2781, M1);
 *   - a refund is marked handled only once its work was written: the group's close failing, or the reply that names
 *     its purchase lost, marks nothing, and a later run takes the purchase back (Codex G on #2781, M2);
 *   - a purchase already closed whose places were not all taken back (a run that stopped halfway) has them taken back
 *     now (Claude 4 on #2781, M3);
 *   - a refund whose purchase record does not read never holds back the refunds after it: it is kept on a short
 *     list tried first on every run, and let go only once handled (it never expires); with that list full, the pass
 *     stays on its page;
 *     an anchor in another shape starts no pass (Claude 4 on #2781, C4-20261106-0645-C5-25);
 *   - the places a purchase handed out are read exactly: a list of them in another shape (null, an odd length, a
 *     value not text) or one place that does not read is unknown, never "nobody": the refund is not marked, waits to
 *     be tried again, and a healthy run takes the place back (Codex G on #2781, proof 1e7a4920; C4-20261106-0710-C5-29);
 *   - every read is pinned to the lot's version.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { askPlace, openGroup, readGroup, revokeRefundedGroups, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor, importedKey } from "@/lib/imported-purchases";
import { createCheckout } from "@/lib/store-checkout";
import { STRIPE_LIST_VERSION } from "@/lib/stripe-list";
import { advance, store as redis } from "./redis-stub";
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
  // The store's disputes closed (charge.dispute.closed, lib/refunds.ts lostDisputesSince): none, read to the end.
  if (path === "/events" && method === "GET") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
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
  // Rule 23: the refund and its charge now carry their amounts, as Stripe lists them: since the owner's decision 18 (9 November
  // 2026) a succeeded refund takes the places back only when its amount covers the charge, or the charge's refunds add up.
  const refund = (id: string, pi: string, created = now) => ({ id, object: "refund", created, status: "succeeded", amount: 4900, payment_intent: pi, charge: { refunded: true, amount: 4900 } });
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
  // Rule 23 (Claude 5, group-buy refunds with no anchor yet): was null ("the anchor stays"). With no anchor, a row not
  // readable now holds the anchor at its own time (now), so the week a later pass starts from never slides past it;
  // the next pass still reads that row again (from now - 300).
  is("a row not readable, with no anchor yet: the anchor holds at that row's time", await anchor(), String(now));

  part("group-buy.ts: refunds are read to their end");
  pages = [list([other(1), other(2)], true), list([other(3)], true), list([refund("re_LotThreeOurs001", "pi_LotThreeGroup01", now - 10)])];
  reads.length = 0;
  await run();
  is("each page is read, after the last row of the one before", reads.map((r) => r.after), [null, "re_LotThreeOther002", "re_LotThreeOther003"]);
  is("its refund on the third page takes the purchase back", Boolean((await readGroup(later))?.revoked), true);
  // Rule 23 (Claude 5, group-buy refunds with no anchor yet): was now - 1. The anchor held by the row not readable just
  // above (now) never goes back: it is the later of where it was and the newest refund read (now - 1).
  is("the anchor moves once the last page is read, never back before where it was", await anchor(), String(now));
  is("each read pinned to the lot's version", reads.every((r) => r.version === STRIPE_LIST_VERSION), true);

  part("group-buy.ts: a readable refund stands beside a row not readable; the anchor does not move");
  await redis.pipeline([["DEL", anchorKey]]);
  const beside = await paidGroup("pi_LotThreeGroup02", 2);
  pages = [list([refund("re_LotThreeOurs002", "pi_LotThreeGroup02"), "re_garbled"])];
  await run();
  is("the purchase is taken back", Boolean((await readGroup(beside))?.revoked), true);
  // Rule 23 (Claude 5, group-buy refunds with no anchor yet): was null. A row with no time that reads ("re_garbled")
  // now holds the anchor at the start of the pass, a week back, so the window never slides past it.
  const heldAt = Number(await anchor());
  is("and the anchor holds at the start of the pass, a week back", Math.abs(heldAt - (now - 7 * 86_400)) <= 5, true);

  part("group-buy.ts: more pages than one run reads");
  pages = Array.from({ length: 40 }, (_, n) => list([other(n + 10)], true));
  reads.length = 0;
  await run();
  is("read up to its own ceiling", reads.length > 1 && reads.length < 40, true);
  // Rule 23 (Claude 5, group-buy refunds with no anchor yet): was null; the anchor held just above stays where it was.
  is("and the anchor stays", await anchor(), String(heldAt));

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
    // Left unknown: kept on the list tried first on every run (Claude 4 on #2781), so the pass reaches its end.
    const waits = (await redis.pipeline([["HGET", `${anchorKey}:retry`, refundId]]))[0];
    if (mode === "the reply marking it handled is lost") is(`${mode}: the purchase is taken back, the refund waits to be marked`, [hit > 0, (await openGroup(store, group)) === null, waits], [true, true, pi]);
    // A write that throws stops the run itself: the pass stays on the page, and the next run does it again.
    else if (mode === "the close fails before it is written") is(`${mode}: nothing marked handled, the purchase still open, the run stopped on that page`, [hit > 0, await seen(refundId), (await openGroup(store, group)) !== null, waits, await anchor()], [true, 0, true, null, null]);
    else is(`${mode}: nothing marked handled, the purchase still open, the refund waits to be tried again`, [hit > 0, await seen(refundId), (await openGroup(store, group)) !== null, waits], [true, 0, true, pi]);
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

  part("group-buy.ts: one record that does not read never holds back the others (Claude 4 on #2781, proof d6f33d99)");
  await redis.pipeline([["DEL", anchorKey], ["DEL", `${anchorKey}:pass`]]);
  const retryKey = `${anchorKey}:retry`;
  const stuck = await paidGroup("pi_C4Stuck000001", 1);
  const behind = await paidGroup("pi_C4Behind00001", 2);
  // Our own record of the first purchase is there but does not read (a write cut short, a bad deploy).
  const stuckRecord = (await redis.pipeline([["GET", `nl:grp:${stuck}`]]))[0];
  await redis.pipeline([["SET", `nl:grp:${stuck}`, "{not json"]]);
  pages = [list([refund("re_C4Stuck000001", "pi_C4Stuck000001")], true), list([refund("re_C4Behind00001", "pi_C4Behind00001", now - 20)])];
  for (let n = 0; n < 3; n += 1) await run();
  is("the refunded purchase on the next page is taken back after three healthy runs", (await openGroup(store, behind)) === null, true);
  is("the unreadable one is not marked handled", await seen("re_C4Stuck000001"), 0);
  is("it waits on the list to be tried again, and the pass ended", [(await redis.pipeline([["HGET", retryKey, "re_C4Stuck000001"]]))[0], await anchor()], ["pi_C4Stuck000001", String(now)]);
  // Weeks pass with nothing new on the list (Claude 4 on #2781, C4-20261106-0700-C5-27): it waits all the same.
  advance(40 * 86_400_000);
  is("forty days later, with no new refund, it still waits: the list has no expiry", [(await redis.pipeline([["HGET", retryKey, "re_C4Stuck000001"]]))[0], (await redis.pipeline([["TTL", retryKey]]))[0]], ["pi_C4Stuck000001", -1]);
  await redis.pipeline([["SET", `nl:grp:${stuck}`, String(stuckRecord)]]);
  pages = [list([])];
  await run();
  is("once its record reads, the next run takes it back first, marks it and lets it go", [(await openGroup(store, stuck)) === null, await seen("re_C4Stuck000001"), (await redis.pipeline([["HEXISTS", retryKey, "re_C4Stuck000001"]]))[0]], [true, 1, 0]);

  part("group-buy.ts: with the list full, the pass stays on the page it could not hand over");
  await redis.pipeline([["DEL", anchorKey], ["DEL", `${anchorKey}:pass`], ["DEL", retryKey]]);
  const full2 = await paidGroup("pi_C4Full000001", 3);
  await redis.pipeline([["SET", `nl:grp:${full2}`, "{not json"]]);
  // A hundred waiting, each paid for a purchase whose record does not read either: none can be let go.
  await redis.pipeline(Array.from({ length: 100 }, (_, i) => ["HSET", retryKey, `re_Full${String(i).padStart(6, "0")}`, `pi_Full${String(i).padStart(6, "0")}`]));
  await redis.pipeline(Array.from({ length: 100 }, (_, i) => ["SET", `nl:grp:pi:pi_Full${String(i).padStart(6, "0")}`, full2]));
  pages = [list([refund("re_C4Full000001", "pi_C4Full000001")])];
  await run();
  is("not kept, not marked, and the anchor stays", [(await redis.pipeline([["HEXISTS", retryKey, "re_C4Full000001"]]))[0], (await redis.pipeline([["HLEN", retryKey]]))[0], await seen("re_C4Full000001"), await anchor()], [0, 100, 0, null]);

  part("group-buy.ts: the places handed out are read exactly (Codex G on #2781, proof 1e7a4920)");
  await redis.pipeline([["DEL", retryKey]]);
  for (const [n, bad] of [[0, null], [1, ["odd-field"]], [2, { broken: true }], [3, ["ana", "{not json"]]] as [number, unknown][]) {
    await redis.pipeline([["DEL", anchorKey], ["DEL", `${anchorKey}:pass`]]);
    const pi = `pi_GMembersUnknown${n}`;
    const refundId = `re_GMembersUnknown${n}`;
    const group = await paidGroup(pi, 10 + n);
    const email = `holder${n}@example.com`;
    const sent = await askPlace({ store, id: group, email, product, base: "https://marktmorgen.com/@lotthree", from: '"Lot Three" <hello@marktmorgen.com>', ordersLink: async () => null });
    const placeToken = mails.filter((m) => m.to[0] === email).at(-1)?.text.match(/\?take=([0-9a-f]{64})/)?.[1] ?? "";
    const taken = await takePlace({ store, token: placeToken, recordStart: async () => {} });
    const owner = (await storeForEmail("lotthree@example.com"))!;
    is(`places ${JSON.stringify(bad)}: a place was taken`, [sent, taken.outcome, (await importedFor(owner, email)).length], ["sent", "taken", 1]);
    pages = [list([refund(refundId, pi)])];
    const real = redis.pipeline.bind(redis);
    let hit = 0;
    redis.pipeline = async (commands: (string | number)[][]) => {
      const reply = await real(commands);
      if (commands[0]?.[0] === "HGETALL" && commands[0]?.[1] === `nl:grp:${group}:m`) {
        hit += 1;
        return [bad];
      }
      return reply;
    };
    try {
      await revokeRefundedGroups(owner, Date.now() + 30_000, async () => {});
    } finally {
      redis.pipeline = real;
    }
    is(`places ${JSON.stringify(bad)}: unknown, so not marked; the refund waits to be tried again; the place is still held`, [hit, await seen(refundId), (await redis.pipeline([["HGET", retryKey, refundId]]))[0], (await importedFor((await storeForEmail("lotthree@example.com"))!, email)).length], [1, 0, pi, 1]);
    await revokeRefundedGroups(owner, Date.now() + 30_000, async () => {});
    is(`places ${JSON.stringify(bad)}: a healthy run takes the place back and lets the refund go`, [(await importedFor((await storeForEmail("lotthree@example.com"))!, email)).length, await seen(refundId), (await redis.pipeline([["HEXISTS", retryKey, refundId]]))[0]], [0, 1, 0]);
  }

  part("group-buy.ts: one place that does not read never holds back the readable ones (Claude 4 on #2781, C4-20261106-0720-TODOS-30)");
  {
    await redis.pipeline([["DEL", anchorKey], ["DEL", `${anchorKey}:pass`], ["DEL", retryKey]]);
    const both = await paidGroup("pi_C4TwoPlaces01", 20);
    const email = "readable@example.com";
    const sent = await askPlace({ store, id: both, email, product, base: "https://marktmorgen.com/@lotthree", from: '"Lot Three" <hello@marktmorgen.com>', ordersLink: async () => null });
    const placeToken = mails.filter((m) => m.to[0] === email).at(-1)?.text.match(/\?take=([0-9a-f]{64})/)?.[1] ?? "";
    const taken = await takePlace({ store, token: placeToken, recordStart: async () => {} });
    is("a readable place was taken", [sent, taken.outcome], ["sent", "taken"]);
    // A second place, written by hand in a shape that does not read.
    await redis.pipeline([["HSET", `nl:grp:${both}:m`, "unreadable-place", "{not json"]]);
    pages = [list([refund("re_C4TwoPlaces01", "pi_C4TwoPlaces01")])];
    await revokeRefundedGroups((await storeForEmail("lotthree@example.com"))!, Date.now() + 30_000, async () => {});
    is("the readable place is taken back in the same run", (await importedFor((await storeForEmail("lotthree@example.com"))!, email)).length, 0);
    is("and the refund is not marked: it waits to be tried again for the one that did not read", [await seen("re_C4TwoPlaces01"), (await redis.pipeline([["HGET", retryKey, "re_C4TwoPlaces01"]]))[0]], [0, "pi_C4TwoPlaces01"]);
  }

  part("group-buy.ts: a place's own record that does not read is unknown, never 'came another way' (Claude 4 on #2781, C4-20261106-0725-C5-31)");
  {
    await redis.pipeline([["DEL", anchorKey], ["DEL", `${anchorKey}:pass`], ["DEL", retryKey]]);
    const odd = await paidGroup("pi_C4OddRecord01", 21);
    const email = "oddrecord@example.com";
    await askPlace({ store, id: odd, email, product, base: "https://marktmorgen.com/@lotthree", from: '"Lot Three" <hello@marktmorgen.com>', ordersLink: async () => null });
    const placeToken = mails.filter((m) => m.to[0] === email).at(-1)?.text.match(/\?take=([0-9a-f]{64})/)?.[1] ?? "";
    is("a place was taken", (await takePlace({ store, token: placeToken, recordStart: async () => {} })).outcome, "taken");
    const owner = (await storeForEmail("lotthree@example.com"))!;
    const recordKey = importedKey(owner.statsId!, email);
    const kept = (await redis.pipeline([["HGET", recordKey, product.id]]))[0];
    is("the place's record is where the purchase wrote it", typeof kept === "string" && String(kept).includes(`group:${odd}`), true);
    for (const bad of ["{not json", JSON.stringify({ job: 7 })]) {
      await redis.pipeline([["HSET", recordKey, product.id, bad], ["DEL", retryKey], ["DEL", anchorKey], ["DEL", `${anchorKey}:pass`]]);
      pages = [list([refund("re_C4OddRecord01", "pi_C4OddRecord01")])];
      await revokeRefundedGroups(owner, Date.now() + 30_000, async () => {});
      is(`a record ${bad}: unknown, the refund not marked and waiting`, [await seen("re_C4OddRecord01"), (await redis.pipeline([["HGET", retryKey, "re_C4OddRecord01"]]))[0]], [0, "pi_C4OddRecord01"]);
    }
    await redis.pipeline([["HSET", recordKey, product.id, String(kept)]]);
    await revokeRefundedGroups(owner, Date.now() + 30_000, async () => {});
    is("once the record reads, the place loses its access and the refund is let go", [(await importedFor((await storeForEmail("lotthree@example.com"))!, email)).length, await seen("re_C4OddRecord01")], [0, 1]);
  }

  part("group-buy.ts: an anchor in another shape starts no pass");
  await redis.pipeline([["DEL", retryKey], ["SET", anchorKey, "not a time"]]);
  reads.length = 0;
  await run();
  is("nothing is read from a week back", [reads.length, await anchor()], [0, "not a time"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
