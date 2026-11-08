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
import { StripeError } from "@/lib/stripe-account";
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
  await withCartStockHolds(creator, [limited("print13", 5)], async () => {
    throw new NotAsked("refused before Stripe was asked");
  }, (error) => error instanceof NotAsked).catch(() => {});
  is("a refusal the caller names, raised before Stripe is asked, holds nothing", await stockLeft(creator, limited("print13", 5)), 5);
  let lostOpen = "";
  await withCartStockHolds(creator, [limited("print14", 5), limited("print15", 5)], async () => {
    throw new TypeError("Connection lost after the checkout was made");
  }).catch((error: Error) => {
    lostOpen = error.message;
  });
  is("an opening whose answer was lost keeps its units held: the checkout may exist at Stripe", [lostOpen, await stockLeft(creator, limited("print14", 5)), await stockLeft(creator, limited("print15", 5))], ["Connection lost after the checkout was made", 4, 4]);
  is("and the held ones lapse once any checkout made under them has closed", await stockLeft(creator, limited("print14", 5), Date.now() + 37 * 60 * 1000 + 1000), 5);
  is("a count that cannot be read opens nothing", await withCartStockHolds({ statsId: null } as unknown as Store, [a], async () => ({ id: "x" })), { ok: false, reason: "busy" });
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
  is("a lock lost while Stripe was asked: nothing held, nothing opened", [lost, tried, after8.filter((_, i) => i % 2 === 0)], [{ ok: false, reason: "busy" }, 0, ["cs_test_cartstockold00001"]]);
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => (commands.some((command) => command[0] === "HSET" && command[2] === "cs_test_cartstockbad00001") ? [] : original(commands));
  const unwritten = await withCartStockHolds(creator, [limited("print9", 3)], async () => ({ id: "cs_test_cartstockbad00001" }));
  redis.pipeline = original;
  is("a checkout whose hold cannot be written is closed at Stripe, and nobody is sent to it", [unwritten, expired.includes("cs_test_cartstockbad00001")], [{ ok: false, reason: "busy" }, true]);
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
  is("nor in the cart's reminder", readFileSync("lib/checkout-recovery.ts", "utf8").includes("return kept.filter((_, i) => left[i] !== 0);"), true);

  done();
}

void main();
