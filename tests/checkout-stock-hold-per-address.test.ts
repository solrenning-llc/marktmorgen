/**
 * A limited product's checkout holds one unit for the checkout's whole life (HOLD_SECONDS, about half an hour; lib/stock.ts).
 * The only bound on presses was the shared "checkout" limit, 20 a connection and store in ten minutes, so one connection
 * that never pays could hold about 60 units at once, a whole small drop, and real buyers saw "Sold out" until the holds
 * ran out. Holding is now bounded on its own: a few holds a connection and store within one hold's time, charged before
 * the unit is held, and a count that cannot be read holds nothing (rule 24). Both doors that hold units are checked: one
 * product (app/api/store/checkout) and the cart (app/api/store/cart). Another connection still buys, and a product with no
 * limit is never counted. The creator's Stripe account is a stand-in for `fetch`; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { stockLeft } from "@/lib/stock";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { POST as cartRoute } from "@/app/api/store/cart/route";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_checkout_stock_hold_only";

let made = 0;
const sessions = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    made += 1;
    const id = `cs_test_${String(made).padStart(24, "h")}`;
    const session = { id, status: "open", payment_status: "unpaid", url: `https://checkout.stripe.com/c/pay/${id}`, created: Math.floor(Date.now() / 1000) };
    sessions.set(id, session);
    return answer(session);
  }
  const expiring = /^\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
  if (expiring && method === "POST") {
    const found = sessions.get(decodeURIComponent(expiring[1]));
    if (!found) return answer({ error: { message: "No such checkout" } }, 404);
    found.status = "expired";
    return answer(found);
  }
  if (path.startsWith("/checkout/sessions/") && method === "GET") {
    const found = sessions.get(decodeURIComponent(path.slice("/checkout/sessions/".length)));
    return found ? answer(found) : answer({ error: { message: "No such checkout" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The counter's INCR on the stock-hold scope answered `null` (a reply of another shape) while set. */
let unknownHoldCount = false;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await realPipeline(commands);
  if (!unknownHoldCount) return replies;
  return replies.map((reply, i) => (commands[i][0] === "INCR" && String(commands[i][1]).startsWith("nl:rl:stock-hold:") ? null : reply));
}) as typeof redis.pipeline;

const STOCK = 40;

async function main(): Promise<void> {
  redis.clear();
  const owner = "stockhold@example.com";
  await claimHandle(owner, "stockholdshop", "Stock Hold Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestStockHold1", true);
  await setSubscription(owner, { customerId: "cus_StockHold0001", subscriptionId: "sub_StockHold0001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const add = async (name: string, stock: number | null) => {
    const product = await addProduct(owner, name, "A synthetic print.", "40", null);
    if (!product.ok) throw new Error("product fixture");
    if (stock !== null) {
      const limited = await setProductExtras(owner, product.product.id, { stock });
      if (!limited.ok) throw new Error(`stock fixture: ${limited.reason}`);
    }
    await setProductLink(owner, product.product.id, "https://example.com/print");
    return product.product.id;
  };
  const dropId = await add("Signed print", STOCK);
  const cartDropId = await add("Second signed print", STOCK);
  const openId = await add("Open edition", null);
  const left = async (id: string) => {
    const now = (await storeForEmail(owner))!;
    return stockLeft(now, (await readListing(now, id))!);
  };

  const headers = (ip: string) => ({ host: "marktmorgen.com", origin: "https://marktmorgen.com", "x-forwarded-for": ip });
  /** The hold cookie a press set, as the browser would send it back. */
  const holdOf = (response: Response) => /nl_stock_hold=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const pressWith = async (id: string, ip: string, { consent = true, cookie = "" } = {}) => {
    const form = new FormData();
    form.set("handle", "stockholdshop");
    form.set("product", id);
    const before = made;
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", {
      method: "POST",
      body: consent ? withConsent(form) : form,
      headers: { ...headers(ip), ...(cookie ? { cookie: `nl_stock_hold=${cookie}` } : {}) },
    }));
    return { where: response.headers.get("location"), opened: made - before, hold: holdOf(response) };
  };
  const press = async (id: string, ip: string): Promise<[string | null, number]> => {
    const { where, opened } = await pressWith(id, ip);
    return [where, opened];
  };
  const pressCart = async (id: string, ip: string, consent = true): Promise<number> => {
    const form = new FormData();
    form.set("handle", "stockholdshop");
    form.set("id", id);
    const before = made;
    await cartRoute(new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", body: consent ? withConsent(form) : form, headers: headers(ip) }));
    return made - before;
  };

  part("One connection that never pays cannot hold a limited drop");
  for (let i = 0; i < 20; i += 1) await press(dropId, "198.51.100.7");
  const heldByOne = STOCK - ((await left(dropId)) ?? 0);
  is("a connection's presses hold at most ten units at once", heldByOne <= 10, true);
  is("and at least one, a real buyer's checkout opens", heldByOne >= 1, true);

  part("Another connection still buys");
  const [, other] = await press(dropId, "203.0.113.9");
  is("a second buyer's checkout opens", other, 1);

  part("The cart is bounded the same way");
  for (let i = 0; i < 20; i += 1) await pressCart(cartDropId, "198.51.100.8");
  const heldByCart = STOCK - ((await left(cartDropId)) ?? 0);
  is("a connection's carts hold at most ten units at once", heldByCart <= 10, true);

  part("A product with no limit is never counted");
  let opened = 0;
  for (let i = 0; i < 10; i += 1) opened += (await press(openId, "198.51.100.10"))[1];
  is("ten presses for an open edition open ten checkouts", opened, 10);

  part("Presses that hold nothing are never counted (review of #4409)");
  const consentDrop = await add("Third signed print", STOCK);
  for (let i = 0; i < 4; i += 1) {
    const refused = await pressWith(consentDrop, "198.51.100.20", { consent: false });
    is(`press ${i + 1} without the box opens nothing`, refused.opened, 0);
  }
  const withBox = await pressWith(consentDrop, "198.51.100.20");
  is("the fifth press, with the box, opens the checkout", withBox.opened, 1);
  is("and is not sent back as too fast", (withBox.where ?? "").includes("status=slow"), false);

  const cartConsentDrop = await add("Fifth signed print", STOCK);
  let cartRefused = 0;
  for (let i = 0; i < 4; i += 1) cartRefused += await pressCart(cartConsentDrop, "198.51.100.22", false);
  is("four carts without the box open nothing", cartRefused, 0);
  is("and hold nothing", STOCK - ((await left(cartConsentDrop)) ?? 0), 0);
  is("the fifth cart, with the box, opens the checkout", await pressCart(cartConsentDrop, "198.51.100.22"), 1);

  part("Going back from Stripe and pressing again hands back the unit and is not counted");
  const backDrop = await add("Fourth signed print", STOCK);
  let cookie = "";
  let reopened = 0;
  for (let i = 0; i < 8; i += 1) {
    const again = await pressWith(backDrop, "198.51.100.21", { cookie });
    reopened += again.opened;
    if (again.hold) cookie = again.hold;
  }
  is("eight presses, each handing back the last, open eight checkouts", reopened, 8);
  is("and hold one unit, the last", STOCK - ((await left(backDrop)) ?? 0), 1);

  part("Presses on a sold-out product are never counted (second review of #4409)");
  const lastOne = await add("Last signed print", 1);
  is("another buyer holds the only unit", (await pressWith(lastOne, "203.0.113.30")).opened, 1);
  for (let i = 0; i < 12; i += 1) {
    const sold = await pressWith(lastOne, "198.51.100.23");
    is(`press ${i + 1} on the sold-out product opens nothing`, sold.opened, 0);
  }
  // The unit comes back: the other buyer's checkout ran out and was let go.
  const statsId = (await storeForEmail(owner))!.statsId;
  await redis.pipeline([["DEL", `nl:stock:${statsId}:${lastOne}`]]);
  const back = await pressWith(lastOne, "198.51.100.23");
  is("once the unit is back, the waiting buyer's press opens it", back.opened, 1);
  is("and is not sent back as too fast", (back.where ?? "").includes("status=slow"), false);

  part("Several buyers behind one shared address each buy (second review of #4409)");
  const officeDrop = await add("Sixth signed print", STOCK);
  let office = 0;
  for (let person = 0; person < 5; person += 1) office += (await pressWith(officeDrop, "198.51.100.40")).opened;
  is("five people on one address, one press each, open five checkouts", office, 5);

  part("A hold count that cannot be read holds nothing (rule 24)");
  const before = await left(dropId);
  unknownHoldCount = true;
  const [where, unknownOpened] = await press(dropId, "192.0.2.44");
  const unknownCart = await pressCart(cartDropId, "192.0.2.45");
  unknownHoldCount = false;
  is("no checkout opens for the product", unknownOpened, 0);
  is("nor for the cart", unknownCart, 0);
  is("the buyer is sent back with the plain error", (where ?? "").includes("status=error"), true);
  is("no unit is held", await left(dropId), before);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
