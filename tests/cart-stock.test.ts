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
import { cartable } from "@/lib/cart-rules";
import { createCartCheckout, offersCart } from "@/lib/cart-checkout";
import { KIND, parseProduct } from "@/lib/catalog";
import { MAX_LAPSED, STOCK_ORDER_COMMANDS, confirmCartStock, heldCheckout, holdCookieNames, holdCookieValue, releaseCartStockHolds, shownOnly, stockLeft, stockReading, withCartStockHolds, withStockHold } from "@/lib/stock";
import { cartItems } from "@/lib/checkout-recovery";
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

const readEntriesOf = async (store: Store, id: string) => {
  const [raw] = await redis.pipeline([["HGETALL", `nl:stock:${store.statsId}:${id}`]]);
  const list = raw as string[];
  return Object.fromEntries(list.flatMap((value, i) => (i % 2 === 0 ? [[value, JSON.parse(list[i + 1]) as { until: number; paid?: boolean }]] : []))) as Record<string, { until: number; paid?: boolean }>;
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
  is("a provisional hold that lapsed is let go without asking Stripe", [await stockLeft(creator, limited("print7", 1)), gets.some((id) => id.startsWith("p_")), (await redis.pipeline([["HGETALL", key("print7")]]))[0]], [1, false, []]);
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
  redis.pipeline = async (commands) => (commands.length === 2 && commands[0][0] === "HSET" && commands[1][0] === "HSET" ? new Array(2) : original(commands));
  const sparse = await withCartStockHolds(creator, [limited("print11", 3), limited("print12", 3)], async () => {
    sparseOpened += 1;
    return { id: "cs_test_cartstocksparse01" };
  });
  redis.pipeline = original;
  is("a reply with holes is never taken for the provisional holds' acknowledgment", [sparse, sparseOpened], [{ ok: false, reason: "busy" }, 0]);
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
  is("the open cart: the held print sold out, left out of the total", [cart.items.map((item) => [item.ok, item.soldOut]), cart.total], [[[true, false], [false, true]], "$20"]);
  type Opened = { items: { id: string; ok: boolean; soldOut: boolean }[]; total: string };
  const readWith = async (cookie: string) =>
    (await (await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=printshop&ids=${[made.Guide, made.Print].join(",")}`, { headers: { cookie } }))).json()) as Opened;
  const backCookie = back.cookie.split(";")[0];
  const mineBack = await readWith(backCookie);
  is("the browser back from Stripe: the print it holds is its own, not sold out, and in its total", [mineBack.items.map((item) => [item.ok, item.soldOut]), mineBack.total], [[[true, false], [true, false]], "$40"]);
  const otherBrowser = await readWith(`${CART}=cs_test_cartstocknotmine01`);
  is("a cookie naming a checkout that holds nothing frees nothing", otherBrowser.items.map((item) => [item.ok, item.soldOut]), [[true, false], [false, true]]);
  is("a cookie that is not a checkout's id frees nothing", (await readWith(`${CART}=p_x`)).items.map((item) => item.soldOut), [false, true]);
  is("a cookie naming the right checkout without our signature frees nothing", (await readWith(`${CART}=${sessionOf(back.cookie)}`)).items.map((item) => item.soldOut), [false, true]);
  is("nor with a signature that is not ours", (await readWith(`${CART}=${sessionOf(back.cookie)}.${"0".repeat(32)}`)).items.map((item) => item.soldOut), [false, true]);
  // Someone who learned another person's checkout id cannot close it by naming it in a cookie (3 November 2026).
  const expiredBefore = expired.length;
  const forged = await pay([made.Guide], `${CART}=${sessionOf(back.cookie)}.${"0".repeat(32)}`);
  const bare = await pay([made.Guide], `${CART}=${sessionOf(back.cookie)}`);
  is("a forged or unsigned cookie never closes another person's checkout", [forged.to, bare.to, expired.length - expiredBefore, expired.includes(sessionOf(back.cookie))], ["stripe", "stripe", 0, false]);
  const printListing = parseProduct({ id: made.Print, title: "Print", summary: "", priceCents: 2000, stock: 1 }) as Listing;
  is("the count for everyone else is unchanged", await stockLeft(owner, printListing), 0);
  await confirmCartStock(owner, [printListing], sessionOf(backCookie));
  is("once that checkout is paid, its print is sold out to that browser too", (await readWith(backCookie)).items.map((item) => item.soldOut), [false, true]);
  await redis.pipeline([["HSET", `nl:stock:${owner.statsId}:${made.Poster}`, "cs_test_cartstockjunk0001", "not a hold"]]);
  const unread = (await (await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=printshop&ids=${made.Poster}`))).json()) as { items: { ok: boolean; soldOut: boolean }[] };
  is("a count that cannot be read is not paid for, and never said to be sold out", unread.items.map((item) => [item.ok, item.soldOut]), [[false, false]]);

  part("What is only shown never asks Stripe, and a checkout asks it a bounded number of times");
  const key2 = (store: Store, id: string) => `nl:stock:${store.statsId}:${id}`;
  const ranOut = JSON.stringify({ until: Date.now() - 1000 });
  await redis.pipeline([["HSET", key("print30"), "cs_test_shownonly000001", ranOut]]);
  const asked = gets.length;
  is("a reading only shown counts a hold that ran out as used, says it is unchecked, and asks Stripe nothing", [await stockReading(creator, limited("print30", 1), Date.now(), { checks: shownOnly() }), gets.length - asked], [{ left: 0, unchecked: 0 + 1 }, 0]);
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
  is("paying again finds it paid: marked sold, back to the cart, and its cookie cleared", [lampAgain.to, lampAgain.cleared, (await readEntriesOf(lamps, l.Lamp))[lampSession]?.paid], ["?cart=changed", true, true]);
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
  is("a hold Stripe does not know, recently ended, still counts as used (never a free unit) and is asked about again later", [stillThere["cs_test_stuckhold00001"]?.paid, Object.keys(stillThere).filter((field) => !field.startsWith("a:")).length], [undefined, 5]);
  const longAgo = limited("print41", 3);
  for (const n of [1, 2]) {
    missing.add(`cs_test_longgone0000${n}`);
    await redis.pipeline([["HSET", key("print41"), `cs_test_longgone0000${n}`, JSON.stringify({ until: Date.now() - 2 * 24 * 60 * 60 * 1000 })]]);
  }
  const firstLook = await stockLeft(creator, longAgo);
  const asks = gets.length;
  const secondLook = await stockLeft(creator, longAgo);
  const gone = await readEntriesOf(creator, "print41");
  is("a day after its end, a hold Stripe does not know is taken for sold: never free, never asked about again", [firstLook, secondLook, gets.length - asks, gone["cs_test_longgone00001"]?.paid, gone["cs_test_longgone00002"]?.paid], [1, 1, 0, true, true]);
  for (let n = 0; n < MAX_LAPSED + 2; n += 1) await redis.pipeline([["HSET", key("print42"), `p_lapsed${String(n).padStart(25, "0")}`, ranOut]]);
  const lapsedLeft = await stockLeft(creator, limited("print42", 2));
  is("lapsed provisional holds are free, and one count lets go of MAX_LAPSED at the most", [lapsedLeft, Object.keys(await readEntriesOf(creator, "print42")).length], [2, 2]);

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
  is("the cart counts the unit a product bought alone holds in this browser as its own", [alone2.ok, (await readLamps([vase.id], productCookie)).items.map((item) => [item.ok, item.soldOut]), (await readLamps([vase.id])).items.map((item) => item.soldOut)], [true, [[true, false]], [true]]);
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

  part("Where else a sold out one is not offered");
  const { readFileSync } = await import("node:fs");
  is("nor on a product bought alone whose unit is held", readFileSync("lib/store-checkout.ts", "utf8").includes('if (extras.held) body.delete("after_expiration[recovery][enabled]");'), true);
  is("the way back from a cart's checkout lists it as the reminder does", readFileSync("app/[handle]/left/page.tsx", "utf8").includes("const items = await cartItems(store, cartIds);"), true);
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
