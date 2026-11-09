/**
 * The pass over a store's refunds that takes a purchase for several back (lib/group-buy.ts, revokeRefundedGroups),
 * against a stand-in that answers as Stripe does: one refund list per connected account (the Stripe-Account header),
 * read newest first, and a `starting_after` the account does not know answered 404 `resource_missing`, never as the
 * first page. What is checked (the sibling of M1 and M2 on #3301, which gifts and pre-orders had):
 *
 *   - a pass kept while the store was on another Stripe account is not read from on the new one: the run neither
 *     throws nor stops, and a refund on the new account's second page takes the purchase back in the first run;
 *   - a kept cursor the account answers 404 `resource_missing` for (a pass kept before its account was written
 *     with it, or a key that changed mode) is let go: the run never throws, starts the pass again from the top and
 *     takes the purchase back;
 *   - a row that is not readable never holds back the pages after it: a refund on a later page takes its purchase
 *     back in the same run, while the anchor stays where it was, so the next pass reads that row again; once it
 *     reads, the anchor moves;
 *   - a page whose last row is not readable goes on from its last readable row, so the page after it is reached.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { openGroup, revokeRefundedGroups, settleGroup, startGroup } from "@/lib/group-buy";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ACCOUNT_A = "acct_1GroupCursorA001";
const ACCOUNT_B = "acct_1GroupCursorB001";
/** Each account's refunds, newest first, as Stripe keeps them. */
const lists = new Map<string, unknown[]>();
const reads: { account: string; after: string | null; status: number }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") return new Response(JSON.stringify({ id: `cs_test_${"t".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  if (path === "/refunds" && method === "GET") {
    const account = new Headers(init?.headers).get("stripe-account") ?? "";
    const after = url.searchParams.get("starting_after");
    const since = Number(url.searchParams.get("created[gte]") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const all = (lists.get(account) ?? []).filter((row) => Number((row as { created?: unknown })?.created ?? Infinity) >= since);
    let from = 0;
    if (after) {
      const at = (lists.get(account) ?? []).findIndex((row) => (row as { id?: unknown })?.id === after);
      if (at < 0) {
        reads.push({ account, after, status: 404 });
        return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing", param: "starting_after", message: `No such refund: '${after}'` } }), { status: 404 });
      }
      from = all.indexOf((lists.get(account) ?? [])[at]) + 1;
    }
    reads.push({ account, after, status: 200 });
    return new Response(JSON.stringify({ object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_group_cursor_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  const OWNER = "groupcursor@example.com";
  await claimHandle(OWNER, "groupcursor", "Group Cursor", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT_A, true);
  await setSubscription(OWNER, { customerId: "cus_GroupCursor1", subscriptionId: "sub_GroupCursor1", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  const owner = async () => (await storeForEmail(OWNER))!;
  const product = (await readListing(await owner(), made.product.id))!;
  const full = (await readProduct(await owner(), product.id))!;
  /** A purchase for two, paid with this payment. */
  const paidGroup = async (pi: string, n: number): Promise<string> => {
    const store = await owner();
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no purchase for several");
    await createCheckout(store, full, "https://marktmorgen.com", "", { group: { id: started.group.id, people: 2 }, digitalConsent: TEST_CONSENT });
    const meta = { store: "groupcursor", product: product.id, group: started.group.id, people: "2" };
    const session = { id: "cs_test_" + String(n).repeat(24).slice(0, 24), created: 1_900_000_000, amount_total: 9800, currency: "usd", payment_intent: pi, metadata: meta, customer_details: { email: `buyer${n}@example.com` } };
    if ((await settleGroup({ store, session, product, base: "https://marktmorgen.com/@groupcursor", from: '"Group Cursor" <hello@marktmorgen.com>' })) !== "settled") throw new Error("not settled");
    return started.group.id;
  };
  const sid = (await owner()).statsId!;
  const anchorKey = `nl:grp:${sid}:refunds`;
  const passKey = `${anchorKey}:pass`;
  const anchor = async () => (await redis.pipeline([["GET", anchorKey]]))[0];
  const pass = async () => (await redis.pipeline([["GET", passKey]]))[0];
  const now = Math.floor(Date.now() / 1000);
  const refund = (id: string, pi: string, created: number) => ({ id, object: "refund", created, status: "succeeded", payment_intent: pi, charge: { refunded: true } });
  /** n refunds of payments made elsewhere, newest first, one second apart from `top` down. */
  const others = (prefix: string, n: number, top: number) => Array.from({ length: n }, (_, i) => refund(`re_${prefix}${String(i).padStart(6, "0")}`, `pi_${prefix}${String(i).padStart(6, "0")}`, top - i));
  /** One run, and whether it threw. */
  const run = async (): Promise<string> => {
    try {
      return String(await revokeRefundedGroups(await owner(), Date.now() + 60_000, async () => {}));
    } catch (error) {
      return `threw: ${(error as Error).message}`;
    }
  };
  const clean = () => redis.pipeline([["DEL", anchorKey], ["DEL", passKey], ["DEL", `${anchorKey}:retry`]]);

  part("A pass kept on the store's previous Stripe account");
  // Account A: 1,100 refunds, more than one run reads (ten pages of a hundred), so the first run keeps a pass.
  lists.set(ACCOUNT_A, others("GCurA", 1100, now - 10));
  // A purchase paid on account A, so the store has purchases for several to look after.
  await paidGroup("pi_GCurAOurs0001", 9);
  await clean();
  is("the first run on account A reads its ten pages", [await run(), reads.length], ["0", 10]);
  const keptA = JSON.parse(String(await pass())) as { after?: string };
  is("and keeps where it stopped: a refund of account A", keptA.after, "re_GCurA000999");
  // The creator connects another account. A purchase is paid there and refunded in full; its refund is the 150th
  // newest of account B's 250 (the second page).
  await setStripeAccount(OWNER, ACCOUNT_B, true);
  const onB = await paidGroup("pi_GCurBOurs0001", 1);
  const listB = others("GCurB", 250, now - 5);
  listB.splice(150, 0, refund("re_GCurBOurs0001", "pi_GCurBOurs0001", now - 155));
  lists.set(ACCOUNT_B, listB);
  reads.length = 0;
  const first = await run();
  is("the next run, on account B, does not throw", first.startsWith("threw"), false);
  is("account A's cursor is never sent to account B", reads.filter((r) => r.after?.startsWith("re_GCurA")).length, 0);
  is("and the refund on account B's second page takes the purchase back in that run", await openGroup(await owner(), onB), null);
  is("account B's list is read to its end, so the anchor moves to its newest refund", await anchor(), String(now - 5));

  part("A kept cursor the account does not know");
  await clean();
  const lost = await paidGroup("pi_GCurBOurs0002", 2);
  const listB2 = others("GCurC", 250, now - 5);
  listB2.splice(150, 0, refund("re_GCurBOurs0002", "pi_GCurBOurs0002", now - 155));
  lists.set(ACCOUNT_B, listB2);
  // A pass kept on this account in a shape whose cursor Stripe answers 404 for (one kept before the pass named its
  // account, or a key in another mode): written with the account it would be read on.
  await redis.pipeline([["SET", passKey, JSON.stringify({ since: now - 7 * 86_400, after: "re_GCurGone00001", newest: now - 5, account: ACCOUNT_B })]]);
  reads.length = 0;
  const unknown = await run();
  is("the run does not throw", unknown.startsWith("threw"), false);
  is("the cursor the account does not know is let go, never kept to be sent again", String((await pass()) ?? "").includes("re_GCurGone00001"), false);
  is("the pass starts again from the top in that run, and the refund on its second page takes the purchase back", await openGroup(await owner(), lost), null);
  is("one read was answered 404, and none after it", reads.filter((r) => r.status === 404).length, 1);
  is("the list is read to its end, so the anchor moves to its newest refund", await anchor(), String(now - 5));

  part("A row that is not readable never holds back the pages after it");
  await clean();
  await redis.pipeline([["SET", anchorKey, String(now - 3 * 86_400)]]);
  const behind = await paidGroup("pi_GCurBOurs0003", 3);
  const listOdd = others("GCurD", 250, now - 5);
  // The tenth newest: a status this code does not know, so the row is not readable.
  listOdd[10] = { ...listOdd[10], status: "weird_new_status" };
  listOdd.splice(150, 0, refund("re_GCurBOurs0003", "pi_GCurBOurs0003", now - 155));
  lists.set(ACCOUNT_B, listOdd);
  reads.length = 0;
  is("the run does not throw", (await run()).startsWith("threw"), false);
  is("the refund on the second page takes the purchase back in the same run", await openGroup(await owner(), behind), null);
  is("the anchor stays where it was, so the row not read is read again", await anchor(), String(now - 3 * 86_400));
  is("and no pass is left over: the next run starts from the top", [await pass(), reads.length], [null, 3]);
  listOdd[10] = { ...listOdd[10], status: "succeeded" };
  await run();
  is("once that row reads, the anchor moves to the newest refund read", await anchor(), String(now - 5));

  part("A page whose last row is not readable");
  await clean();
  await redis.pipeline([["SET", anchorKey, String(now - 3 * 86_400)]]);
  const tail = await paidGroup("pi_GCurBOurs0004", 4);
  const listTail = others("GCurE", 250, now - 5);
  listTail[99] = { ...listTail[99], status: "weird_new_status" };
  listTail.splice(150, 0, refund("re_GCurBOurs0004", "pi_GCurBOurs0004", now - 155));
  lists.set(ACCOUNT_B, listTail);
  reads.length = 0;
  await run();
  is("the next page is read from its last readable row", reads.map((r) => r.after).slice(0, 2), [null, "re_GCurE000098"]);
  is("and the refund on it takes the purchase back", await openGroup(await owner(), tail), null);
  is("the anchor stays where it was", await anchor(), String(now - 3 * 86_400));

  /** Everything a pass keeps, the account its anchor is of and the marks of the accounts left behind included. */
  const ownerKey = `${anchorKey}:acct`;
  const leftKey = `${anchorKey}:left`;
  const cleanAll = () => redis.pipeline([["DEL", anchorKey], ["DEL", passKey], ["DEL", `${anchorKey}:retry`], ["DEL", ownerKey], ["DEL", leftKey]]);
  /** What the code says in the log while a run goes. */
  const logged: string[] = [];
  const quiet = console.error;
  const listening = () => {
    logged.length = 0;
    console.error = (...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };
  const deaf = () => {
    console.error = quiet;
  };

  part("A store that goes back to an account it left (A, then B, then A again)");
  await cleanAll();
  await setStripeAccount(OWNER, ACCOUNT_A, true);
  lists.set(ACCOUNT_A, others("GCurF", 50, now - 3 * 86_400));
  const backOnA = await paidGroup("pi_GCurAOurs0005", 5);
  await run();
  is("account A read to its end: its anchor is its newest refund", await anchor(), String(now - 3 * 86_400));
  await setStripeAccount(OWNER, ACCOUNT_B, true);
  lists.set(ACCOUNT_B, others("GCurG", 50, now - 5));
  await run();
  is("account B read to its end: the anchor is B's newest refund", await anchor(), String(now - 5));
  // While the store is on B, the creator refunds in full, on account A, a purchase paid there: two days ago, older
  // than B's anchor and newer than A's.
  lists.set(ACCOUNT_A, [refund("re_GCurAOurs0005", "pi_GCurAOurs0005", now - 2 * 86_400), ...others("GCurF", 50, now - 3 * 86_400)]);
  await setStripeAccount(OWNER, ACCOUNT_A, true);
  reads.length = 0;
  is("back on A, the run does not throw", (await run()).startsWith("threw"), false);
  is("the refund made on A while the store was on B takes the purchase back", await openGroup(await owner(), backOnA), null);
  is("A is read from where A was left, never from B's anchor", reads.every((r) => r.account === ACCOUNT_A) && reads.length >= 1 && reads.length <= 10, true);
  is("and A's anchor is A's own newest refund", await anchor(), String(now - 2 * 86_400));

  part("Many accounts: the marks of the accounts left stay bounded, and a mark let go never loses a refund");
  const many = Array.from({ length: 20 }, (_, i) => `acct_1GroupCursorM${String(i).padStart(3, "0")}`);
  for (const other of many) {
    await setStripeAccount(OWNER, other, true);
    lists.set(other, []);
    await run();
  }
  const card = (await redis.pipeline([["ZCARD", leftKey]]))[0];
  is("at most sixteen accounts left are remembered", typeof card === "number" && card >= 1 && card <= 16, true);
  is("the newest marks are the ones let go: A's is among them", (await redis.pipeline([["ZSCORE", leftKey, ACCOUNT_A]]))[0], null);
  const evicted = await paidGroup("pi_GCurAOurs0006", 6);
  lists.set(ACCOUNT_A, [refund("re_GCurAOurs0006", "pi_GCurAOurs0006", now - 36 * 3_600), ...(lists.get(ACCOUNT_A) ?? [])]);
  await setStripeAccount(OWNER, ACCOUNT_A, true);
  reads.length = 0;
  await run();
  is("back on A, read from the oldest mark kept: the refund made meanwhile takes the purchase back", await openGroup(await owner(), evicted), null);
  is("inside one run's pages", reads.length >= 1 && reads.length <= 10, true);

  part("A page with no readable row, whose last id reads");
  await cleanAll();
  await setStripeAccount(OWNER, ACCOUNT_B, true);
  await redis.pipeline([["SET", anchorKey, String(now - 3 * 86_400)], ["SET", ownerKey, ACCOUNT_B]]);
  const pastBlank = await paidGroup("pi_GCurBOurs0007", 7);
  const listBlank = others("GCurH", 250, now - 5);
  for (let i = 100; i < 200; i += 1) listBlank[i] = { ...listBlank[i], status: "weird_new_status" };
  listBlank.splice(220, 0, refund("re_GCurBOurs0007", "pi_GCurBOurs0007", now - 224));
  lists.set(ACCOUNT_B, listBlank);
  reads.length = 0;
  is("the run does not throw", (await run()).startsWith("threw"), false);
  is("the page with no readable row is read past from its last row's id", reads.map((r) => r.after).slice(0, 3), [null, "re_GCurH000099", "re_GCurH000199"]);
  is("and the refund on the page after it takes the purchase back", await openGroup(await owner(), pastBlank), null);
  is("the anchor holds at the oldest row not read, so the next pass reads them again", await anchor(), String(now - 5 - 199));

  part("A page with no readable row and no id that reads");
  await cleanAll();
  await redis.pipeline([["SET", anchorKey, String(now - 3 * 86_400)], ["SET", ownerKey, ACCOUNT_B]]);
  const pastGarble = await paidGroup("pi_GCurBOurs0008", 8);
  const listGarble: unknown[] = others("GCurK", 250, now - 5);
  for (let i = 100; i < 200; i += 1) listGarble[i] = `garbled ${i}`;
  listGarble.splice(220, 0, refund("re_GCurBOurs0008", "pi_GCurBOurs0008", now - 224));
  lists.set(ACCOUNT_B, listGarble);
  reads.length = 0;
  listening();
  const stuck = await run();
  deaf();
  is("the run does not throw", stuck.startsWith("threw"), false);
  is("the pass stops at that page, inside one run's pages", reads.length, 2);
  is("and says so in the log: what is after it is unknown", logged.some((line) => line.includes("unknown")), true);
  is("the purchase is not said to be refunded or not: it stays as it was", (await openGroup(await owner(), pastGarble)) !== null, true);
  is("the anchor stays, so nothing after the page leaves the window", await anchor(), String(now - 3 * 86_400));
  reads.length = 0;
  listening();
  await run();
  deaf();
  is("the next run reads the newest page and that page again, and no more", reads.length, 2);
  is("and says so again", logged.some((line) => line.includes("unknown")), true);
  listGarble.splice(100, 100, ...others("GCurL", 100, now - 105));
  reads.length = 0;
  await run();
  is("once the page reads, the refund after it takes the purchase back", await openGroup(await owner(), pastGarble), null);

  part("No anchor yet: a row not readable holds the anchor at its own time");
  await cleanAll();
  const odd = refund("re_GCurJOdd00001", "pi_GCurJOdd00001", now - 6 * 86_400);
  lists.set(ACCOUNT_B, [...others("GCurJ", 30, now - 5), { ...odd, status: "weird_new_status" }]);
  await run();
  is("the anchor is the time of the row not read, six days back, never left to slide past it", await anchor(), String(now - 6 * 86_400));
  await cleanAll();
  lists.set(ACCOUNT_B, [...others("GCurJ", 30, now - 5), { id: "re_GCurJOdd00002", object: "refund", status: "succeeded" }]);
  await run();
  const held = Number(await anchor());
  is("a row with no time that reads holds the anchor at the start of the pass, seven days back", Math.abs(held - (now - 7 * 86_400)) <= 5, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
