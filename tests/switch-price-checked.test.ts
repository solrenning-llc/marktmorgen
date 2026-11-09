/**
 * A price made on a creator's account is used, and kept for the next switch or checkout, only when Stripe's reply is
 * the price just written (rule 30, as lib/billing.ts ensurePrice and lib/assistant-billing.ts on #3107): its amount,
 * its currency, its frequency and the tax treatment sent. Found on main in the review of #3107: lib/tier-switch.ts
 * (tierPrice) and lib/yearly-switch.ts (yearlyPrice) used and kept for 400 days any reply with an id, and
 * lib/pay-what-you-want.ts (pwywPriceId) any reply with an id for a year, so a wrong or altered reply became the price
 * a member or a buyer is charged. A reply that is not the price written is never used, never kept, and fails where it
 * is seen; the next asks Stripe again. A price kept before this check is not read: it was never checked.
 */
import { tierPrice } from "@/lib/tier-switch";
import { yearlyPrice } from "@/lib/yearly-switch";
import { pwywMaximum, pwywPriceId } from "@/lib/pay-what-you-want";
import { redisPipeline } from "@/lib/redis";
import type { Listing, Store } from "@/lib/store";
import { priceEcho } from "./stripe-price-echo";
import { done, is, part } from "./check";

const ACCOUNT = "acct_Harbor00001";
let reply: (id: string, body: URLSearchParams) => Record<string, unknown> = priceEcho;
let nextId = "price_Made00000001";
const posts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (method === "POST" && path === "/prices") {
    const body = new URLSearchParams(init?.body ? String(init.body) : "");
    posts.push(body);
    return new Response(JSON.stringify(reply(nextId, body)));
  }
  return new Response(JSON.stringify({ error: { message: `unexpected ${method} ${path}` } }), { status: 500 });
}) as typeof fetch;

const shop = (tax: boolean): Store => ({ handle: "harbor", stripeAccountId: ACCOUNT, currency: "usd", tax: { enabled: tax, included: false } }) as unknown as Store;
const tier = (id: string): Listing => ({ id, title: "Pro", priceCents: 2000, recurring: { interval: "month" } }) as unknown as Listing;
const guide = (id: string): Listing => ({ id, title: "Guide", priceCents: 500, recurring: null }) as unknown as Listing;
const PWYW = { suggestedCents: 900 };

async function outcome(make: () => Promise<string>): Promise<string> {
  try {
    return await make();
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
}

/** One wrong reply: refused, nothing kept, and the next asks Stripe again and uses the price written. */
async function refusedThenAskedAgain(what: string, wrong: (id: string, body: URLSearchParams) => Record<string, unknown>, make: () => Promise<string>) {
  reply = wrong;
  nextId = "price_Wrong0000001";
  const first = await outcome(make);
  reply = priceEcho;
  nextId = "price_Right0000001";
  const before = posts.length;
  const second = await outcome(make);
  is(`${what}: refused, never used`, first.startsWith("refused"), true);
  is(`${what}: not kept, so the next asks Stripe again and gets the price written`, [second, posts.length - before], ["price_Right0000001", 1]);
}

const echoWith = (change: Record<string, unknown>) => (id: string, body: URLSearchParams) => ({ ...priceEcho(id, body), ...change });

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_switch_price_only";
  part("A tier's price (lib/tier-switch.ts, tierPrice)");
  reply = priceEcho;
  nextId = "price_Tier00000001";
  is("the price written is used", await outcome(() => tierPrice(shop(false), tier("t-good"))), "price_Tier00000001");
  const made = posts.length;
  is("and kept: the next switch asks Stripe nothing", [await tierPrice(shop(false), tier("t-good")), posts.length - made], ["price_Tier00000001", 0]);
  await refusedThenAskedAgain("another amount", echoWith({ unit_amount: 1 }), () => tierPrice(shop(false), tier("t-amount")));
  await refusedThenAskedAgain("another currency", echoWith({ currency: "eur" }), () => tierPrice(shop(false), tier("t-currency")));
  await refusedThenAskedAgain("every year, not every month", echoWith({ recurring: { interval: "year", interval_count: 1 } }), () => tierPrice(shop(false), tier("t-year")));
  await refusedThenAskedAgain("every three months", echoWith({ recurring: { interval: "month", interval_count: 3 } }), () => tierPrice(shop(false), tier("t-count")));
  await refusedThenAskedAgain("a reply with no frequency", echoWith({ recurring: null }), () => tierPrice(shop(false), tier("t-once")));
  await refusedThenAskedAgain("a reply with no count", echoWith({ recurring: { interval: "month" } }), () => tierPrice(shop(false), tier("t-nocount")));
  await refusedThenAskedAgain("tax inside the price when it was sent on top", echoWith({ tax_behavior: "inclusive" }), () => tierPrice(shop(true), tier("t-tax")));
  await refusedThenAskedAgain("another product's price", echoWith({ metadata: { product: "someone-else" } }), () => tierPrice(shop(false), tier("t-product")));
  await refusedThenAskedAgain("a bare id", (id) => ({ id }), () => tierPrice(shop(false), tier("t-bare")));
  // Kept by the code before this check: nobody read it against the price written.
  await redisPipeline([["SET", `nl:tier:price:${ACCOUNT}:t-old:2000:usd:month`, "price_Unchecked001", "EX", 400 * 86_400]]);
  nextId = "price_Checked00001";
  is("a price kept before the check is never used: a checked one is made", await outcome(() => tierPrice(shop(false), tier("t-old"))), "price_Checked00001");

  part("The yearly price (lib/yearly-switch.ts, yearlyPrice)");
  nextId = "price_Yearly000001";
  is("the price written is used", await outcome(() => yearlyPrice(shop(false), tier("y-good"), 20000)), "price_Yearly000001");
  const yearly = posts.length;
  is("and kept: the next move asks Stripe nothing", [await yearlyPrice(shop(false), tier("y-good"), 20000), posts.length - yearly], ["price_Yearly000001", 0]);
  await refusedThenAskedAgain("another amount", echoWith({ unit_amount: 2000 }), () => yearlyPrice(shop(false), tier("y-amount"), 20000));
  await refusedThenAskedAgain("another currency", echoWith({ currency: "gbp" }), () => yearlyPrice(shop(false), tier("y-currency"), 20000));
  await refusedThenAskedAgain("every month, not every year", echoWith({ recurring: { interval: "month", interval_count: 1 } }), () => yearlyPrice(shop(false), tier("y-month"), 20000));
  await refusedThenAskedAgain("every two years", echoWith({ recurring: { interval: "year", interval_count: 2 } }), () => yearlyPrice(shop(false), tier("y-count"), 20000));
  await refusedThenAskedAgain("another product's price", echoWith({ metadata: { product: "someone-else", every: "year" } }), () => yearlyPrice(shop(false), tier("y-product"), 20000));
  await refusedThenAskedAgain("a bare id", (id) => ({ id }), () => yearlyPrice(shop(false), tier("y-bare"), 20000));
  await redisPipeline([["SET", `nl:yearly:price:${ACCOUNT}:y-old:20000:usd`, "price_Unchecked002", "EX", 400 * 86_400]]);
  nextId = "price_Checked00002";
  is("a price kept before the check is never used: a checked one is made", await outcome(() => yearlyPrice(shop(false), tier("y-old"), 20000)), "price_Checked00002");

  part("A choose-your-price Price (lib/pay-what-you-want.ts, pwywPriceId)");
  nextId = "price_Pwyw00000001";
  is("the price written is used", await outcome(() => pwywPriceId(shop(false), guide("w-good"), PWYW)), "price_Pwyw00000001");
  const chosen = posts.length;
  is("and kept: the next checkout asks Stripe nothing", [await pwywPriceId(shop(false), guide("w-good"), PWYW), posts.length - chosen], ["price_Pwyw00000001", 0]);
  const custom = (change: Record<string, unknown>) => (id: string, body: URLSearchParams) => {
    const echo = priceEcho(id, body);
    return { ...echo, custom_unit_amount: { ...(echo.custom_unit_amount as Record<string, unknown>), ...change } };
  };
  await refusedThenAskedAgain("a lower floor than the creator's price", custom({ minimum: 1 }), () => pwywPriceId(shop(false), guide("w-floor"), PWYW));
  await refusedThenAskedAgain("another suggestion", custom({ preset: 100 }), () => pwywPriceId(shop(false), guide("w-preset"), PWYW));
  await refusedThenAskedAgain("another ceiling", custom({ maximum: 99_999_999 }), () => pwywPriceId(shop(false), guide("w-max"), PWYW));
  await refusedThenAskedAgain("no amount for the buyer to choose", echoWith({ custom_unit_amount: null, unit_amount: 500 }), () => pwywPriceId(shop(false), guide("w-fixed"), PWYW));
  await refusedThenAskedAgain("another currency", echoWith({ currency: "eur" }), () => pwywPriceId(shop(false), guide("w-currency"), PWYW));
  await refusedThenAskedAgain("charged again every month", echoWith({ recurring: { interval: "month", interval_count: 1 }, type: "recurring" }), () => pwywPriceId(shop(false), guide("w-recurring"), PWYW));
  await refusedThenAskedAgain("tax inside the price when it was sent on top", echoWith({ tax_behavior: "inclusive" }), () => pwywPriceId(shop(true), guide("w-tax"), PWYW));
  await refusedThenAskedAgain("another product's price", echoWith({ metadata: { product: "someone-else", store: "harbor" } }), () => pwywPriceId(shop(false), guide("w-product"), PWYW));
  await refusedThenAskedAgain("a bare id", (id) => ({ id }), () => pwywPriceId(shop(false), guide("w-bare"), PWYW));
  // The key the code kept before this check: the shape's fingerprint, as lib/pay-what-you-want.ts made it.
  const shape = { product: "w-old", title: "Guide", minimum: 500, preset: 900, maximum: Math.max(pwywMaximum("usd"), 900), tax: "" };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(shape)));
  const print = Array.from(new Uint8Array(digest)).slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await redisPipeline([["SET", `nl:pwyw:${ACCOUNT}:${print}`, "price_Unchecked003", "EX", 365 * 86_400]]);
  nextId = "price_Checked00003";
  is("a price kept before the check is never used: a checked one is made", await outcome(() => pwywPriceId(shop(false), guide("w-old"), PWYW)), "price_Checked00003");
}

main().then(done);
