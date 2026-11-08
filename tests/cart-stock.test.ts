/**
 * Limited products in the cart (513 [PF1], unit 3; lib/stock.ts
 * withCartStockHolds, confirmCartStock, releaseCartStockHolds; added 2
 * November 2026). Checked, with Redis stubbed and Stripe mocked:
 *
 *   - a limited product goes in a cart, and a store with two offers one;
 *   - a cart's checkout holds one unit of each limited product, writes each
 *     hold, and is told so, so it closes before the hold runs out;
 *   - with any of them sold out, nothing opens and the sold out ones are
 *     named; a lock another checkout holds, a lock lost while Stripe was
 *     asked, or a count that cannot be read, opens nothing; a checkout that
 *     fails to open holds nothing and lets every lock go; a checkout whose
 *     hold cannot be written is closed at Stripe; a provisional hold that
 *     lapsed is let go without asking Stripe;
 *   - a cart of unlimited products takes no lock and holds nothing;
 *   - going back from Stripe and paying again closes the old checkout first
 *     and hands its units back; a paid one is never handed back, nor one
 *     Stripe will not close because it was just paid;
 *   - the thanks page marks each limited product of the cart sold;
 *   - the open cart says a sold out one is sold out and leaves it out of the
 *     total, and never says so of one whose count cannot be read; the route
 *     sends a cart that sold out back to it, and sets the cookie that hands
 *     its units back;
 *   - the store page, the product page, "Goes well with" and the cart's
 *     reminder leave a sold out one out (read in their source).
 */
import { NextRequest } from "next/server";
import { cartable } from "@/lib/cart-rules";
import { createCartCheckout, offersCart } from "@/lib/cart-checkout";
import { KIND, parseProduct } from "@/lib/catalog";
import { confirmCartStock, releaseCartStockHolds, stockLeft, withCartStockHolds } from "@/lib/stock";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { GET as readCart, POST as payCart } from "@/app/api/store/cart/route";
import { NO_DEAL } from "@/lib/cart-rules";
import { NO_RECOVERY } from "@/lib/recovery-setting";
import { NO_SALE } from "@/lib/store-sale";
import type { Listing, Product, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { CART_STOCK_COMMANDS_MOST, CART_STOCK_SHARE_OF_ORDER_COMPUTE, CART_STOCK_STRIPE_WAIT_MS, COMMAND, ORDER_COMPUTE } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { TEST_CONSENT } from "./digital-consent-fixture";

const sent: URLSearchParams[] = [];
const sessions = new Map<string, Record<string, unknown>>();
const expired: string[] = [];
let opened = 0;
/** Asked when Stripe is asked about one checkout; the sessions Stripe refuses to close, as it does a completed one. */
let onGet: ((id: string) => Promise<void>) | null = null;
const gets: string[] = [];
const complete = new Set<string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && method === "POST") {
    sent.push(new URLSearchParams(String(init?.body)));
    opened += 1;
    const id = `cs_test_cartstock${String(opened).padStart(8, "0")}`;
    sessions.set(id, { id, status: "open" });
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }));
  }
  const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && expire && method === "POST") {
    if (complete.has(expire[1])) return new Response(JSON.stringify({ error: { message: "Only Checkout Sessions with a status of open can be expired." } }), { status: 400 });
    expired.push(expire[1]);
    sessions.set(expire[1], { id: expire[1], status: "expired" });
    return new Response(JSON.stringify({ id: expire[1], status: "expired" }));
  }
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && one && method === "GET") gets.push(one[1]);
  if (url.hostname === "api.stripe.com" && one && method === "GET" && onGet) await onGet(one[1]);
  if (url.hostname === "api.stripe.com" && one && method === "GET") return new Response(JSON.stringify(sessions.get(one[1]) ?? { id: one[1], status: "open" }));
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** MAX_CHECKS in lib/stock.ts: the holds that ran out one count asks Stripe about. */
const MAX_LAPSED = 5;
const limited = (id: string, stock: number) => parseProduct({ id, title: `Print ${id}`, summary: "", priceCents: 2000, stock, link: `https://example.com/${id}` }) as Listing;
const plain = (id: string) => parseProduct({ id, title: `Guide ${id}`, summary: "", priceCents: 900, link: `https://example.com/${id}` }) as Listing;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("What goes in a cart");
  is("a limited product, at one price", cartable(limited("print1", 3)), true);
  const catalog = (kinds: number[]) => ({ handle: "x", catalog: { id: null, items: kinds.map((kind, i) => ({ id: `p${i}`, kind, options: [] })), head: [], inline: null } }) as unknown as Store;
  is("a store with two, limited or not, offers a cart", offersCart(catalog([KIND.paid | KIND.limited, KIND.paid])), true);

  part("Holding a cart's units");
  const creator = { statsId: "c".repeat(32), stripeAccountId: "acct_test_cartstock1" } as Store;
  const a = limited("print1", 1);
  const b = limited("print2", 2);
  let told: boolean | null = null;
  const first = await withCartStockHolds(creator, [plain("guide1"), b, a], async (held) => {
    told = held;
    return { id: "cs_test_cartstockfirst01" };
  });
  is("one unit of each limited product held, and the checkout told so", [first.ok, told, await stockLeft(creator, a), await stockLeft(creator, b)], [true, true, 0, 1]);
  let calls = 0;
  const second = await withCartStockHolds(creator, [b, a], async () => {
    calls += 1;
    return { id: "cs_test_cartstocksecond1" };
  });
  is("with one sold out, nothing opens and it is named", [second, calls, await stockLeft(creator, b)], [{ ok: false, reason: "soldout", ids: ["print1"] }, 0, 1]);
  await redis.pipeline([["SET", `nl:stock:lock:${creator.statsId}:print2`, "1", "EX", 60]]);
  const busy = await withCartStockHolds(creator, [limited("print3", 5), b], async () => {
    calls += 1;
    return { id: "cs_test_cartstockbusy001" };
  });
  const lock3 = await redis.pipeline([["GET", `nl:stock:lock:${creator.statsId}:print3`]]);
  is("a lock another checkout holds opens nothing, and the locks taken are let go", [busy, calls, lock3[0]], [{ ok: false, reason: "busy" }, 0, null]);
  await redis.pipeline([["DEL", `nl:stock:lock:${creator.statsId}:print2`]]);
  let failed = "";
  // Stripe's own refusal, a 4xx answered before it makes anything: the only failure that proves no checkout exists.
  await withCartStockHolds(creator, [limited("print4", 5), limited("print5", 5)], async () => {
    throw new StripeError(400, "parameter_invalid", "Stripe said no");
  }).catch((error: Error) => {
    failed = error.message;
  });
  const locks = await redis.pipeline([["GET", `nl:stock:lock:${creator.statsId}:print4`], ["GET", `nl:stock:lock:${creator.statsId}:print5`]]);
  is("a checkout Stripe refused to make holds nothing and lets every lock go", [failed.endsWith("Stripe said no"), locks, await stockLeft(creator, limited("print4", 5))], [true, [null, null], 5]);
  class NotAsked extends Error {}
  await withCartStockHolds(creator, [limited("print20", 5)], async () => {
    throw new NotAsked("refused before Stripe was asked");
  }, (error) => error instanceof NotAsked).catch(() => {});
  is("a refusal the caller names, raised before Stripe is asked, holds nothing", await stockLeft(creator, limited("print20", 5)), 5);
  let lostOpen = "";
  await withCartStockHolds(creator, [limited("print21", 5), limited("print22", 5)], async () => {
    // Stripe was asked and made the checkout; its answer never reached the cart (since Claude 4's review of #1732, 6 November
    // 2026, an error raised before Stripe is asked gives the units back at once, so the opening asks Stripe here).
    await onAccount("POST", creator.stripeAccountId!, "/checkout/sessions", new URLSearchParams({ mode: "payment" }));
    throw new TypeError("Connection lost after the checkout was made");
  }).catch((error: Error) => {
    lostOpen = error.message;
  });
  is("an opening whose answer was lost keeps its units held: the checkout may exist at Stripe", [lostOpen, await stockLeft(creator, limited("print21", 5)), await stockLeft(creator, limited("print22", 5))], ["Connection lost after the checkout was made", 4, 4]);
  is("and the held ones lapse once any checkout made under them has closed", await stockLeft(creator, limited("print21", 5), Date.now() + 37 * 60 * 1000 + 1000), 5);
  is("a store whose counts have nowhere to be read opens nothing", await withCartStockHolds({ statsId: null } as unknown as Store, [a], async () => ({ id: "x" })), { ok: false, reason: "busy" });
  await redis.pipeline([["HSET", `nl:stock:${creator.statsId}:print13`, "cs_test_cartstockjunk0002", "not a hold"]]);
  let unreadOpened = 0;
  const unreadable = await withCartStockHolds(creator, [limited("print14", 3), limited("print13", 3)], async () => {
    unreadOpened += 1;
    return { id: "cs_test_cartstockunread01" };
  }).then(() => "opened", (error: Error) => error.message);
  const unreadLocks = await redis.pipeline([["GET", `nl:stock:lock:${creator.statsId}:print13`], ["GET", `nl:stock:lock:${creator.statsId}:print14`]]);
  is("a count that cannot be read opens nothing, holds nothing and lets every lock go", [unreadable, unreadOpened, unreadLocks, await stockLeft(creator, limited("print14", 3))], ["Stock reading unavailable", 0, [null, null], 3]);
  told = null;
  const free = await withCartStockHolds({ statsId: null } as unknown as Store, [plain("guide1"), plain("guide2")], async (held) => {
    told = held;
    return { id: "cs_test_cartstockplain01" };
  });
  is("a cart of unlimited products holds nothing and takes no lock", [free.ok, told], [true, false]);

  part("Going back, and paying");
  sessions.set("cs_test_cartstockfirst01", { id: "cs_test_cartstockfirst01", status: "open" });
  await releaseCartStockHolds(creator, [a, b], "cs_test_cartstockfirst01");
  is("the old checkout closed at Stripe first, then its units handed back", [expired, await stockLeft(creator, a), await stockLeft(creator, b)], [["cs_test_cartstockfirst01"], 1, 2]);
  await withCartStockHolds(creator, [a, b], async () => ({ id: "cs_test_cartstockpaid0001" }));
  await confirmCartStock(creator, [plain("guide1"), a, b], "cs_test_cartstockpaid0001");
  await releaseCartStockHolds(creator, [a, b], "cs_test_cartstockpaid0001");
  is("a paid cart's units are sold, never handed back, and Stripe is not asked to close it", [expired.length, await stockLeft(creator, a), await stockLeft(creator, b)], [1, 0, 1]);

  part("What can go wrong between the count and the checkout");
  const key = (id: string) => `nl:stock:${creator.statsId}:${id}`;
  await redis.pipeline([["HSET", key("print7"), "p_lapsed0000000000000000000000000", JSON.stringify({ until: Date.now() - 1000 })]]);
  is("a provisional hold that lapsed is let go without asking Stripe", [await stockLeft(creator, limited("print7", 1)), gets.some((id) => id.startsWith("p_")), (await redis.pipeline([["HGETALL", key("print7")]]))[0]], [1, false, []]);
  await redis.pipeline([["HSET", key("print8"), "cs_test_cartstockold00001", JSON.stringify({ until: Date.now() - 1000 })]]);
  // Since the review of 5 November 2026 Stripe is never asked under the lock, so the slow step a lock can run out in is the count's own read.
  const base = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "HGETALL" && commands[0][1] === key("print8")) await base([["DEL", `nl:stock:lock:${creator.statsId}:print8`]]);
    return base(commands);
  };
  const asked8 = gets.length;
  let tried = 0;
  const lost = await withCartStockHolds(creator, [limited("print8", 2)], async () => {
    tried += 1;
    return { id: "cs_test_cartstocklost0001" };
  });
  redis.pipeline = base;
  const after8 = (await redis.pipeline([["HGETALL", key("print8")]]))[0] as string[];
  is("a lock lost before the provisional hold is admitted: nothing held, nothing opened, and Stripe never asked under it", [lost, tried, after8.filter((_, i) => i % 2 === 0), gets.length - asked8], [{ ok: false, reason: "busy" }, 0, ["cs_test_cartstockold00001"], 0]);
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => (commands.some((command) => command[0] === "HSET" && command[2] === "cs_test_cartstockbad00001") ? [] : original(commands));
  const unwritten = await withCartStockHolds(creator, [limited("print9", 3)], async () => ({ id: "cs_test_cartstockbad00001" }));
  redis.pipeline = original;
  is("a checkout whose hold cannot be written is closed at Stripe, nobody is sent to it, and once closed its unit is let go", [unwritten, expired.includes("cs_test_cartstockbad00001"), await stockLeft(creator, limited("print9", 3))], [{ ok: false, reason: "busy" }, true, 3]);
  let sparseOpened = 0;
  redis.pipeline = async (commands) => (commands.length === 2 && commands[0][0] === "HSET" && commands[1][0] === "HSET" ? new Array(2) : original(commands));
  const sparse = await withCartStockHolds(creator, [limited("print11", 3), limited("print12", 3)], async () => {
    sparseOpened += 1;
    return { id: "cs_test_cartstocksparse01" };
  });
  redis.pipeline = original;
  is("a reply with holes is never taken for the provisional holds' acknowledgment", [sparse, sparseOpened], [{ ok: false, reason: "busy" }, 0]);
  const script = (commands: (string | number)[][], tag: string) => commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith(`-- marktmorgen:${tag}:v1\n`);
  let admitOpened = 0;
  redis.pipeline = async (commands) => (script(commands, "stock-admit") ? [] : original(commands));
  const unadmitted = await withCartStockHolds(creator, [limited("print16", 1)], async () => {
    admitOpened += 1;
    return { id: "cs_test_cartstockadmit001" };
  });
  redis.pipeline = original;
  is("an admission whose answer is unknown opens nothing, and takes its own provisional hold back", [unadmitted, admitOpened, await stockLeft(creator, limited("print16", 1))], [{ ok: false, reason: "busy" }, 0, 1]);
  redis.pipeline = async (commands) => (script(commands, "stock-bind") ? [{ error: "lost" }] : original(commands));
  const unbound = await withCartStockHolds(creator, [limited("print17", 1)], async () => ({ id: "cs_test_cartstockbind0001" }));
  redis.pipeline = original;
  is("a hand-over whose answer is unknown: closed at Stripe, nobody sent to it, the unit back only once Stripe says expired", [unbound, expired.includes("cs_test_cartstockbind0001"), await stockLeft(creator, limited("print17", 1))], [{ ok: false, reason: "busy" }, true, 1]);
  complete.add("cs_test_cartstockbind0002");
  redis.pipeline = async (commands) => (script(commands, "stock-bind") ? [] : original(commands));
  const unclosed = await withCartStockHolds(creator, [limited("print18", 1)], async () => ({ id: "cs_test_cartstockbind0002" }));
  redis.pipeline = original;
  is("and while Stripe will not close it, its unit stays held", [unclosed, await stockLeft(creator, limited("print18", 1))], [{ ok: false, reason: "busy" }, 0]);
  const gap = await withCartStockHolds(creator, [limited("print19", 1)], async () => {
    // The provisional hold lapsed and was let go while Stripe was opening the checkout (a paused request): the unit may have been sold since.
    const fields = ((await original([["HGETALL", key("print19")]]))[0] as string[]).filter((_, i) => i % 2 === 0);
    await original(fields.map((field) => ["HDEL", key("print19"), field]));
    return { id: "cs_test_cartstockgap00001" };
  });
  is("a checkout opened after its provisional hold was let go is closed at Stripe, nobody sent to it", [gap, expired.includes("cs_test_cartstockgap00001")], [{ ok: false, reason: "busy" }, true]);
  await withCartStockHolds(creator, [limited("print10", 1)], async () => ({ id: "cs_test_cartstockdone0001" }));
  complete.add("cs_test_cartstockdone0001");
  await releaseCartStockHolds(creator, [limited("print10", 1)], "cs_test_cartstockdone0001");
  is("a checkout paid but not yet marked sold, which Stripe will not close, keeps its unit", await stockLeft(creator, limited("print10", 1)), 0);

  part("The worst a cart's stock costs, in commands and in waiting (review of 5 November 2026)");
  const costly = { statsId: "e".repeat(32), stripeAccountId: "acct_test_cartstockcost" } as Store;
  const costKey = (id: string) => `nl:stock:${costly.statsId}:${id}`;
  const costLock = (id: string) => `nl:stock:lock:${costly.statsId}:${id}`;
  // Counted as Upstash bills them: every command of a pipeline, and the ones the admission and the hand-over scripts run inside (three a product).
  let commands = 0;
  const counting = async (batch: (string | number)[][]) => {
    for (const command of batch) {
      commands += 1;
      // The admission names two keys a product (its lock and its holds), the hand-over one.
      if (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:stock-admit:v1\n")) commands += 3 * (Number(command[2]) / 2);
      if (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:stock-bind:v1\n")) commands += 3 * Number(command[2]);
    }
    return original(batch);
  };
  // How many tries a lock taken by someone else costs before the cart gives up on it.
  await original([["SET", costLock("c1"), "someone-else", "EX", 60]]);
  commands = 0;
  redis.pipeline = async (batch) => {
    if (batch.length === 1 && batch[0][0] === "SET" && batch[0][1] === costLock("c1")) commands += 1;
    return original(batch);
  };
  is("a lock taken by someone else: nothing opens", await withCartStockHolds(costly, [limited("c1", 6)], async () => ({ id: "cs_test_cartstockcost0000" })), { ok: false, reason: "busy" });
  redis.pipeline = original;
  const tries = commands;
  await original([["DEL", costLock("c1")]]);
  // Stripe is asked only with no lock held, every product at once.
  let underLock = 0, inFlight = 0, mostInFlight = 0, asked = 0;
  onGet = async () => {
    asked += 1;
    const locks = await original(["c1", "c2", "c3", "c4", "r1", "r2", "r3", "r4"].map((id) => ["GET", costLock(id)]));
    if (locks.some((lock) => lock !== null)) underLock += 1;
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  };
  const lapse = async (id: string, n: number) => {
    for (let i = 0; i < n; i += 1) {
      const session = `cs_test_lapsed${id}${String(i).padStart(6, "0")}`;
      sessions.set(session, { id: session, status: "expired" });
      await original([["HSET", costKey(id), session, JSON.stringify({ until: Date.now() - 1000 })]]);
    }
  };
  // The order at its worst: four limited products, each with holds that ran out; the hand-over's failure path; the previous checkout handed back.
  const cart4 = ["c1", "c2", "c3", "c4"].map((id) => limited(id, 6));
  for (const id of ["c1", "c2", "c3", "c4"]) await lapse(id, MAX_LAPSED);
  await withCartStockHolds(costly, cart4, async () => ({ id: "cs_test_cartstockprev0001" }));
  commands = 0;
  redis.pipeline = counting;
  await releaseCartStockHolds(costly, cart4, "cs_test_cartstockprev0001");
  const handedBack = commands;
  commands = 0;
  const worst = await withCartStockHolds(costly, cart4, async () => ({ id: "cs_test_cartstockcost0001" }));
  const opening = commands;
  commands = 0;
  // The hand-over's failure path, in one count: four other products in the same state as the opening's (each with one unit
  // left beside its holds that ran out), so the cart opens and its hand-over fails, never a refusal for sold out (measured
  // by mistake until the review of #1732, 6 November 2026).
  const fail4 = ["f1", "f2", "f3", "f4"].map((id) => limited(id, 6));
  for (const id of ["f1", "f2", "f3", "f4"]) await lapse(id, MAX_LAPSED);
  const closedBefore = expired.length;
  redis.pipeline = async (batch) => (batch.length === 1 && batch[0][0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:stock-bind:v1\n") ? (await counting(batch), []) : counting(batch));
  const failed4 = await withCartStockHolds(costly, fail4, async () => ({ id: "cs_test_cartstockcost0002" }));
  const failing = commands;
  redis.pipeline = original;
  is("the failure path measured is the hand-over's: opened, closed at Stripe, nobody sent to it", [failed4, expired.slice(closedBefore)], [{ ok: false, reason: "busy" }, ["cs_test_cartstockcost0002"]]);
  const most = handedBack + Math.max(opening, failing) + cart4.length * (tries - 1);
  is("the order's stock work at its worst stays inside its declared commands", [worst.ok, most <= CART_STOCK_COMMANDS_MOST], [true, true]);
  is("and those commands inside their declared share of an order's compute", CART_STOCK_COMMANDS_MOST * COMMAND <= CART_STOCK_SHARE_OF_ORDER_COMPUTE * ORDER_COMPUTE, true);
  // A cart refused only for holds that ran out: they are asked about after the locks are let go, all at once, and the next try opens.
  const refusedCart = ["r1", "r2", "r3", "r4"].map((id) => limited(id, MAX_LAPSED));
  for (const id of ["r1", "r2", "r3", "r4"]) await lapse(id, MAX_LAPSED);
  asked = 0;
  commands = 0;
  redis.pipeline = counting;
  const firstTry = await withCartStockHolds(costly, refusedCart, async () => ({ id: "cs_test_cartstockcost0003" }));
  const refusedCost = commands;
  redis.pipeline = original;
  const nextTry = firstTry.ok ? firstTry : await withCartStockHolds(costly, refusedCart, async () => ({ id: "cs_test_cartstockcost0004" }));
  onGet = null;
  is("Stripe is never asked while a lock is held", underLock, 0);
  is("the holds that ran out are asked about every product at once, at most MAX_CHECKS each", [mostInFlight, asked <= refusedCart.length * MAX_LAPSED], [refusedCart.length, true]);
  is("so the stock work waits on Stripe at most its declared time", MAX_LAPSED * 2_000 <= CART_STOCK_STRIPE_WAIT_MS, true);
  is("and a cart refused for them costs no more, and opens on its next try", [refusedCost + refusedCart.length * (tries - 1) <= CART_STOCK_COMMANDS_MOST, nextTry.ok], [true, true]);
  // Claude 4's review of #1732 (6 November 2026): such a cart is never told "Sold out". One of four is told to press again,
  // and opens then (above); one of at most two limited products is counted again at once once they are settled, and opens.
  is("a cart of four refused only for them is told to press again, never sold out", firstTry, { ok: false, reason: "busy" });
  const pair = ["s1", "s2"].map((id) => limited(id, MAX_LAPSED));
  for (const id of ["s1", "s2"]) await lapse(id, MAX_LAPSED);
  is("a cart of two refused only for them opens at the first click", (await withCartStockHolds(costly, pair, async () => ({ id: "cs_test_cartstockpair0001" }))).ok, true);
  // Its worst: the first count refused, the holds settled, the second count and the hand-over's failure path, each lock at its
  // most tries in both counts, and the previous checkout's units handed back first.
  const pairFailing = ["t1", "t2"].map((id) => limited(id, MAX_LAPSED));
  for (const id of ["t1", "t2"]) await lapse(id, MAX_LAPSED);
  await withCartStockHolds(costly, ["t3", "t4"].map((id) => limited(id, 2)), async () => ({ id: "cs_test_cartstockprev0002" }));
  commands = 0;
  redis.pipeline = counting;
  await releaseCartStockHolds(costly, ["t3", "t4"].map((id) => limited(id, 2)), "cs_test_cartstockprev0002");
  const pairHandedBack = commands;
  commands = 0;
  redis.pipeline = async (batch) => (batch.length === 1 && batch[0][0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:stock-bind:v1\n") ? (await counting(batch), []) : counting(batch));
  const pairWorst = await withCartStockHolds(costly, pairFailing, async () => ({ id: "cs_test_cartstockpair0002" }));
  const pairRecount = commands;
  redis.pipeline = original;
  is("and its worst, counted twice, stays inside the declared commands", [pairWorst, pairHandedBack + pairRecount + 2 * pairFailing.length * (tries - 1) <= CART_STOCK_COMMANDS_MOST], [{ ok: false, reason: "busy" }, true]);

  part("The checkout closes before the hold");
  const shop = { handle: "prints", name: "Prints", email: "prints@example.com", language: "en", currency: "usd", stripeAccountId: "acct_test_cartstock1", sale: { ...NO_SALE }, cartDeal: { ...NO_DEAL }, recovery: { ...NO_RECOVERY }, hasDiscounts: false, tax: { enabled: false, included: false, ids: false, invoices: false }, affiliates: { enabled: false, percent: 0, days: 30, rates: {}, payday: 0, hold: 0 }, catalog: { id: null, items: [], head: [], inline: null } } as unknown as Store;
  // The clock turns to the next second while the checkout is made (Codex V's proof, job 128430631131 on #3056):
  // every read inside the call is 1.5 s later than the test's own read before it, so the turn happens on every run.
  const realNow = Date.now;
  const now = Math.floor(realNow() / 1000);
  // The clock as it is once the call is done: the latest second the checkout's time can have been counted from.
  let after = now;
  Date.now = () => realNow() + 1500;
  try {
    await createCartCheckout(shop, [limited("print6", 3) as Product, plain("guide1") as Product], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, held: true, remind: true });
    after = Math.floor(Date.now() / 1000);
  } finally {
    Date.now = realNow;
  }
  const closes = Number(sent.at(-1)!.get("expires_at"));
  is("a held unit's time, shorter than a reminder's hour", closes > now && closes <= after + 31 * 60, true);

  part("The open cart, and paying for it");
  const OWNER = "prints@example.com";
  await claimHandle(OWNER, "printshop", "Print Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPrints001", true);
  await setSubscription(OWNER, { customerId: "cus_Prints00001", subscriptionId: "sub_Prints00001", active: true, period: paidPeriod() });
  const made: Record<string, string> = {};
  for (const title of ["Guide", "Print", "Poster"]) {
    const added = await addProduct(OWNER, title, "", "20", null);
    if (!added.ok) throw new Error(`no ${title}`);
    made[title] = added.product.id;
    await setProductLink(OWNER, added.product.id, `https://example.com/${title.toLowerCase()}`);
  }
  for (const [title, stock] of [["Print", 1], ["Poster", 5]] as const) {
    const set = await setProductExtras(OWNER, made[title], { stock });
    if (!set.ok) throw new Error(`no stock on ${title}`);
  }
  const owner = (await storeForEmail(OWNER))!;
  const pay = async (ids: string[], cookie = "") => {
    const form = new URLSearchParams({ handle: "printshop", dc: "yes", dc_v: TEST_CONSENT.version });
    for (const id of ids) form.append("id", id);
    const answer = await payCart(new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: form.toString() }));
    const where = new URL(answer.headers.get("location") ?? "https://x/");
    return { to: where.hostname === "checkout.stripe.com" ? "stripe" : where.search, cookie: answer.headers.getSetCookie().find((c) => c.startsWith("nl_cart_hold=")) ?? "" };
  };
  const paid = await pay([made.Guide, made.Print, made.Poster]);
  is("paying holds a unit of each, and sets the cookie that hands them back", [paid.to, paid.cookie.includes("Path=/api/store/cart"), await stockLeft(owner, (await import("@/lib/catalog")).parseProduct({ id: made.Print, title: "Print", summary: "", priceCents: 2000, stock: 1 }) as Listing)], ["stripe", true, 0]);
  const again = await pay([made.Guide, made.Print, made.Poster]);
  is("the same cart from another browser: its print is sold out, back to the cart", again.to, "?cart=changed");
  const back = await pay([made.Guide, made.Print, made.Poster], paid.cookie.split(";")[0]);
  is("the browser that went back from Stripe: its old checkout closed, its units held again", [back.to, expired.includes(paid.cookie.split(";")[0].split("=")[1])], ["stripe", true]);
  const open = await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=printshop&ids=${[made.Guide, made.Print].join(",")}`));
  const cart = (await open.json()) as { items: { id: string; ok: boolean; soldOut: boolean }[]; total: string };
  is("the open cart: the held print sold out, left out of the total", [cart.items.map((item) => [item.ok, item.soldOut]), cart.total], [[[true, false], [false, true]], "$20"]);
  await redis.pipeline([["HSET", `nl:stock:${owner.statsId}:${made.Poster}`, "cs_test_cartstockjunk0001", "not a hold"]]);
  const unread = (await (await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=printshop&ids=${made.Poster}`))).json()) as { items: { ok: boolean; soldOut: boolean }[] };
  is("a count that cannot be read is not paid for, and never said to be sold out", unread.items.map((item) => [item.ok, item.soldOut]), [[false, false]]);

  part("A key count that cannot be read never sells (SG2, finding 12)");
  const licence = await addProduct(OWNER, "Licence", "", "20", null);
  if (!licence.ok) throw new Error("no licence");
  await setProductLink(OWNER, licence.product.id, "https://example.com/licence");
  const keyed = await setProductKeys(OWNER, licence.product.id, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 0 });
  if (!keyed.ok) throw new Error("no keys on the licence");
  is("a pool with no keys left: back to the cart", (await pay([made.Guide, licence.product.id])).to, "?cart=changed");
  const before = opened;
  for (const reply of [[], ["3"], [null], [-1], [{ error: "lost" }]] as unknown[][]) {
    redis.pipeline = async (commands) => (commands.length === 1 && commands[0][0] === "LLEN" ? reply : original(commands)) as never;
    const answer = await pay([made.Guide, licence.product.id]);
    redis.pipeline = original;
    is(`a key count answered ${JSON.stringify(reply)}: nothing opened, try again`, answer.to, "?cart=error");
  }
  is("no checkout was made on an unknown key count", opened, before);

  part("Where else a sold out one is not offered");
  const { readFileSync } = await import("node:fs");
  is("the store page, the product page and Goes well with", [
    readFileSync("app/[handle]/page.tsx", "utf8").includes("cartable(product) && left.get(product.id) !== 0"),
    readFileSync("app/[handle]/p/[product]/page.tsx", "utf8").includes("cartable(product) && remaining !== 0"),
    readFileSync("app/[handle]/p/[product]/page.tsx", "utf8").includes("!pairedOut.has(p.id)"),
  ], [true, true, true]);
  is("the thanks page marks the cart's limited products sold", readFileSync("app/[handle]/thanks/page.tsx", "utf8").includes("confirmCartStock(store, order.bumps.map((added) => added.product), sessionId)"), true);
  is("nor in the cart's reminder, nor one whose count cannot be read", readFileSync("lib/checkout-recovery.ts", "utf8").includes("return kept.filter((_, i) => left[i] !== 0 && left[i] !== undefined);"), true);

  done();
}

void main();
