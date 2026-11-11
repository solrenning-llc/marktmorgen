/**
 * A usage line is looked up on Stripe in its exact shape before it is added
 * again (CX-123 rule 24, money; Claude 6 audit round 4).
 *
 * When a run ended after asking Stripe to add an overage line, the next run
 * finishes it (lib/usage-billing.ts carryOut): it first asks Stripe whether
 * the line is already there (lib/billing.ts findInvoiceLine), and adds it
 * only on a "no". Stripe's idempotency key lasts 24 hours and the next run
 * comes later, so a wrong "no" is the overage charged twice.
 *
 * findInvoiceLine read any reply as a list: no `data` array was an empty
 * page, a `has_more` that was not exactly true was the end, and three full
 * pages without the line were a "no". Now the page is read exactly
 * (lib/stripe-list.ts): "found" from a readable row on any page; "not there"
 * only from a list read to its end with every row readable; anything else
 * throws, carryOut says "failed", nothing is added, and the record of the
 * unfinished line is kept for the next run.
 *
 * A row with our mark is "found" only when it is the line carryOut asked
 * for (CX-123 rule 30; Claude 3's second money review of #3232): this
 * customer (an id or an expanded object), this subscription (read from
 * `parent.subscription_details`, the place it has at the pinned version
 * 2026-08-26.dahlia; a top-level `subscription` is accepted only when it is
 * the same), the cents asked for, in "usd". A row with our mark that is not
 * that line throws: a line under that mark may already have been charged,
 * so it is neither "found" (the overage would never be charged) nor skipped
 * (it could be charged twice). The read is pinned to STRIPE_LIST_VERSION.
 */
import { rememberFolderOwner } from "@/lib/delivery";
import { claimHandle, setSubscription, storeFolder } from "@/lib/store";
import { STRIPE_LIST_VERSION } from "@/lib/stripe-list";
import { type Meter, settleUsage } from "@/lib/usage-billing";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SUBSCRIPTION = "sub_Line0001";
const CUSTOMER = "cus_Line0001";
const month = "2026-11";
const now = Date.UTC(2026, 10, 20, 14);

/** What Stripe answers to a list of invoice lines: the body for each page asked, by its position and `starting_after`. */
type Lister = (page: number, startingAfter: string | null) => unknown;
let lister: Lister = () => ({ object: "list", data: [], has_more: false });
let posts = 0;
let gets: (string | null)[] = [];
let versions: (string | null)[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin !== "https://api.stripe.com") return json({}, 404);
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/invoiceitems" && method === "GET") {
    const after = url.searchParams.get("starting_after");
    gets.push(after);
    versions.push(new Headers(init?.headers).get("Stripe-Version"));
    return json(lister(gets.length - 1, after));
  }
  if (path === "/invoiceitems" && method === "POST") {
    posts += 1;
    return json({ id: `ii_Added${String(posts).padStart(8, "0")}` });
  }
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub && method === "POST") return json({ id: sub[1] });
  return json({ error: { code: "resource_missing" } }, 404);
}) as typeof fetch;

/** A meter that still owes 500 cents, so an unfinished line of 500 is finished. */
const PROBE: Meter = {
  name: "probe",
  measured: async () => 10,
  owed: () => 500,
  byPlan: false,
  covered: 0,
  describe: () => "Probe use",
  folders: async () => [],
};

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  const error = console.error;
  console.error = () => {};

  await claimHandle("lina@example.com", "lina", "lina", "");
  const folder = await storeFolder("lina@example.com");
  await rememberFolderOwner(folder, "lina@example.com");
  await setSubscription("lina@example.com", { customerId: CUSTOMER, subscriptionId: SUBSCRIPTION, active: true, cycle: "month", period: paidPeriod() });

  const mark = `probe:${folder}:${month}:0`;
  const addingKey = `nl:probe:adding:${folder}:${month}`;
  const parent = (subscription: unknown) => ({ type: "subscription_details", subscription_details: { subscription, subscription_item: "si_Line0001" } });
  const ours: Record<string, unknown> = {
    id: "ii_Ours00000001",
    object: "invoiceitem",
    customer: CUSTOMER,
    parent: parent(SUBSCRIPTION),
    amount: 500,
    currency: "usd",
    metadata: { mark },
  };
  /** Our line with some fields changed, or removed where the value is `undefined`. */
  const oursWith = (changes: Record<string, unknown>) => {
    const row: Record<string, unknown> = { ...ours, ...changes };
    for (const [key, value] of Object.entries(changes)) if (value === undefined) delete row[key];
    return row;
  };
  const other = (n: number) => ({ id: `ii_Other${String(n).padStart(6, "0")}`, object: "invoiceitem", amount: 300, metadata: { mark: `probe:another:${month}:${n}` } });
  const list = (data: unknown, hasMore: unknown = false) => ({ object: "list", data, has_more: hasMore, url: "/v1/invoiceitems" });

  /**
   * One run after a run that asked Stripe for the line and ended before
   * writing it down as billed (the line is on Stripe already): how many
   * lines were asked for, the run's state, and whether the record of the
   * unfinished line is kept for the next run.
   */
  async function retryWith(answer: Lister): Promise<{ posts: number; state: string; kept: boolean }> {
    await redis.pipeline([["DEL", `nl:probe:billed:${folder}:${month}`, addingKey, `nl:watch:monthly:${SUBSCRIPTION}`]]);
    const adding = { from: 0, to: 500, at: now - 2 * 86_400_000, amount: 10, line: "Probe use", customerId: CUSTOMER, subscriptionId: SUBSCRIPTION };
    await redis.pipeline([["SET", addingKey, JSON.stringify(adding)]]);
    lister = answer;
    posts = 0;
    gets = [];
    versions = [];
    let state = "rejected";
    try {
      state = (await settleUsage(PROBE, folder, month, true, now)).state;
    } catch {
      state = "rejected";
    }
    const [held] = await redis.pipeline([["GET", addingKey]]);
    return { posts, state, kept: typeof held === "string" };
  }

  part("controls: a list in its exact shape");
  is("the line is on the first page: found, not asked for again", await retryWith(() => list([other(1), ours])), { posts: 0, state: "billed", kept: false });
  is("a confirmed empty list: the line is asked for once", await retryWith(() => list([])), { posts: 1, state: "billed", kept: false });
  is("a confirmed empty list takes one read, as before", gets, [null]);
  is("only other lines, read to the end: asked for once", await retryWith(() => list([other(1), other(2)])), { posts: 1, state: "billed", kept: false });
  is(
    "the line on the second page: found, not asked for again",
    await retryWith((page) => (page === 0 ? list([other(1), other(2)], true) : list([ours]))),
    { posts: 0, state: "billed", kept: false },
  );
  is("the second page is read after the first page's last line", gets, [null, "ii_Other000002"]);
  is(
    "found on a readable row beside one that is not: found, not asked for again",
    await retryWith(() => list(["garbled", ours])),
    { posts: 0, state: "billed", kept: false },
  );

  is("the list is read at the pinned version", versions, [STRIPE_LIST_VERSION]);
  is("the customer as an expanded object: found", await retryWith(() => list([oursWith({ customer: { id: CUSTOMER, object: "customer" } })])), {
    posts: 0,
    state: "billed",
    kept: false,
  });
  is("the subscription as an expanded object: found", await retryWith(() => list([oursWith({ parent: parent({ id: SUBSCRIPTION, object: "subscription" }) })])), {
    posts: 0,
    state: "billed",
    kept: false,
  });
  is("a top-level subscription that is the same: found", await retryWith(() => list([oursWith({ subscription: SUBSCRIPTION })])), { posts: 0, state: "billed", kept: false });
  is("other lines that are not ours are not checked: asked for once", await retryWith(() => list([{ ...other(1), customer: "cus_Another0001", currency: "eur" }])), {
    posts: 1,
    state: "billed",
    kept: false,
  });

  const failed = { posts: 0, state: "failed", kept: true };
  const unknown: [string, Lister][] = [
    ["no data at all", () => ({ object: "list", has_more: false })],
    ["data null", () => list(null)],
    ["data an object", () => list({})],
    ["data a string", () => list("ii_Ours00000001")],
    ["no has_more", () => ({ object: "list", data: [] })],
    ["has_more the text false", () => list([], "false")],
    ["has_more a number", () => list([], 0)],
    ["has_more null", () => list([], null)],
    ["a list as the whole reply", () => []],
    ["null as the whole reply", () => null],
    ["another object than a list", () => ({ object: "invoice", data: [], has_more: false })],
    ["a row that is a string", () => list(["ii_Ours00000001"])],
    ["a row with no id", () => list([{ object: "invoiceitem", amount: 500, metadata: { mark: "probe:another:x:1" } }])],
    ["a row whose id is a number", () => list([{ id: 7, object: "invoiceitem", metadata: {} }])],
    ["a row whose metadata is a string", () => list([{ id: "ii_Odd000000001", object: "invoiceitem", metadata: mark }])],
    ["a row whose metadata is missing", () => list([{ id: "ii_Odd000000001", object: "invoiceitem" }])],
    ["a row whose mark is a number", () => list([{ id: "ii_Odd000000001", object: "invoiceitem", metadata: { mark: 1 } }])],
    ["more pages than are read, none with the line", (page) => list([other(page * 2 + 1), other(page * 2 + 2)], true)],
    ["more to come after a last row with no id", () => list([other(1), { object: "invoiceitem", metadata: {} }], true)],
    ["more to come after an empty page", () => list([], true)],
    ["a first page in its shape, a second one not", (page) => (page === 0 ? list([other(1)], true) : list(null))],
    ["a first page in its shape, a second one with a row not readable", (page) => (page === 0 ? list([other(1)], true) : list([42]))],
    ["our mark on another customer", () => list([oursWith({ customer: "cus_Another0001" })])],
    ["our mark on another customer, expanded", () => list([oursWith({ customer: { id: "cus_Another0001", object: "customer" } })])],
    ["our mark with no customer", () => list([oursWith({ customer: undefined })])],
    ["our mark with the customer null", () => list([oursWith({ customer: null })])],
    ["our mark with an expanded customer with no id", () => list([oursWith({ customer: { object: "customer" } })])],
    ["our mark on another subscription", () => list([oursWith({ parent: parent("sub_Another0001") })])],
    ["our mark on another subscription, expanded", () => list([oursWith({ parent: parent({ id: "sub_Another0001" }) })])],
    ["our mark with no subscription at all", () => list([oursWith({ parent: undefined })])],
    ["our mark with parent null", () => list([oursWith({ parent: null })])],
    ["our mark with subscription details null", () => list([oursWith({ parent: { type: "subscription_details", subscription_details: null } })])],
    ["our mark with the subscription null", () => list([oursWith({ parent: parent(null) })])],
    ["our mark with a parent of another type", () => list([oursWith({ parent: { type: "other", subscription_details: { subscription: SUBSCRIPTION } } })])],
    ["our mark with only a top-level subscription, no parent (not the pinned version's shape)", () => list([oursWith({ parent: undefined, subscription: SUBSCRIPTION })])],
    ["our mark with a top-level subscription null beside the parent", () => list([oursWith({ subscription: null })])],
    ["our mark with a top-level subscription that differs", () => list([oursWith({ subscription: "sub_Another0001" })])],
    ["our mark with a top-level subscription that differs, no parent", () => list([oursWith({ parent: undefined, subscription: "sub_Another0001" })])],
    ["our mark with the amount 1 cent less", () => list([oursWith({ amount: 499 })])],
    ["our mark with the amount 1 cent more", () => list([oursWith({ amount: 501 })])],
    ["our mark with the amount as text", () => list([oursWith({ amount: "500" })])],
    ["our mark with the amount a fraction", () => list([oursWith({ amount: 500.5 })])],
    ["our mark with no amount", () => list([oursWith({ amount: undefined })])],
    ["our mark in eur", () => list([oursWith({ currency: "eur" })])],
    ["our mark in USD capitals", () => list([oursWith({ currency: "USD" })])],
    ["our mark with no currency", () => list([oursWith({ currency: undefined })])],
    ["our mark twice, the second one another amount", () => list([ours, oursWith({ id: "ii_Ours00000002", amount: 499 })])],
    ["our mark on the second page on another customer", (page) => (page === 0 ? list([other(1)], true) : list([oursWith({ customer: "cus_Another0001" })]))],
  ];

  part("an unknown answer: the line is not asked for again, the record is kept");
  for (const [label, answer] of unknown) is(label, await retryWith(answer), failed);

  part("the record kept: a later run with a readable answer finishes it once");
  await retryWith(() => list(null));
  lister = () => list([ours]);
  posts = 0;
  const later = await settleUsage(PROBE, folder, month, true, now);
  is("found on the readable answer: billed, nothing asked for", [later.state, posts], ["billed", 0]);

  console.error = error;
  done();
}

void main();
