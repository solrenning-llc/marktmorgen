/**
 * A pass over the creator's refunds longer than one run goes on where the
 * last run stopped (CX-123 rule 24; r24 money inventory, item 1, the gap left
 * by #3188).
 *
 * revokeRefundedGifts (lib/gifts.ts) and revokeRefundedPreorders
 * (lib/preorders.ts) read at most a few pages of refunds (100 each, newest
 * first) per store per run and keep the anchor while the list is not read to
 * its end. With more refunds since the anchor than one run reads, every run
 * read the same newest pages again and never reached the older ones: a gift or
 * a pre-order refunded in full long ago kept its access forever. Checked
 * against a stand-in for the creator's Stripe account that pages as Stripe
 * does, through the real gift and pre-order journeys:
 *
 *   - 450 refunds, the oldest a full refund of what was sold here: the second
 *     run goes on from where the first stopped, takes it back, and only then
 *     moves the anchor and lets the pass go;
 *   - a run that resumes reads the newest page first, so a refund made
 *     meanwhile does not wait for the pass;
 *   - a row that cannot be handled, or that is not readable at all, never
 *     holds the older pages: the pass goes on in the same run, the row is
 *     never marked read, and the anchor waits at it (or, for a row not
 *     readable, where it was), so the next pass reads it again; a page whose
 *     last row is not readable goes on from its last readable one (reviews of
 *     #3301, Claude 2 M1 and Claude 5);
 *   - a pass kept from the store's earlier Stripe account starts over on the
 *     account the store has now, never sends the old cursor (Claude 2 M2);
 *   - a kept pass in an unknown shape (not text, not the pass's JSON, another
 *     anchor's window, figures outside its window: Claude 2 L1) starts the
 *     pass over from the anchor, never skips;
 *   - a refund not final yet (pending, its charge not refunded in full) read
 *     on an early page of a pass holds the anchor at its time when the pass
 *     ends in a later run, so the next pass reads it again and takes it back
 *     once it goes through;
 *   - the first reads in another shape do nothing and ask nothing of Stripe.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { importedFor } from "@/lib/imported-purchases";
import { confirmPreorder, revokeRefundedPreorders } from "@/lib/preorders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
const ACCOUNT = "acct_1TestPassRef001";
const OTHER_ACCOUNT = "acct_1TestPassRef002";

/** The store's refunds, newest first, as Stripe lists them. */
let refunds: Record<string, unknown>[] = [];
/** The refunds of another connected account, by account (the one above is ACCOUNT's). */
const byAccount: Record<string, Record<string, unknown>[]> = {};
const refundCalls: URLSearchParams[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds") {
    refundCalls.push(url.searchParams);
    const rows = byAccount[new Headers(init?.headers).get("Stripe-Account") ?? ""] ?? refunds;
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const at = after ? rows.findIndex((row) => row.id === after) : -1;
    // As Stripe answers a cursor it does not know on this account.
    if (after && at < 0) return answer({ error: { type: "invalid_request_error", code: "resource_missing", message: `No such refund: '${after}'` } }, 404);
    const from = at + 1;
    const data = rows.slice(from, from + limit);
    return answer({ object: "list", data, has_more: from + limit < rows.length });
  }
  if (path === "/events") return answer({ object: "list", data: [], has_more: false });
  if (path.startsWith("/payment_intents/")) return answer({ id: path.split("/")[2], object: "payment_intent", latest_charge: { object: "charge", refunded: false, amount: 2500, amount_refunded: 0 } });
  return answer({ error: { message: `no stand-in for ${init?.method ?? "GET"} ${path}` } }, 404);
}) as typeof fetch;

/** `count` full refunds, newest first, created from `newest` down; the one at `at` paid with `pi`, the rest unrelated. */
function list(tag: string, count: number, newest: number, at: number, pi: string): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `re_${tag}${String(i).padStart(6, "0")}`,
    object: "refund",
    created: newest - i,
    status: "succeeded",
    payment_intent: i === at ? pi : `pi_${tag}other${String(i).padStart(6, "0")}`,
    charge: { object: "charge", refunded: true },
  }));
}

type Job = {
  name: string;
  anchor: string;
  pass: string;
  run: (dropStart?: (email: string, product: string) => Promise<void>) => Promise<number>;
  /** Makes one paid item (a gift given, or a pre-order handed over) and returns its payment, who holds it and whether it is still held. */
  make: (n: number) => Promise<{ pi: string; who: string; holds: () => Promise<boolean> }>;
  /** Connects the store to another Stripe account (or back). */
  connect: (account: string) => Promise<void>;
};

const afters = () => refundCalls.map((q) => q.get("starting_after"));

async function check(job: Job, base: number): Promise<void> {
  const read = async (key: string) => (await redis.pipeline([["GET", key]]))[0];
  const id = (tag: string, i: number) => `re_${job.name}${tag}${String(i).padStart(6, "0")}`;

  part(`${job.name}: 450 refunds, the oldest one of an item sold here: the pass goes on where it stopped`);
  const oldest = await job.make(1);
  refunds = list(`${job.name}a`, 450, base, 449, oldest.pi);
  refundCalls.length = 0;
  is(`${job.name}: run 1 reads its pages and nothing of this store yet`, await job.run(), 0);
  is(`${job.name}: run 1 asked three pages, from the newest`, afters(), [null, id("a", 99), id("a", 199)]);
  is(`${job.name}: run 1 leaves the anchor where it was`, await read(job.anchor), null);
  is(`${job.name}: still held after run 1`, await oldest.holds(), true);
  refundCalls.length = 0;
  is(`${job.name}: run 2 goes on from where run 1 stopped and takes the oldest back`, await job.run(), 1);
  is(`${job.name}: no longer held`, await oldest.holds(), false);
  is(`${job.name}: run 2 read the newest page first, then went on from the last row run 1 read`, afters(), [null, id("a", 299), id("a", 399)]);
  is(`${job.name}: read to its end, the anchor moves to the newest refund`, await read(job.anchor), String(base));
  is(`${job.name}: and the pass is let go`, await read(job.pass), null);

  part(`${job.name}: a row that cannot be handled never holds the pages behind it`);
  const stuck = await job.make(2);
  const behind = await job.make(4);
  refunds = list(`${job.name}b`, 450, base + 900, 10, stuck.pi);
  refunds[150] = { ...refunds[150], payment_intent: behind.pi };
  const failing = async (email: string) => {
    if (email === stuck.who) throw new Error("the ledger did not answer");
  };
  refundCalls.length = 0;
  is(`${job.name}: run 1, one row's course removal fails: the refund on the next page is still taken back`, await job.run(failing), 1);
  is(`${job.name}: the one behind it is no longer held`, await behind.holds(), false);
  is(`${job.name}: the row not handled is still held, never taken as done`, await stuck.holds(), true);
  is(`${job.name}: run 1 went on past the page with the row not handled`, afters(), [null, id("b", 99), id("b", 199)]);
  is(`${job.name}: run 2 ends the pass, the row still not handled`, await job.run(failing), 0);
  is(`${job.name}: the anchor waits at the row not handled, never past it`, await read(job.anchor), String(base + 900 - 10));
  is(`${job.name}: and the pass is let go`, await read(job.pass), null);
  is(`${job.name}: once it can be handled, the next pass takes it back`, await job.run(), 1);
  is(`${job.name}: no longer held`, await stuck.holds(), false);
  await job.run();
  is(`${job.name}: the anchor moves once the pass ends`, await read(job.anchor), String(base + 900));

  part(`${job.name}: a refund made while a pass is under way does not wait for it`);
  const late = await job.make(3);
  refunds = list(`${job.name}c`, 450, base + 1800, -1, "pi_unused");
  await job.run();
  refunds = [...list(`${job.name}n`, 1, base + 2400, 0, late.pi), ...refunds];
  is(`${job.name}: the resuming run takes the new refund back from the newest page`, await job.run(), 1);
  is(`${job.name}: no longer held, the newest page read first`, await late.holds(), false);

  part(`${job.name}: a kept pass in an unknown shape starts the pass over, never skips`);
  const kinds = [
    ["not JSON", "not a pass"],
    ["another anchor's window", JSON.stringify({ since: base - 5_000, after: id("d1", 299), newest: base + 3000 })],
    ["a cursor that is not an id", JSON.stringify({ since: base + 1800 - 300, after: "re_ bad", newest: base + 3000 })],
    // The anchor's window, but figures a pass never keeps (Claude 2 L1): each would move the anchor wrongly.
    ["a newest refund in the future", JSON.stringify({ since: base + 1800 - 300, after: id("d3", 299), newest: NOW + 100_000, account: ACCOUNT })],
    ["a newest refund before its window", JSON.stringify({ since: base + 1800 - 300, after: id("d4", 299), newest: base + 1000, account: ACCOUNT })],
    ["a refund waiting from before its window", JSON.stringify({ since: base + 1800 - 300, after: id("d5", 299), newest: base + 3000, waiting: base + 1000, account: ACCOUNT })],
  ] as const;
  for (const [k, [label, kept]] of kinds.entries()) {
    const tag = `d${k}`;
    const anchorBefore = await read(job.anchor);
    const far = await job.make(10 + k);
    refunds = list(`${job.name}${tag}`, 450, base + 3000, 449, far.pi);
    await redis.pipeline([["SET", job.pass, kept]]);
    refundCalls.length = 0;
    is(`${job.name}, ${label}: nothing taken back in a run that started over`, await job.run(), 0);
    is(`${job.name}, ${label}: started over from the newest page`, afters(), [null, id(tag, 99), id(tag, 199)]);
    is(`${job.name}, ${label}: the anchor stays`, await read(job.anchor), anchorBefore);
    is(`${job.name}, ${label}: the next run reaches the oldest`, await job.run(), 1);
    is(`${job.name}, ${label}: taken back`, await far.holds(), false);
    is(`${job.name}, ${label}: the anchor moves`, await read(job.anchor), String(base + 3000));
    await redis.pipeline([["SET", job.anchor, anchorBefore as string]]);
  }

  part(`${job.name}: a kept pass in a reply that is not text starts over`);
  const odd = await job.make(30);
  refunds = list(`${job.name}e`, 450, base + 3000, 449, odd.pi);
  const original = redis.pipeline;
  redis.pipeline = async (commands) => {
    const replies = await original.call(redis, commands);
    return commands.length === 3 && commands[2][0] === "GET" && commands[2][1] === job.pass ? [replies[0], replies[1], 7] : replies;
  };
  refundCalls.length = 0;
  try {
    await job.run();
  } finally {
    redis.pipeline = original;
  }
  is(`${job.name}: a pass read as a number starts over from the newest page`, afters(), [null, id("e", 99), id("e", 199)]);
  is(`${job.name}: then the pass goes on`, await job.run(), 1);
  is(`${job.name}: taken back`, await odd.holds(), false);

  part(`${job.name}: a refund not final yet, read early in a pass, holds the anchor when the pass ends`);
  const slow = await job.make(40);
  refunds = list(`${job.name}f`, 450, base + 4000, -1, "pi_unused");
  // On the second page: pending, its charge not refunded in full yet (lib/gifts.ts, lib/preorders.ts heldAt).
  refunds[150] = { ...refunds[150], status: "pending", payment_intent: slow.pi, charge: { object: "charge", refunded: false } };
  is(`${job.name}: run 1 takes nothing back from a refund not final yet`, await job.run(), 0);
  is(`${job.name}: the kept pass carries the time of that refund`, JSON.parse(String(await read(job.pass))).waiting, base + 4000 - 150);
  is(`${job.name}: run 2 ends the pass, still nothing taken back`, await job.run(), 0);
  is(`${job.name}: still held while it is pending`, await slow.holds(), true);
  is(`${job.name}: the anchor waits at that refund, not at the newest one the pass read`, await read(job.anchor), String(base + 4000 - 150));
  is(`${job.name}: and the pass is let go`, await read(job.pass), null);
  refunds[150] = { ...refunds[150], status: "succeeded", charge: { object: "charge", refunded: true } };
  is(`${job.name}: once it goes through, the next pass takes it back`, await job.run(), 1);
  is(`${job.name}: no longer held once refunded in full`, await slow.holds(), false);
  await job.run();
  is(`${job.name}: then the anchor moves to the newest refund`, await read(job.anchor), String(base + 4000));

  part(`${job.name}: a row not readable never holds the pages behind it, and is never taken as done`);
  const anchorBefore = await read(job.anchor);
  const unread = await job.make(50);
  const later = await job.make(51);
  refunds = list(`${job.name}g`, 450, base + 5000, 10, unread.pi);
  // Not readable: a status Stripe does not list (lib/refunds.ts refundRowKnown), on row 10 and on the last row of the first page.
  refunds[10] = { ...refunds[10], status: "weird_new_status" };
  refunds[99] = { ...refunds[99], status: "weird_new_status" };
  refunds[250] = { ...refunds[250], payment_intent: later.pi };
  refundCalls.length = 0;
  is(`${job.name}: run 1 takes back the refund behind the rows not readable`, await job.run(), 1);
  is(`${job.name}: the one behind is no longer held`, await later.holds(), false);
  is(`${job.name}: the row not readable is never taken as a refund`, await unread.holds(), true);
  is(`${job.name}: a page whose last row is not readable goes on from its last readable one`, afters(), [null, id("g", 98), id("g", 198)]);
  is(`${job.name}: run 2 ends the pass`, await job.run(), 0);
  is(`${job.name}: the anchor stays where it was: the row not readable is read again`, await read(job.anchor), anchorBefore);
  is(`${job.name}: and the pass is let go`, await read(job.pass), null);
  is(`${job.name}: still held while its row is not readable`, await unread.holds(), true);
  refunds[10] = { ...refunds[10], status: "succeeded" };
  refunds[99] = { ...refunds[99], status: "succeeded" };
  is(`${job.name}: once readable, the next pass takes it back`, await job.run(), 1);
  is(`${job.name}: no longer held`, await unread.holds(), false);
  await job.run();
  is(`${job.name}: then the anchor moves to the newest refund`, await read(job.anchor), String(base + 5000));

  part(`${job.name}: a pass kept from the store's earlier Stripe account starts over on the one it has now`);
  const moved = await job.make(60);
  refunds = list(`${job.name}h`, 450, base + 6000, -1, "pi_unused");
  await job.run();
  is(`${job.name}: a pass is kept on the first account`, JSON.parse(String(await read(job.pass))).after, id("h", 299));
  byAccount[OTHER_ACCOUNT] = list(`${job.name}i`, 200, base + 6000, 150, moved.pi);
  await job.connect(OTHER_ACCOUNT);
  refundCalls.length = 0;
  let threw = "";
  let taken = -1;
  try {
    taken = await job.run();
  } catch (error) {
    threw = String(error);
  }
  is(`${job.name}: the run on the new account does not fail`, threw, "");
  is(`${job.name}: it never sends the old account's cursor, and reads the new account from its newest refund`, afters(), [null, id("i", 99)]);
  is(`${job.name}: and takes back the new account's full refund`, taken, 1);
  is(`${job.name}: no longer held`, await moved.holds(), false);
  await job.connect(ACCOUNT);
  delete byAccount[OTHER_ACCOUNT];

  part(`${job.name}: the first reads in another shape do nothing`);
  redis.pipeline = async (commands) => (commands.length === 3 && commands[2][1] === job.pass ? [1, null] : original.call(redis, commands));
  refundCalls.length = 0;
  try {
    is(`${job.name}: a cut reply takes nothing back`, await job.run(), 0);
  } finally {
    redis.pipeline = original;
  }
  is(`${job.name}: and asks nothing of Stripe`, refundCalls.length, 0);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_refund_pass_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_refund_pass_only";

  await claimHandle("owner@pass.example", "passshop", "Pass Shop", "");
  await ensureStatsId("owner@pass.example");
  await setStripeAccount("owner@pass.example", ACCOUNT, true);
  await setSubscription("owner@pass.example", { customerId: "cus_PassOwner001", subscriptionId: "sub_PassOwner001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@pass.example", "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@pass.example", made.product.id, "https://example.com/course");
  let store = (await storeForEmail("owner@pass.example"))!;
  const product = (await readListing(store, made.product.id))!;
  const connect = async (account: string) => {
    await setStripeAccount("owner@pass.example", account, true);
    store = (await storeForEmail("owner@pass.example"))!;
  };
  const deps = {
    base: "https://marktmorgen.com/@passshop",
    from: '"Pass Shop" <hello@marktmorgen.com>',
    ordersLink: async (email: string) => `https://marktmorgen.com/@passshop/orders?for=${encodeURIComponent(email)}`,
    recordStart: async () => {},
  };
  const holds = async (email: string) => (await importedFor((await storeForEmail("owner@pass.example")) as Store, email)).length > 0;
  const fine = async () => {};

  await check({
    name: "gift",
    anchor: `nl:gift:${store.statsId}:refunds`,
    pass: `nl:gift:${store.statsId}:refunds:pass`,
    run: (dropStart = fine) => revokeRefundedGifts(store, Date.now() + 60_000, dropStart),
    connect,
    make: async (n) => {
      const to = `friend${n}@pass.example`;
      const started = await startGift(store, product as Listing, { to, from: "Ana", message: "" });
      if (!started.ok) throw new Error("no gift");
      const pi = `pi_passgift${String(n).padStart(8, "0")}`;
      const given = await deliverGift({
        store,
        session: { id: `cs_test_passgift${String(n).padStart(8, "0")}`, created: NOW - 600, amount_total: 2500, currency: "usd", payment_intent: pi, metadata: { store: "passshop", product: product.id, gift: started.gift.id }, customer_details: { email: "buyer@pass.example" } } as never,
        product: product as Listing,
        base: deps.base,
        from: deps.from,
        recordStart: async () => {},
        ordersLink: async () => null,
      });
      if (given !== "given") throw new Error(`gift ${n} not given: ${given}`);
      return { pi, who: to, holds: () => holds(to) };
    },
  }, NOW - 10_000);

  await check({
    name: "pre",
    anchor: `nl:pre:${store.statsId}:refunds`,
    pass: `nl:pre:${store.statsId}:refunds:pass`,
    run: (dropStart = fine) => revokeRefundedPreorders(store, Date.now() + 60_000, dropStart),
    connect,
    make: async (n) => {
      const email = `buyer${n}@pass.example`;
      const pi = `pi_passpre${String(n).padStart(8, "0")}`;
      const session = {
        id: `cs_test_passpre${String(n).padStart(8, "0")}`,
        created: NOW - 600,
        status: "complete",
        payment_status: "paid",
        amount_total: 2500,
        currency: "usd",
        payment_intent: pi,
        metadata: { store: "passshop", product: product.id, preorder: "yes" },
        customer_details: { email },
      };
      const given = await confirmPreorder(store, session as never, product, deps);
      if (given !== "given") throw new Error(`pre-order ${n} not given: ${given}`);
      return { pi, who: email, holds: () => holds(email) };
    },
  }, NOW - 5_000);

  done();
}

void main();
