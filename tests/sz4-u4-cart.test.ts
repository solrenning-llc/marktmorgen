/**
 * Member and past-buyer prices in the cart (620 [SZ4], unit 4; the rules and
 * the single checkout are unit 1, tests/member-price.test.ts).
 *
 * What is checked, against the in-memory Redis and a Stripe stand-in:
 *
 *   - a cart line is priced at the largest of the store's sale, the fair
 *     price for the buyer's country and the member price, never two; the
 *     store's deal for buying more stays on top, exactly as it does on a sale;
 *   - the open cart (GET) shows a member price only to an address proved the
 *     way unit 1 proves it, and remembers in this browser what it showed;
 *   - paying (POST) proves it again and charges the member price only when it
 *     equals what the cart showed for every line; anything else goes back to
 *     the cart with nothing opened, so Stripe never charges a price the cart
 *     did not show; the checkout opens with the proved address fixed;
 *   - unknown (Stripe failing) is the normal price, shown and charged;
 *   - one proof per cart check, whatever the number of lines: the public
 *     requests counted once and at most MEMBER_PRICE_STRIPE_CALLS to Stripe.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { cartPriceFor } from "@/lib/cart-checkout";
import { CART_MEMBER_SECONDS, cartMemberCookie, cartMemberValue, readCartMember } from "@/lib/cart-member";
import { MEMBER_PRICE_STRIPE_CALLS, memberOffProved, memberProofFor } from "@/lib/member-price";
import { readListing, readListings } from "@/lib/catalog";
import { NO_SALE } from "@/lib/store-sale";
import { DEFAULT_FAIR } from "@/lib/fair-price";
import { GET as readCart, POST as payCart } from "@/app/api/store/cart/route";
import { addProduct, claimHandle, ensureStatsId, setCartDeal, setMemberPrices, setProductLink, setStoreSale, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { mintPass, passCookieName } from "@/lib/learn";
import { SESSION_COOKIE, openSession } from "@/lib/auth";

process.env.STRIPE_SECRET_KEY = "sk_test_member_cart_only";
const OWNER = "owner@example.com";
const MEMBER = "member@example.com";
const HANDLE = "harbor";

// ------------------------------------------------------------- Stripe stand-in

const checkouts: URLSearchParams[] = [];
let sessionReads = 0;
let sessionsByEmail: Record<string, unknown[] | "fail"> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"c".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/cart" });
  }
  if (path === "/checkout/sessions" && method === "GET") {
    sessionReads += 1;
    const rows = sessionsByEmail[url.searchParams.get("customer_details[email]") ?? ""] ?? [];
    if (rows === "fail") return answer({ error: { message: "down" } }, 500);
    return answer({ object: "list", data: rows, has_more: false });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

let n = 0;
const joined = (product: string, status: string) => ({
  id: `cs_test_member${String((n += 1)).padStart(6, "0")}`,
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  metadata: { store: HANDLE, product },
  payment_intent: null,
  subscription: { id: "sub_Member000001", object: "subscription", status, metadata: { store: HANDLE, product }, items: { data: [] } },
});

const jar = (cookie: string) => {
  const cookies = new Map(cookie.split("; ").map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] as const));
  return { get: (name: string) => (cookies.has(name) ? { value: cookies.get(name)! } : undefined) };
};

type CartAnswer = { ok: boolean; items: { id: string; cents: number; price: string; ok: boolean }[]; total: string };

async function main(): Promise<void> {
  redis.clear();

  part("A line's price");
  const product = (id: string, priceCents: number) => ({ id, priceCents, recurring: null, call: null, pwyw: null, options: [] });
  const now = Math.floor(Date.now() / 1000);
  const plain = { sale: NO_SALE, fair: DEFAULT_FAIR } as never;
  is("a member price on a product with nothing else off", cartPriceFor(plain, product("a", 2000), "US", 20, now), { cents: 1600, off: 20, member: true });
  is("none: the normal price", cartPriceFor(plain, product("a", 2000), "US", 0, now), { cents: 2000, off: 0, member: false });
  is("a percentage off the list is never taken", cartPriceFor(plain, product("a", 2000), "US", 23, now), { cents: 2000, off: 0, member: false });
  const onSale = { sale: { name: "Spring", coupon: "spring", percent: 25, starts: now - 60, ends: now + 3600, all: true, products: [] }, fair: DEFAULT_FAIR } as never;
  is("a larger sale wins, never both", cartPriceFor(onSale, product("a", 2000), "US", 20, now), { cents: 1500, off: 25, member: false });
  is("a larger member price wins over a smaller sale, never both", cartPriceFor(onSale, product("a", 2000), "US", 30, now), { cents: 1400, off: 30, member: true });

  part("The cart's claim, kept in the browser that was shown it");
  is("written as each line's percentage, in the cart's order", cartMemberValue([["p1", 20], ["p2", 0], ["p3", 30]]), "p1:20.p3:30");
  is("read back", [...readCartMember("p1:20.p3:30")], [["p1", 20], ["p3", 30]]);
  is("anything else reads as nothing shown", [readCartMember(undefined), readCartMember(""), readCartMember("p1:23"), readCartMember("p1:20;x"), readCartMember("bad id:20")].map((m) => m.size), [0, 0, 0, 0, 0]);
  is("kept two hours at most", CART_MEMBER_SECONDS <= 7200, true);

  part("In the store's cart");
  await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0002", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "Kitchen Club", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  const p: Record<string, string> = {};
  for (const [title, price] of [["Planner", "27"], ["Guide", "12"], ["Notes", "10"]]) {
    const added = await addProduct(OWNER, title, "", price, null);
    if (!added.ok) throw new Error(`no ${title}`);
    p[title] = added.product.id;
    await setProductLink(OWNER, added.product.id, `https://example.com/${title.toLowerCase()}`);
  }
  if (!club.ok) throw new Error("no club");
  await setMemberPrices(OWNER, { on: true, rules: [{ id: "club", percent: 20, by: [club.product.id], all: false, products: [p.Planner, p.Guide] }] });
  const store = (await storeForEmail(OWNER))!;
  const pass = `${passCookieName(store)}=${await mintPass(store, MEMBER, "all")}`;
  const claimName = cartMemberCookie(store);

  const open = async (ids: string[], cookie = pass) => {
    sessionReads = 0;
    const response = await readCart(new NextRequest(`https://marktmorgen.com/api/store/cart?handle=${HANDLE}&ids=${ids.join(",")}`, { headers: { cookie, "x-vercel-ip-country": "US" } }));
    return { cart: (await response.json()) as CartAnswer, setCookie: response.headers.get("set-cookie") ?? "" };
  };
  const pay = async (ids: string[], cookie = pass) => {
    sessionReads = 0;
    checkouts.length = 0;
    const form = withConsent(new URLSearchParams({ handle: HANDLE }));
    for (const id of ids) form.append("id", id);
    const response = await payCart(
      new NextRequest("https://marktmorgen.com/api/store/cart", {
        method: "POST",
        headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", "x-vercel-ip-country": "US", cookie },
        body: form.toString(),
      }),
    );
    const where = new URL(response.headers.get("location") ?? "https://x/");
    return { to: where.hostname === "checkout.stripe.com" ? "stripe" : `${where.search}${where.hash}`, sent: checkouts[0] };
  };
  const ids = [p.Planner, p.Guide, p.Notes];

  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active")] };
  let seen = await open(ids);
  is("a proved member: the member price on the lines a rule covers, the normal price on the rest", seen.cart.items.map((item) => item.cents), [2160, 960, 1000]);
  is("the total is what those lines come to", seen.cart.total, "$41.20");
  is("one proof for the whole cart: Stripe asked at most twice, not once per line", sessionReads <= MEMBER_PRICE_STRIPE_CALLS && sessionReads > 0, true);
  is("the browser keeps what the cart showed, HttpOnly, for this store", [seen.setCookie.includes(`${claimName}=${p.Planner}:20.${p.Guide}:20`), /HttpOnly/.test(seen.setCookie), /SameSite=Lax/.test(seen.setCookie)], [true, true, true]);
  const shown = `${pass}; ${claimName}=${p.Planner}:20.${p.Guide}:20`;

  seen = await open(ids, "");
  is("no pass and not signed in: the normal price, nothing asked of Stripe, nothing kept", [seen.cart.items.map((item) => item.cents), sessionReads, seen.setCookie], [[2700, 1200, 1000], 0, ""]);
  seen = await open(ids, shown.replace(pass, ""));
  is("a claim kept from before, with nobody proved now: shown the normal price and the claim cleared", [seen.cart.items.map((item) => item.cents), seen.setCookie.includes(`${claimName}=;`) && /Max-Age=0/.test(seen.setCookie)], [[2700, 1200, 1000], true]);
  seen = await open([p.Notes]);
  is("a cart with nothing a rule covers: nothing asked of Stripe", [seen.cart.items.map((item) => item.cents), sessionReads], [[1000], 0]);
  sessionsByEmail = { [MEMBER]: "fail" };
  seen = await open(ids);
  is("Stripe failing: unknown, so the normal price is shown", seen.cart.items.map((item) => item.cents), [2700, 1200, 1000]);
  sessionsByEmail = { [OWNER]: [joined(club.product.id, "active")] };
  seen = await open(ids, `${SESSION_COOKIE}=${await openSession(OWNER)}`);
  is("the creator signed in to their own store: never a member price", seen.cart.items.map((item) => item.cents), [2700, 1200, 1000]);

  part("Paying for it");
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active")] };
  let paid = await pay(ids, shown);
  is("what the cart showed is what is proved now: Stripe's page opens", paid.to, "stripe");
  is("each line at the price the cart showed", [0, 1, 2].map((i) => paid.sent.get(`line_items[${i}][price_data][unit_amount]`)), ["2160", "960", "1000"]);
  is("the member's own purchase: the proved address fixed, written on the order, no code box on top", [paid.sent.get("customer_email"), paid.sent.get("metadata[member]"), paid.sent.get("allow_promotion_codes")], [MEMBER, "20", null]);
  is("one proof for the whole payment too", sessionReads <= MEMBER_PRICE_STRIPE_CALLS && sessionReads > 0, true);

  paid = await pay(ids, pass);
  is("proved now but the cart did not show it (no claim kept): back to the cart, nothing opened", [paid.to, paid.sent], ["?cart=changed#cart", undefined]);
  paid = await pay(ids, `${pass}; ${claimName}=${p.Planner}:30.${p.Guide}:20`);
  is("a claim larger than what is proved: back to the cart, nothing opened", [paid.to, paid.sent], ["?cart=changed#cart", undefined]);
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "canceled")] };
  paid = await pay(ids, shown);
  is("a member no more since the cart was opened: back to the cart, nothing opened", [paid.to, paid.sent], ["?cart=changed#cart", undefined]);
  sessionsByEmail = { [MEMBER]: "fail" };
  paid = await pay(ids, shown);
  is("Stripe failing at payment: back to the cart, never charged a price it did not show", [paid.to, paid.sent], ["?cart=changed#cart", undefined]);
  paid = await pay(ids, pass);
  is("Stripe failing, and the cart showed the normal price: the normal price, no address fixed", [paid.to, [0, 1, 2].map((i) => paid.sent?.get(`line_items[${i}][price_data][unit_amount]`)), paid.sent?.get("customer_email") ?? null, paid.sent?.get("metadata[member]") ?? null], ["stripe", ["2700", "1200", "1000"], null, null]);
  paid = await pay(ids, "");
  is("nobody proved and nothing claimed: the normal price", [paid.to, paid.sent?.get("line_items[0][price_data][unit_amount]"), paid.sent?.get("metadata[member]") ?? null], ["stripe", "2700", null]);

  part("Never two discounts");
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active")] };
  await setStoreSale(OWNER, { name: "Spring", coupon: "spring40", percent: 40, starts: now - 60, ends: now + 3600, all: true, products: [] });
  seen = await open(ids);
  is("a larger sale wins on every line", seen.cart.items.map((item) => item.cents), [1620, 720, 600]);
  paid = await pay(ids, shown);
  is("and is charged, with no member price written and no address fixed", [paid.to, paid.sent?.get("line_items[0][price_data][unit_amount]"), paid.sent?.get("metadata[member]") ?? null, paid.sent?.get("customer_email") ?? null], ["stripe", "1620", null, null]);
  await setStoreSale(OWNER, { name: "Spring", coupon: "spring10", percent: 10, starts: now - 60, ends: now + 3600, all: true, products: [] });
  seen = await open(ids);
  is("a smaller sale: the member price where a rule covers, the sale elsewhere", seen.cart.items.map((item) => item.cents), [2160, 960, 900]);
  await setStoreSale(OWNER, { ...NO_SALE });
  await setCartDeal(OWNER, { on: true, min: 2, percent: 10 });
  seen = await open(ids);
  is("the store's deal for buying more stays on top, as it does on a sale", seen.cart.items.map((item) => item.cents), [2160, 960, 1000]);
  paid = await pay(ids, shown);
  is("charged as shown, with the deal taken off each line", [0, 1, 2].map((i) => paid.sent?.get(`line_items[${i}][price_data][unit_amount]`)), ["1944", "864", "900"]);
  await setCartDeal(OWNER, { on: false, min: 2, percent: 10 });

  part("A qualifying listing that cannot be read (rule 24, review L1 on #2999), in the cart");
  // A larger rule rests on the workbook; the member holds only the club. While the workbook's listing cannot be
  // read, that larger rule may hold, so the planner's member price is unknown: the normal price, shown and charged.
  const workbook = await addProduct(OWNER, "Workbook", "", "15", null);
  if (!workbook.ok) throw new Error("no workbook");
  await setProductLink(OWNER, workbook.product.id, "https://example.com/workbook");
  await setMemberPrices(OWNER, {
    on: true,
    rules: [
      { id: "club", percent: 20, by: [club.product.id], all: false, products: [p.Planner, p.Guide] },
      { id: "workbook", percent: 30, by: [workbook.product.id], all: false, products: [p.Planner] },
    ],
  });
  sessionsByEmail = { [MEMBER]: [joined(club.product.id, "active")] };
  const readable = (await storeForEmail(OWNER))!;
  const wb = workbook.product.id;
  const plannerListing = (await readListing(readable, p.Planner))!;
  const readableProof = await memberProofFor(readable, [plannerListing], jar(pass));
  is("control: the workbook readable, not held: the club's 20% on the planner", readableProof ? memberOffProved(readable.memberPrices, plannerListing, readableProof) : "no proof", 20);
  // The store record keeps the workbook out of its head, and the workbook's own record answers garbage.
  const realPipeline = redis.pipeline;
  redis.pipeline = async (commands) => {
    const replies = await realPipeline(commands);
    return replies.map((reply, i) => {
      const command = commands[i];
      if (command?.[0] !== "GET" || typeof reply !== "string") return reply;
      if (String(command[1]).endsWith(`:l:${wb}`)) return "{not json";
      if (!reply.includes('"catalog"')) return reply;
      try {
        const record = JSON.parse(reply) as { catalog?: { head?: { id: string }[] } };
        if (!Array.isArray(record.catalog?.head)) return reply;
        record.catalog.head = record.catalog.head.filter((listing) => listing.id !== wb);
        return JSON.stringify(record);
      } catch {
        return reply;
      }
    });
  };
  try {
    const unread = (await storeForEmail(OWNER))!;
    is("the stand-in: the workbook is left out of the listings read", (await readListings(unread, [wb, p.Planner])).map((l) => l.id), [p.Planner]);
    const proof = await memberProofFor(unread, [plannerListing], jar(pass));
    is("memberProofFor and memberOffProved: unknown, so 0 off (the normal price), never the club's 20%", proof ? memberOffProved(unread.memberPrices, plannerListing, proof) : 0, 0);
    seen = await open([p.Planner, p.Notes]);
    is("the open cart shows the normal price and keeps no member price", [seen.cart.items.map((item) => item.cents), seen.setCookie.includes(`${claimName}=${p.Planner}:`)], [[2700, 1000], false]);
    paid = await pay([p.Planner, p.Notes], `${pass}; ${claimName}=${p.Planner}:20`);
    is("a member price the cart showed before: back to the cart, nothing opened, never charged", [paid.to, paid.sent], ["?cart=changed#cart", undefined]);
    paid = await pay([p.Planner, p.Notes], pass);
    is("nothing shown: the normal price is charged, no member price written, no address fixed", [paid.to, paid.sent?.get("line_items[0][price_data][unit_amount]"), paid.sent?.get("metadata[member]") ?? null, paid.sent?.get("customer_email") ?? null], ["stripe", "2700", null, null]);
  } finally {
    redis.pipeline = realPipeline;
  }

  part("What it reads");
  const route = readFileSync(join(process.cwd(), "app/api/store/cart/route.ts"), "utf8");
  is("one proof per cart check, read once in GET and once in POST", route.split("memberProofFor(").length - 1, 2);
  const lib = readFileSync(join(process.cwd(), "lib/member-price.ts"), "utf8");
  is("the proof counts the plan's public requests once, before anything about the buyer is read", lib.split("takeBuyerRead(store, MEMBER_PRICE_REQUEST_UNITS)").length - 1 === 1 && lib.indexOf("takeBuyerRead(store, MEMBER_PRICE_REQUEST_UNITS)") < lib.indexOf("learnerFrom("), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
