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
 *   - a product bought alone (withStockHold) takes the same lock and the
 *     same provisional hold as a cart, so the two never both get the last
 *     unit, even when its lock runs out while Stripe opens its checkout;
 *   - going back from Stripe and paying again closes the old checkout first
 *     and hands its units back; a paid one is never handed back, nor one
 *     Stripe will not close because it was just paid;
 *   - the thanks page marks each limited product of the cart sold;
 *   - the open cart says a sold out one is sold out and leaves it out of the
 *     total, and never says so of one whose count cannot be read; the unit
 *     the browser back from Stripe holds (its cookie) is its own, until paid; the route
 *     sends a cart that sold out back to it, and sets the cookie that hands
 *     its units back;
 *   - the open cart never offers a sold out pick, product bought together
 *     or bundle, reading at most MAX_SUGGEST counts for each;
 *   - the store page, the product page, "Goes well with" and the cart's
 *     reminder leave a sold out one out (read in their source).
 */
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { cartable } from "@/lib/cart-rules";
import { createCartCheckout, offersCart } from "@/lib/cart-checkout";
import { KIND, parseProduct } from "@/lib/catalog";
import { CART_READ_STOCK_UNITS, MAX_LAPSED, SHOWN_READ_COMMANDS, STOCK_ATTEMPT_UNITS, STOCK_ENTRIES_MAX, STOCK_ENTRY_BYTES, STOCK_ORDER_COMMANDS, STOCK_SESSION_MAX, confirmCartStock, confirmStock, heldCheckout, holdCookieNames, holdCookieValue, releaseCartStockHolds, shownOnly, stockLeft, stockReading, withCartStockHolds, withStockHold } from "@/lib/stock";
import { cartItems } from "@/lib/checkout-recovery";
import { CART_WORDS } from "@/lib/buyer-words/cart";
import { HOLD_SECONDS } from "@/lib/stripe-account";
import { CLOSING, closingFamilyOf } from "@/lib/data-families";
import { ownerOfKey } from "@/lib/closed-store-data";
import { FAMILIES } from "./store-data-registry";
import { MAX_CART } from "@/lib/cart-rules";
import { COMMAND, DB_BYTE, ORDER_STOCK } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { addProduct, claimHandle, ensureStatsId, setProductBundle, setProductExtras, setProductLink, setProductPairs, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { GET as readCart, POST as payCart } from "@/app/api/store/cart/route";
import { NO_DEAL } from "@/lib/cart-rules";
import { NO_RECOVERY } from "@/lib/recovery-setting";
import { NO_SALE } from "@/lib/store-sale";
import type { Listing, Product, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
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
/** Sessions Stripe has never heard of (another account connected since). */
const missing = new Set<string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && method === "POST") {
    sent.push(new URLSearchParams(String(init?.body)));
    opened += 1;
    const id = `cs_test_cartstock${String(opened).padStart(8, "0")}`;
    const metadata = Object.fromEntries([...sent.at(-1)!].flatMap(([name, value]) => (/^metadata\[(\w+)\]$/.exec(name) ? [[/^metadata\[(\w+)\]$/.exec(name)![1], value]] : [])));
    sessions.set(id, { id, status: "open", metadata });
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }));
  }
  const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && expire && method === "POST") {
    if (complete.has(expire[1])) return new Response(JSON.stringify({ error: { message: "Only Checkout Sessions with a status of open can be expired." } }), { status: 400 });
    expired.push(expire[1]);
    const closed = { ...(sessions.get(expire[1]) ?? { id: expire[1] }), status: "expired" };
    sessions.set(expire[1], closed);
    return new Response(JSON.stringify(closed));
  }
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && one && method === "GET") gets.push(one[1]);
  if (url.hostname === "api.stripe.com" && one && method === "GET" && onGet) await onGet(one[1]);
  if (url.hostname === "api.stripe.com" && one && method === "GET" && missing.has(one[1])) return new Response(JSON.stringify({ error: { code: "resource_missing", message: "No such checkout.session" } }), { status: 404 });
  if (url.hostname === "api.stripe.com" && one && method === "GET") return new Response(JSON.stringify(sessions.get(one[1]) ?? { id: one[1], status: "open" }));
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** The sold count of a product, and whether a checkout's unit of it is in it (lib/stock.ts, STOCK_SOLD). */
const soldOf = async (store: Store, id: string, session?: string) => {
  const [count, paid] = await redis.pipeline([["GET", `nl:stock:sold:${store.statsId}:${id}`], ["EXISTS", `nl:stock:paid:${store.statsId}:${id}:${session ?? "none"}`]]);
  return { sold: Number(count ?? 0), paid: paid === 1 };
};
const readEntriesOf = async (store: Store, id: string) => {
  const [raw] = await redis.pipeline([["HGETALL", `nl:stock:${store.statsId}:${id}`]]);
  const list = raw as string[];
  return Object.fromEntries(list.flatMap((value, i) => (i % 2 === 0 ? [[value, JSON.parse(list[i + 1]) as { until: number; paid?: boolean; asked?: number }]] : []))) as Record<string, { until: number; paid?: boolean; asked?: number }>;
};
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
  await withCartStockHolds(creator, [limited("print4", 5), limited("print5", 5)], async () => {
    throw new Error("Stripe said no");
  }).catch((error: Error) => {
    failed = error.message;
  });
  const locks = await redis.pipeline([["GET", `nl:stock:lock:${creator.statsId}:print4`], ["GET", `nl:stock:lock:${creator.statsId}:print5`]]);
  is("a checkout that fails to open holds nothing and lets every lock go", [failed, locks, await stockLeft(creator, limited("print4", 5))], ["Stripe said no", [null, null], 5]);
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

  part("One product bought alone and the same product in a cart");
  // The last unit, bought alone while Stripe is slow to open its checkout: the lock it took runs out meanwhile (as one of
  // 15 s does against Stripe's 20 s tries), and a cart with the same product is paid for in that time.
  const last = limited("print20", 1);
  const lockOf = (id: string) => `nl:stock:lock:${creator.statsId}:${id}`;
  let cartWhileSlow: Awaited<ReturnType<typeof withCartStockHolds>> | null = null;
  const alone = await withStockHold(creator, last, async () => {
    await redis.pipeline([["DEL", lockOf("print20")]]);
    cartWhileSlow = await withCartStockHolds(creator, [plain("guide1"), last], async () => ({ id: "cs_test_cartstockrace0001" }));
    return { id: "cs_test_alonestockrace001" };
  });
  is("a product bought alone and a cart never both get the last unit", [alone.ok, (cartWhileSlow as { ok: boolean } | null)?.ok, await stockLeft(creator, last)], [true, false, 0]);
  // The other way round: the cart holds the last unit first, and the one bought alone finds it gone.
  const last2 = limited("print21", 1);
  const cartFirst = await withCartStockHolds(creator, [last2], async () => ({ id: "cs_test_cartstockrace0002" }));
  let aloneOpened = 0;
  const aloneAfter = await withStockHold(creator, last2, async () => {
    aloneOpened += 1;
    return { id: "cs_test_alonestockrace002" };
  });
  is("a cart that holds the last unit first leaves none for the product bought alone", [cartFirst.ok, aloneAfter, aloneOpened], [true, { ok: false, reason: "soldout" }, 0]);
  // At the same instant, each slow to open: exactly one gets it.
  const last3 = limited("print22", 1);
  const slow = (id: string) => async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { id };
  };
  const both = await Promise.all([withStockHold(creator, last3, slow("cs_test_alonestockrace003")), withCartStockHolds(creator, [last3], slow("cs_test_cartstockrace0003"))]);
  is("pressed at the same instant, exactly one of them gets the last unit", [both.filter((one) => one.ok).length, await stockLeft(creator, last3)], [1, 0]);
  const leftLocks = await redis.pipeline([["GET", lockOf("print20")], ["GET", lockOf("print21")], ["GET", lockOf("print22")]]);
  is("and no lock is left behind", leftLocks, [null, null, null]);

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
  // A reading only shown cannot tell it from a live hold (it reads only how many there are): until a count that may write
  // lets it go, the open cart says the unit is in another checkout. Since 4 November 2026 (review of 513 [PF1], L-5) every
  // such count lets it go, under the lock or not, so the product's page and the open cart then say the same.
  const shownBefore = await stockReading(creator, limited("print7", 1), Date.now(), { checks: shownOnly() });
  const lapsedFree = await stockLeft(creator, limited("print7", 1));
  const lapsedKept = ((await redis.pipeline([["HGETALL", key("print7")]]))[0] as string[]).length;
  const shownAfter = await stockReading(creator, limited("print7", 1), Date.now(), { checks: shownOnly() });
  const lapsedHold = await withCartStockHolds(creator, [limited("print7", 1)], async () => ({ id: "cs_test_cartstocklapse01" }));
  const lapsedAfter = ((await redis.pipeline([["HGETALL", key("print7")]]))[0] as string[]).filter((_, i) => i % 2 === 0);
  is("a provisional hold that lapsed is free, let go by the page's count without asking Stripe, and the open cart then says the same",
    [shownBefore, lapsedFree, lapsedKept, shownAfter, lapsedHold.ok, gets.some((id) => id.startsWith("p_")), lapsedAfter],
    [{ left: 0, unchecked: 1, holds: 1 }, 1, 0, { left: 1, unchecked: 0, holds: 0 }, true, false, ["cs_test_cartstocklapse01"]]);
  await redis.pipeline([["HSET", key("print8"), "cs_test_cartstockold00001", JSON.stringify({ until: Date.now() - 1000 })]]);
  onGet = async () => {
    await redis.pipeline([["DEL", `nl:stock:lock:${creator.statsId}:print8`]]);
  };
  let tried = 0;
  const lost = await withCartStockHolds(creator, [limited("print8", 2)], async () => {
    tried += 1;
    return { id: "cs_test_cartstocklost0001" };
  });
  onGet = null;
  const after8 = (await redis.pipeline([["HGETALL", key("print8")]]))[0] as string[];
  is("a lock lost while Stripe was asked: nothing held, nothing opened", [lost, tried, after8.filter((field, i) => i % 2 === 0 && !field.startsWith("a:"))], [{ ok: false, reason: "busy" }, 0, ["cs_test_cartstockold00001"]]);
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => (commands.some((command) => command[0] === "HSET" && command[2] === "cs_test_cartstockbad00001") ? [] : original(commands));
  const unwritten = await withCartStockHolds(creator, [limited("print9", 3)], async () => ({ id: "cs_test_cartstockbad00001" }));
  redis.pipeline = original;
  is("a checkout whose hold cannot be written is closed at Stripe, nobody is sent to it, and once closed its unit is let go", [unwritten, expired.includes("cs_test_cartstockbad00001"), await stockLeft(creator, limited("print9", 3))], [{ ok: false, reason: "busy" }, true, 3]);
  let sparseOpened = 0;
  redis.pipeline = async (commands) => (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:stock-pending:v1") ? new Array(1) : original(commands));
  const sparse = await withCartStockHolds(creator, [limited("print11", 3), limited("print12", 3)], async () => {
    sparseOpened += 1;
    return { id: "cs_test_cartstocksparse01" };
  });
  redis.pipeline = original;
  // A lock taken over between the count and the provisional hold's write: the write checks every token itself (STOCK_PENDING).
  let stolenOpened = 0;
  redis.pipeline = async (commands) => {
    const writing = commands.some((command) => (command[0] === "HSET" && String(command[2]).startsWith("p_")) || (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:stock-pending:v1")));
    if (writing) await original([["SET", `nl:stock:lock:${creator.statsId}:print15`, "another-checkout"]]);
    return original(commands);
  };
  const stolen = await withCartStockHolds(creator, [limited("print15", 3)], async () => {
    stolenOpened += 1;
    return { id: "cs_test_cartstockstolen1" };
  });
  redis.pipeline = original;
  is("a lock taken over just before the provisional hold is written holds nothing and opens nothing", [stolen, stolenOpened, ((await redis.pipeline([["HGETALL", key("print15")]]))[0] as string[]).length], [{ ok: false, reason: "busy" }, 0, 0]);
  is("a reply with holes is never taken for the provisional holds' acknowledgment, and what may have landed is taken back", [sparse, sparseOpened, ((await redis.pipeline([["HGETALL", key("print11")]]))[0] as string[]).length], [{ ok: false, reason: "busy" }, 0, 0]);
  await withCartStockHolds(creator, [limited("print10", 1)], async () => ({ id: "cs_test_cartstockdone0001" }));
  complete.add("cs_test_cartstockdone0001");
  await releaseCartStockHolds(creator, [limited("print10", 1)], "cs_test_cartstockdone0001");
  is("a checkout paid but not yet marked sold, which Stripe will not close, keeps its unit", await stockLeft(creator, limited("print10", 1)), 0);

  part("The checkout closes before the hold");
  const shop = { handle: "prints", name: "Prints", email: "prints@example.com", language: "en", currency: "usd", stripeAccountId: "acct_test_cartstock1", sale: { ...NO_SALE }, cartDeal: { ...NO_DEAL }, recovery: { ...NO_RECOVERY }, hasDiscounts: false, tax: { enabled: false, included: false, ids: false, invoices: false }, affiliates: { enabled: false, percent: 0, days: 30, rates: {}, payday: 0, hold: 0 }, catalog: { id: null, items: [], head: [], inline: null } } as unknown as Store;
  const now = Math.floor(Date.now() / 1000);
  await createCartCheckout(shop, [limited("print6", 3) as Product, plain("guide1") as Product], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, held: true, remind: true });
  const closes = Number(sent.at(-1)!.get("expires_at"));
  is("a held unit's time, shorter than a reminder's hour", closes > now && closes <= now + 31 * 60, true);
  // Stripe's recovery link opens a new checkout with no unit held: never on one that holds a limited unit (3 November 2026).
  const resend = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test_cart_stock_only";
  const reminding = { ...shop, statsId: "e".repeat(32), recovery: { ...NO_RECOVERY, enabled: true, address: "1 Main St, Austin, TX 78701", asks: true } } as Store;
  await createCartCheckout(reminding, [limited("print6", 3) as Product, plain("guide1") as Product], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT, held: true });
  const heldBody = sent.at(-1)!;
  await createCartCheckout(reminding, [plain("guide1") as Product, plain("guide2") as Product], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  const freeBody = sent.at(-1)!;
  if (resend === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = resend;
  is("a checkout holding a limited unit asks for consent but has no recovery link; one holding none keeps it", [heldBody.get("consent_collection[promotions]"), heldBody.get("after_expiration[recovery][enabled]"), freeBody.get("after_expiration[recovery][enabled]")], ["auto", null, "true"]);

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
  const CART = holdCookieNames(owner).cart;
  const pay = async (ids: string[], cookie = "") => {
    const form = new URLSearchParams({ handle: "printshop", dc: "yes", dc_v: TEST_CONSENT.version });
    for (const id of ids) form.append("id", id);
    const answer = await payCart(new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: form.toString() }));
    const where = new URL(answer.headers.get("location") ?? "https://x/");
    return { to: where.hostname === "checkout.stripe.com" ? "stripe" : where.search, cookie: answer.headers.getSetCookie().find((c) => c.startsWith("nl_cart_hold_")) ?? "" };
  };
  const paid = await pay([made.Guide, made.Print, made.Poster]);
  is("paying holds a unit of each, and sets the cookie that hands them back", [paid.to, paid.cookie.includes("Path=/api/store;"), await stockLeft(owner, (await import("@/lib/catalog")).parseProduct({ id: made.Print, title: "Print", summary: "", priceCents: 2000, stock: 1 }) as Listing)], ["stripe", true, 0]);
  const again = await pay([made.Guide, made.Print, made.Poster]);
  is("the same cart from another browser: its print is sold out, back to the cart", again.to, "?cart=changed");
  const back = await pay([made.Guide, made.Print, made.Poster], paid.cookie.split(";")[0]);
  const sessionOf = (cookie: string) => cookie.split(";")[0].split("=")[1].split(".")[0];
  is("the cookie names the checkout, signed for this store", [/^nl_cart_hold_[0-9a-z]{1,16}=cs_test_\w+\.[0-9a-f]{32};/.test(paid.cookie), heldCheckout(owner, paid.cookie.split(";")[0].split("=")[1]), heldCheckout({ ...owner, statsId: "d".repeat(32) } as Store, paid.cookie.split(";")[0].split("=")[1])], [true, sessionOf(paid.cookie), null]);
  is("the browser that went back from Stripe: its old checkout closed, its units held again", [back.to, expired.includes(sessionOf(paid.cookie))], ["stripe", true]);
  const open = await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=printshop&ids=${[made.Guide, made.Print].join(",")}`));
  const cart = (await open.json()) as { items: { id: string; ok: boolean; soldOut: boolean }[]; total: string };
  // Held by another checkout, not sold: not available right now, never called sold out (lib/stock.ts, shownReading).
  is("the open cart: the print another checkout holds is not available right now, left out of the total", [cart.items.map((item) => [item.ok, item.soldOut]), cart.total], [[[true, false], [false, false]], "$20"]);
  type Opened = { items: { id: string; ok: boolean; soldOut: boolean }[]; total: string };
  const readWith = async (cookie: string) =>
    (await (await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=printshop&ids=${[made.Guide, made.Print].join(",")}`, { headers: { cookie } }))).json()) as Opened;
  const backCookie = back.cookie.split(";")[0];
  const mineBack = await readWith(backCookie);
  is("the browser back from Stripe: the print it holds is its own, not sold out, and in its total", [mineBack.items.map((item) => [item.ok, item.soldOut]), mineBack.total], [[[true, false], [true, false]], "$40"]);
  const otherBrowser = await readWith(`${CART}=cs_test_cartstocknotmine01`);
  is("a cookie naming a checkout that holds nothing frees nothing", otherBrowser.items.map((item) => [item.ok, item.soldOut]), [[true, false], [false, false]]);
  is("a cookie that is not a checkout's id frees nothing", (await readWith(`${CART}=p_x`)).items.map((item) => item.ok), [true, false]);
  is("a cookie naming the right checkout without our signature frees nothing", (await readWith(`${CART}=${sessionOf(back.cookie)}`)).items.map((item) => item.ok), [true, false]);
  is("nor with a signature that is not ours", (await readWith(`${CART}=${sessionOf(back.cookie)}.${"0".repeat(32)}`)).items.map((item) => item.ok), [true, false]);
  // Someone who learned another person's checkout id cannot close it by naming it in a cookie (3 November 2026).
  const expiredBefore = expired.length;
  const forged = await pay([made.Guide], `${CART}=${sessionOf(back.cookie)}.${"0".repeat(32)}`);
  const bare = await pay([made.Guide], `${CART}=${sessionOf(back.cookie)}`);
  is("a forged or unsigned cookie never closes another person's checkout", [forged.to, bare.to, expired.length - expiredBefore, expired.includes(sessionOf(back.cookie))], ["stripe", "stripe", 0, false]);
  const printListing = parseProduct({ id: made.Print, title: "Print", summary: "", priceCents: 2000, stock: 1 }) as Listing;
  is("the count for everyone else is unchanged", await stockLeft(owner, printListing), 0);
  await confirmCartStock(owner, [printListing], sessionOf(backCookie));
  is("once that checkout is paid, its print is sold out to that browser too", (await readWith(backCookie)).items.map((item) => item.soldOut), [false, true]);
  await redis.pipeline([["SET", `nl:stock:sold:${owner.statsId}:${made.Poster}`, "not a count"]]);
  const unread = (await (await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=printshop&ids=${made.Poster}`))).json()) as { items: { ok: boolean; soldOut: boolean }[] };
  is("a count that cannot be read is not paid for, and never said to be sold out", unread.items.map((item) => [item.ok, item.soldOut]), [[false, false]]);
  is("nor said to be in other buyers' checkouts: its line says to buy it from its own page", (unread.items as { heldMinutes?: number | null }[]).map((item) => item.heldMinutes), [null]);
  await redis.pipeline([["DEL", `nl:stock:sold:${owner.statsId}:${made.Poster}`]]);
  // Review of 513 [PF1], 4 November 2026 (M-A): limit 5, none sold, five other buyers' checkouts open. The cart said "buy it
  // from its own page", and that page says sold out with no button: the cart now says the units are in other checkouts,
  // and when they come back (HOLD_SECONDS), never sold out.
  const posterKey = `nl:stock:${owner.statsId}:${made.Poster}`;
  const [posterKept] = (await redis.pipeline([["HGETALL", posterKey]])) as [string[]];
  await redis.pipeline([["DEL", posterKey], ["HSET", posterKey, ...[1, 2, 3, 4, 5].flatMap((n) => [`cs_test_otherbuyer0000${n}`, JSON.stringify({ until: Date.now() + 600_000 })])]]);
  const heldCart = (await (await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=printshop&ids=${made.Poster}`))).json()) as { items: { ok: boolean; soldOut: boolean; heldMinutes: number | null }[] };
  is("five units in five other buyers' checkouts: not paid for, not sold out, said held, with the hold's minutes", heldCart.items.map((item) => [item.ok, item.soldOut, item.heldMinutes]), [[false, false, Math.ceil(HOLD_SECONDS / 60)]]);
  is("the hold's minutes are its real length (32: the checkout's 31 and one more)", Math.ceil(HOLD_SECONDS / 60), 32);
  is("its words, in plain English", CART_WORDS.en.held(32), "All that are left are in other buyers' checkouts right now. Try again in about 32 minutes.");
  is("said in every language, never as the line for what cannot go in a cart", Object.values(CART_WORDS).every((words) => words.held(32).includes("32") && words.held(32) !== words.gone), true);
  is("the cart shows it, and keeps \"buy it from its own page\" for the rest", readFileSync("components/store-cart.tsx", "utf8").includes("{line.soldOut ? c.soldOut : line.heldMinutes ? c.held(line.heldMinutes) : c.gone}"), true);
  await redis.pipeline([["DEL", posterKey], ...(posterKept.length ? [["HSET", posterKey, ...posterKept]] : [])]);
  await redis.pipeline([["DEL", `nl:stock:sold:${owner.statsId}:${made.Poster}`]]);

  part("What is only shown never asks Stripe, and a checkout asks it a bounded number of times");
  const key2 = (store: Store, id: string) => `nl:stock:${store.statsId}:${id}`;
  const ranOut = JSON.stringify({ until: Date.now() - 1000 });
  await redis.pipeline([["HSET", key("print30"), "cs_test_shownonly000001", ranOut]]);
  const asked = gets.length;
  is("a reading only shown counts a hold that ran out as used, says it is unchecked, and asks Stripe nothing", [await stockReading(creator, limited("print30", 1), Date.now(), { checks: shownOnly() }), gets.length - asked], [{ left: 0, unchecked: 1, holds: 1 }, 0]);
  const shownWrites: string[] = [];
  const watching = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    for (const command of commands) if (!["HLEN", "GET", "HMGET"].includes(String(command[0]))) shownWrites.push(String(command[0]));
    return watching(commands);
  };
  await redis.pipeline([]);
  await stockReading(creator, limited("print7", 3), Date.now(), { checks: shownOnly(), mine: ["cs_test_cartstocklapse01"] });
  redis.pipeline = watching;
  is("a reading only shown sends HLEN, GET and HMGET, and writes nothing", shownWrites, []);
  const four = ["print31", "print32", "print33", "print34"];
  for (const id of four) await redis.pipeline([1, 2, 3].map((n) => ["HSET", key(id), `cs_test_ranout${id}${n}00`, ranOut]));
  const before4 = gets.length;
  const counted = await withCartStockHolds(creator, four.map((id) => limited(id, 3)), async () => ({ id: "cs_test_cartstockfour0001" }));
  is("a cart's counts share MAX_CHECKS questions to Stripe, whatever it holds", [counted, gets.length - before4], [{ ok: false, reason: "soldout", ids: ["print31", "print32", "print33", "print34"] }, 5]);

  const LAMPS = "lamps@example.com";
  await claimHandle(LAMPS, "lampshop", "Lamp Shop", "");
  await ensureStatsId(LAMPS);
  await setStripeAccount(LAMPS, "acct_1TestLamps001", true);
  await setSubscription(LAMPS, { customerId: "cus_Lamps00001", subscriptionId: "sub_Lamps00001", active: true, period: paidPeriod() });
  const l: Record<string, string> = {};
  for (const [title, stock] of [["Lamp", 1], ["Shade", 2], ["Bulb", 2], ["Cord", 2], ["Card", 1]] as const) {
    const added = await addProduct(LAMPS, title, "", "20", null);
    if (!added.ok) throw new Error(`no ${title}`);
    l[title] = added.product.id;
    await setProductLink(LAMPS, added.product.id, `https://example.com/${title.toLowerCase()}`);
    if (!(await setProductExtras(LAMPS, added.product.id, { stock })).ok) throw new Error(`no stock on ${title}`);
  }
  const lamps = (await storeForEmail(LAMPS))!;
  const lampOf = async (id: string) => (await (await import("@/lib/catalog")).readListing(lamps, id))!;
  const payLamps = async (ids: string[], cookie = "") => {
    const form = new URLSearchParams({ handle: "lampshop", dc: "yes", dc_v: TEST_CONSENT.version });
    for (const id of ids) form.append("id", id);
    const answer = await payCart(new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: form.toString() }));
    const where = new URL(answer.headers.get("location") ?? "https://x/");
    const set = answer.headers.getSetCookie().find((c) => c.startsWith("nl_cart_hold_")) ?? "";
    return { to: where.hostname === "checkout.stripe.com" ? "stripe" : where.search, cookie: set.split(";")[0], cleared: /Max-Age=0/.test(set), raw: set };
  };
  const readLamps = async (ids: string[], cookie = "") =>
    (await (await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=lampshop&ids=${ids.join(",")}`, cookie ? { headers: { cookie } } : undefined))).json()) as { items: { id: string; ok: boolean; soldOut: boolean }[] };

  await redis.pipeline([["HSET", key2(lamps, l.Card), "cs_test_cardranout00001", ranOut]]);
  const beforeOpen = gets.length;
  const cardLine = (await readLamps([l.Card])).items.map((item) => [item.ok, item.soldOut]);
  is("the open cart asks Stripe nothing: a hold that ran out and is not settled is not available right now, never sold out", [cardLine, gets.length - beforeOpen], [[[false, false]], 0]);

  // The stock commands of a full cart's checkout, its old checkout handed back first, at most STOCK_ORDER_COMMANDS.
  await redis.pipeline([["HDEL", key2(lamps, l.Card), "cs_test_cardranout00001"]]);
  const firstFull = await payLamps([l.Shade, l.Bulb, l.Cord, l.Card]);
  const firstCookie = firstFull.cookie;
  let stockCommands = 0;
  const counting = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    for (const command of commands) if (command.some((arg) => typeof arg === "string" && arg.startsWith("nl:stock:"))) stockCommands += 1;
    return counting(commands);
  };
  const again4 = await payLamps([l.Shade, l.Bulb, l.Cord, l.Card], firstCookie);
  redis.pipeline = counting;
  is("a full cart's checkout, its old one handed back first, sends at most STOCK_ORDER_COMMANDS stock commands", [firstFull.to, again4.to, stockCommands > 0 && stockCommands <= STOCK_ORDER_COMMANDS], ["stripe", "stripe", true]);

  part("Handing back an old checkout");
  // What it held outside the new cart is let go too (read from the checkout Stripe closed).
  for (const id of [l.Shade, l.Bulb, l.Cord, l.Card]) await redis.pipeline([["DEL", key2(lamps, id)]]);
  const shadeAndBulb = await payLamps([l.Shade, l.Bulb]);
  const onlyShade = await payLamps([l.Shade], shadeAndBulb.cookie);
  is("an old checkout's hold is let go on every product it held, in the new cart or not", [onlyShade.to, await stockLeft(lamps, await lampOf(l.Shade)), await stockLeft(lamps, await lampOf(l.Bulb))], ["stripe", 1, 2]);
  // Paid, with nobody back on the thanks page: Stripe will not close it, so it is read back and marked sold.
  const lampPaid = await payLamps([l.Lamp]);
  const lampSession = lampPaid.cookie.split("=")[1].split(".")[0];
  complete.add(lampSession);
  sessions.set(lampSession, { ...(sessions.get(lampSession) ?? {}), status: "complete", payment_status: "paid" });
  const looked = await readLamps([l.Lamp], lampPaid.cookie);
  is("before paying again, the browser sees the lamp it paid for as its own", looked.items.map((item) => [item.ok, item.soldOut]), [[true, false]]);
  const lampAgain = await payLamps([l.Lamp], lampPaid.cookie);
  is("paying again finds it paid: counted sold once, its hold gone, back to the cart, and its cookie cleared", [lampAgain.to, lampAgain.cleared, await soldOf(lamps, l.Lamp, lampSession), (await readEntriesOf(lamps, l.Lamp))[lampSession]], ["?cart=changed", true, { sold: 1, paid: true }, undefined]);
  is("the open cart then says it is sold out, even to that browser", (await readLamps([l.Lamp], lampPaid.cookie)).items.map((item) => [item.ok, item.soldOut]), [[false, true]]);

  part("The way back from a cart's checkout");
  const beforeLeft = gets.length;
  await redis.pipeline([["HSET", key2(lamps, l.Card), "cs_test_cardranout00002", ranOut]]);
  is("lists what is left of it, as its reminder does: none sold out, Stripe never asked", [(await cartItems(lamps, [l.Lamp, l.Shade, l.Card])).map((p) => p.id), gets.length - beforeLeft], [[l.Shade], 0]);

  part("Holds Stripe never settles do not keep the others from being asked about");
  const stuck = limited("print40", 6);
  const ranOutAt = Date.now() - 1000;
  for (let n = 1; n <= 5; n += 1) {
    missing.add(`cs_test_stuckhold0000${n}`);
    await redis.pipeline([["HSET", key("print40"), `cs_test_stuckhold0000${n}`, JSON.stringify({ until: ranOutAt - 10 * n })]]);
  }
  sessions.set("cs_test_reallyexpired01", { id: "cs_test_reallyexpired01", status: "expired" });
  await redis.pipeline([["HSET", key("print40"), "cs_test_reallyexpired01", JSON.stringify({ until: ranOutAt })]]);
  const t0 = Date.now();
  const readsOf = [await stockLeft(creator, stuck, t0), await stockLeft(creator, stuck, t0 + 1000), await stockLeft(creator, stuck, t0 + 2000)];
  is("five holds Stripe does not know spend one read's questions; the next asks the one not asked yet, which is let go", readsOf, [0, 1, 1]);
  const stillThere = await readEntriesOf(creator, "print40");
  is("a hold Stripe does not know, recently ended, still counts as used (never a free unit) and is asked about again later", [stillThere["cs_test_stuckhold00001"]?.until, Object.keys(stillThere).length, typeof stillThere["cs_test_stuckhold00001"]?.asked], [ranOutAt - 10, 5, "number"]);
  const longAgo = limited("print41", 3);
  for (const n of [1, 2]) {
    missing.add(`cs_test_longgone0000${n}`);
    await redis.pipeline([["HSET", key("print41"), `cs_test_longgone0000${n}`, JSON.stringify({ until: Date.now() - 2 * 24 * 60 * 60 * 1000 })]]);
  }
  const firstLook = await stockLeft(creator, longAgo);
  const asks = gets.length;
  const secondLook = await stockLeft(creator, longAgo);
  const gone = await readEntriesOf(creator, "print41");
  is("a day after its end, a hold Stripe does not know is taken for sold: never free, never asked about again", [firstLook, secondLook, gets.length - asks, Object.keys(gone), await soldOf(creator, "print41", "cs_test_longgone00001")], [1, 1, 0, [], { sold: 2, paid: true }]);
  for (let n = 0; n < MAX_LAPSED + 2; n += 1) await redis.pipeline([["HSET", key("print42"), `p_lapsed${String(n).padStart(25, "0")}`, ranOut]]);
  const lapsedLeft = await stockLeft(creator, limited("print42", 2));
  const lapsedKept42 = Object.keys(await readEntriesOf(creator, "print42")).length;
  const lapsedHeld = await withCartStockHolds(creator, [limited("print42", 2)], async () => ({ id: "cs_test_cartstocklaps042" }));
  is("lapsed provisional holds are free, and each count lets go of MAX_LAPSED at the most, the next count the rest",
    [lapsedLeft, lapsedKept42, lapsedHeld.ok, Object.keys(await readEntriesOf(creator, "print42"))],
    [2, 2, true, ["cs_test_cartstocklaps042"]]);

  part("A product bought alone and the cart know each other's hold");
  const vaseMade = await addProduct(LAMPS, "Vase", "", "20", null);
  if (!vaseMade.ok) throw new Error("no vase");
  await setProductLink(LAMPS, vaseMade.product.id, "https://example.com/vase");
  await setProductExtras(LAMPS, vaseMade.product.id, { stock: 1 });
  const lamps2 = (await storeForEmail(LAMPS))!;
  const vase = (await (await import("@/lib/catalog")).readListing(lamps2, vaseMade.product.id))!;
  const alone2 = await withStockHold(lamps2, vase, async () => ({ id: "cs_test_vasealone0000001" }));
  sessions.set("cs_test_vasealone0000001", { id: "cs_test_vasealone0000001", status: "open", metadata: { store: "lampshop", product: vase.id } });
  const productCookie = `${holdCookieNames(lamps2).product}=${holdCookieValue(lamps2, "cs_test_vasealone0000001")}`;
  is("the cart counts the unit a product bought alone holds in this browser as its own", [alone2.ok, (await readLamps([vase.id], productCookie)).items.map((item) => [item.ok, item.soldOut]), (await readLamps([vase.id])).items.map((item) => item.ok)], [true, [[true, false]], [false]]);
  const vaseInCart = await payLamps([vase.id], productCookie);
  is("paying for it in a cart closes the product's own checkout first, and holds it again", [vaseInCart.to, expired.includes("cs_test_vasealone0000001")], ["stripe", true]);
  is("each store has its own cookies, so a checkout on one never replaces another's", [holdCookieNames(lamps2).cart !== holdCookieNames(owner).cart, holdCookieNames(lamps2).product !== holdCookieNames(owner).product, vaseInCart.cookie.startsWith(`${holdCookieNames(lamps2).cart}=`)], [true, true, true]);
  const pathSet = (await payLamps([l.Bulb])).raw;
  is("the cookies are sent to the cart and to a product bought alone", /Path=\/api\/store;/.test(pathSet), true);

  part("The cookie is cleared only when the old checkout is known closed or paid");
  for (const id of [l.Card]) await redis.pipeline([["DEL", key2(lamps, id)]]);
  const cardHeld = await payLamps([l.Card]);
  const cardSession = cardHeld.cookie.split("=")[1].split(".")[0];
  complete.add(cardSession);
  const cardAgain = await payLamps([l.Card], cardHeld.cookie);
  is("an old checkout Stripe neither closes nor calls paid keeps its cookie", [cardAgain.to, cardAgain.cleared], ["?cart=changed", false]);

  part("What the open cart offers");
  const SHOP = "mugs@example.com";
  await claimHandle(SHOP, "mugshop", "Mug Shop", "");
  await ensureStatsId(SHOP);
  await setStripeAccount(SHOP, "acct_1TestMugs0001", true);
  await setSubscription(SHOP, { customerId: "cus_Mugs000001", subscriptionId: "sub_Mugs000001", active: true, period: paidPeriod() });
  const m: Record<string, string> = {};
  for (const [title, price] of [["Guide", "20"], ["Pen", "20"], ["Cup", "20"], ["Mug", "20"], ["Set", "25"], ["Box", "30"]] as const) {
    const added = await addProduct(SHOP, title, "", price, null);
    if (!added.ok) throw new Error(`no ${title}`);
    m[title] = added.product.id;
    if (title !== "Set" && title !== "Box") await setProductLink(SHOP, added.product.id, `https://example.com/${title.toLowerCase()}`);
  }
  // What a bundle holds is never limited (lib/bundle-rules.ts); the bundle itself can be.
  for (const bundle of ["Set", "Box"]) if (!(await setProductBundle(SHOP, m[bundle], [m.Guide, m.Pen])).ok) throw new Error(`no bundle ${bundle}`);
  for (const [title, stock] of [["Cup", 2], ["Mug", 1], ["Set", 1]] as const) {
    if (!(await setProductExtras(SHOP, m[title], { stock })).ok) throw new Error(`no stock on ${title}`);
  }
  if (!(await setProductPairs(SHOP, m.Guide, [m.Mug, m.Cup])).ok) throw new Error("no pairs");
  const mugs = (await storeForEmail(SHOP))!;
  const listed = async (id: string) => (await (await import("@/lib/catalog")).readListing(mugs, id))!;
  const sell = async (id: string) => confirmCartStock(mugs, [await listed(id)], `cs_test_mugsold${id.slice(0, 10).padEnd(10, "0")}`);
  type Offered = { suggest: { id: string }[]; bundle: { id: string } | null };
  const offered = async (ids: string[]) => (await (await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=mugshop&ids=${ids.join(",")}`))).json()) as Offered;
  const before = await offered([m.Guide]);
  is("before any sells out, both picks are offered", before.suggest.map((one) => one.id), [m.Mug, m.Cup]);
  is("and the limited bundle that makes the cart cheaper", (await offered([m.Guide, m.Pen])).bundle?.id, m.Set);
  await sell(m.Mug);
  await sell(m.Set);
  is("a pick that sold out is never offered; one with units left still is", (await offered([m.Guide])).suggest.map((one) => one.id), [m.Cup]);
  is("a bundle that sold out is never offered; the next one that makes the cart cheaper is", (await offered([m.Guide, m.Pen])).bundle?.id, m.Box);
  const reads: string[] = [];
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    for (const command of commands) if (command[0] === "HGETALL" && String(command[1]).startsWith(`nl:stock:${mugs.statsId}:`)) reads.push(String(command[1]));
    return pipe(commands);
  };
  await offered([m.Guide]);
  redis.pipeline = pipe;
  is("the offers read each limited count once, never more than MAX_SUGGEST", reads.filter((key) => key.endsWith(m.Mug) || key.endsWith(m.Cup)).length <= 3, true);

  part("Units sold leave the hash of holds (4 November 2026)");
  const soldHold = await withCartStockHolds(creator, [limited("print50", 3)], async () => ({ id: "cs_test_soldleaves00001" }));
  await confirmCartStock(creator, [limited("print50", 3)], "cs_test_soldleaves00001");
  await confirmCartStock(creator, [limited("print50", 3)], "cs_test_soldleaves00001");
  is("a paid checkout's unit is counted once in the sold count, however often the buyer comes back, and its hold leaves the hash",
    [soldHold.ok, await soldOf(creator, "print50", "cs_test_soldleaves00001"), Object.keys(await readEntriesOf(creator, "print50")), await stockLeft(creator, limited("print50", 3))],
    [true, { sold: 1, paid: true }, [], 2]);
  // Marked sold the old way (main before 4 November 2026): counted as it is, moved under the lock, never twice.
  await redis.pipeline([["HSET", key("print51"), "cs_test_oldwaysold00001", JSON.stringify({ until: 0, paid: true }), "cs_test_oldwaysold00002", JSON.stringify({ until: 0, paid: true })]]);
  const before51 = await stockLeft(creator, limited("print51", 3));
  const moved = await withCartStockHolds(creator, [limited("print51", 3)], async () => ({ id: "cs_test_oldwaymoved0001" }));
  await confirmStock(creator, limited("print51", 3), "cs_test_oldwaysold00001");
  is("units marked sold the old way count as they are, and are moved to the sold count under the lock, once",
    [before51, moved.ok, (await soldOf(creator, "print51")).sold, Object.keys(await readEntriesOf(creator, "print51")), await stockLeft(creator, limited("print51", 3))],
    [1, true, 2, ["cs_test_oldwaymoved0001"], 0]);
  // A hash at its most holds takes no more, so every reading of it stays bounded.
  await redis.pipeline(Array.from({ length: STOCK_ENTRIES_MAX }, (_, n) => ["HSET", key("print52"), `cs_test_fullhash${String(n).padStart(8, "0")}`, JSON.stringify({ until: Date.now() + 600_000 })]));
  let fullOpened = 0;
  const fullHash = await withCartStockHolds(creator, [limited("print52", STOCK_ENTRIES_MAX + 10)], async () => {
    fullOpened += 1;
    return { id: "cs_test_fullhashnew0001" };
  });
  is("a product whose hash keeps STOCK_ENTRIES_MAX holds takes no new one", [fullHash, fullOpened], [{ ok: false, reason: "busy" }, 0]);
  await redis.pipeline([["DEL", key("print52")]]);

  part("Review of 4 November 2026: a hold's size, the paid marks, the hash's real size");
  // L-4: a checkout id longer than a hold may be written under is never written; the checkout is closed and nothing is held.
  is("the longest id a hold is written under, with the longest value, fits STOCK_ENTRY_BYTES", [STOCK_SESSION_MAX, STOCK_SESSION_MAX + JSON.stringify({ until: 9_999_999_999_999, asked: 9_999_999_999_999 }).length <= STOCK_ENTRY_BYTES], [85, true]);
  const longId = `cs_test_${"L".repeat(STOCK_SESSION_MAX - 8 + 1)}`;
  const expiredBeforeLong = expired.length;
  const tooLong = await withCartStockHolds(creator, [limited("print60", 3)], async () => ({ id: longId }));
  is("a checkout whose id is longer is closed at Stripe and holds nothing, not even its provisional hold",
    [tooLong, expired.slice(expiredBeforeLong), Object.keys(await readEntriesOf(creator, "print60")), await stockLeft(creator, limited("print60", 3))],
    [{ ok: false, reason: "busy" }, [longId], [], 3]);
  const longestOk = `cs_test_${"K".repeat(STOCK_SESSION_MAX - 8)}`;
  const fitting = await withCartStockHolds(creator, [limited("print61", 3)], async () => ({ id: longestOk }));
  is("one exactly as long as it may be is held", [fitting.ok, Object.keys(await readEntriesOf(creator, "print61"))], [true, [longestOk]]);
  is("a cookie naming a longer one is never made nor read", [holdCookieValue(creator, longId), heldCheckout(creator, `${longId}.${"0".repeat(32)}`)], [null, null]);
  // L-2: the marks that a checkout's unit was counted sold name the store's id, and go with the store.
  const closingOwners = { byMark: new Map([["a".repeat(32), "closing@example.com"]]), byHandle: new Map<string, string>(), byRef: new Map<string, string>() };
  const paidMark = `nl:stock:paid:${"a".repeat(32)}:print1:cs_test_closingmark0001`;
  is("a paid mark is erased with its store, not left to expire", [closingFamilyOf(paidMark), CLOSING["nl:stock:paid:"].how, ownerOfKey(paidMark, CLOSING["nl:stock:paid:"], closingOwners)], ["nl:stock:paid:", "erase", "closing@example.com"]);
  // L-3: the registry says the hash's real worst size, which PRODUCT_SIDE_BYTES does not hold.
  const stockFamily = FAMILIES["nl:stock:@lib/stock.ts"].what;
  is("the registry gives the hash's worst size, STOCK_ENTRIES_MAX holds of STOCK_ENTRY_BYTES", [STOCK_ENTRIES_MAX * STOCK_ENTRY_BYTES, stockFamily.includes((STOCK_ENTRIES_MAX * STOCK_ENTRY_BYTES).toLocaleString("en-US")), stockFamily.includes("does not hold")], [208_000, true, true]);

  part("What the stock reads cost, and who pays for them");
  const shownCost = (2 * 3 + MAX_CART) * SHOWN_READ_COMMANDS * COMMAND + (2 * 3 + MAX_CART) * 2 * STOCK_ENTRY_BYTES * DB_BYTE;
  is("the open cart's reads only shown fit inside CART_READ_STOCK_UNITS later pages", shownCost <= CART_READ_STOCK_UNITS * laterPageCost(), true);
  is("a try at paying for limited products costs no more than STOCK_ATTEMPT_UNITS later pages, the units it takes first", ORDER_STOCK <= STOCK_ATTEMPT_UNITS * laterPageCost(), true);
  const cartRoute = readFileSync("app/api/store/cart/route.ts", "utf8");
  is("the cart's payment takes its units before any stock work", cartRoute.indexOf("STOCK_ATTEMPT_UNITS)") > 0 && cartRoute.indexOf("STOCK_ATTEMPT_UNITS)") < cartRoute.indexOf("releaseCartStockHolds(store, products"), true);
  const productRoute = readFileSync("app/api/store/checkout/route.ts", "utf8");
  is("and a product bought alone too", productRoute.indexOf("STOCK_ATTEMPT_UNITS)") > 0 && productRoute.indexOf("STOCK_ATTEMPT_UNITS)") < productRoute.indexOf("releaseStockHold(store, product, cookies.product)"), true);

  part("A new cart with nothing in common leaves the old checkout open");
  for (const id of [l.Shade, l.Bulb]) await redis.pipeline([["DEL", key2(lamps, id)]]);
  const oldShade = await payLamps([l.Shade]);
  const expiredBefore2 = expired.length;
  const otherCart = await payLamps([l.Bulb], oldShade.cookie);
  is("a cart without the old checkout's products does not close it", [otherCart.to, expired.length - expiredBefore2, expired.includes(oldShade.cookie.split("=")[1].split(".")[0])], ["stripe", 0, false]);

  part("Where else a sold out one is not offered");
  is("the cart's remove button is a 44 by 44 target (WCAG 2.5.5)", /aria-label=\{c\.remove\(line\.title\)\}\s+className="grid h-11 w-11 /.test(readFileSync("components/store-cart.tsx", "utf8")), true);
  is("nor on a product bought alone whose unit is held", readFileSync("lib/store-checkout.ts", "utf8").includes('if (extras.held) body.delete("after_expiration[recovery][enabled]");'), true);
  is("the way back from a cart's checkout lists it as the reminder does", readFileSync("app/[handle]/left/page.tsx", "utf8").includes("const items = await cartItems(store, cartIds, await takePublicRequest(store, \"public\", Date.now(), 1)"), true);
  is("the store page, the product page and Goes well with", [
    readFileSync("app/[handle]/page.tsx", "utf8").includes("cartable(product) && left.get(product.id) !== 0"),
    readFileSync("app/[handle]/p/[product]/page.tsx", "utf8").includes("cartable(product) && remaining !== 0"),
    readFileSync("app/[handle]/p/[product]/page.tsx", "utf8").includes("!pairedOut.has(p.id)"),
  ], [true, true, true]);
  const productPage = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  is("Goes well with: a count that cannot be read is offered, as the store page does (the cart's own read refuses it)", [
    productPage.includes("(await stockLeft(store, p, Date.now(), { checks: shownOnly() }).catch(() => null)) === 0 ? p.id : null"),
    productPage.includes("stockLeft(store, p).catch(() => 0)"),
    readFileSync("app/[handle]/page.tsx", "utf8").includes("stockLeft(store, product).catch(() => null)"),
  ], [true, false, true]);
  is("the thanks page marks the cart's limited products sold", readFileSync("app/[handle]/thanks/page.tsx", "utf8").includes("confirmCartStock(store, order.bumps.map((added) => added.product), sessionId)"), true);
  is("nor in the cart's reminder", readFileSync("lib/checkout-recovery.ts", "utf8").includes("return kept.filter((_, i) => left[i] !== 0);"), true);

  done();
}

void main();
