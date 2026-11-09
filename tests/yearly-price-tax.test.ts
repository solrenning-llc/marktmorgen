/**
 * The yearly price a monthly member is moved onto says how tax is treated, as the tier's price (lib/tier-switch.ts,
 * tierPriceBody) and every checkout line (lib/tax.ts, applyTax) do. Found in the review of
 * claude5/switch-price-checked: lib/yearly-switch.ts (yearlyPriceBody) sent no tax_behavior, so Stripe used the
 * account's default, and in a store whose prices include tax, on an account whose default is "exclusive", the member
 * was charged the yearly amount with tax on top of the amount the page shows. The kept price is per tax treatment,
 * as a price's tax behavior never changes, and a reply with another treatment is refused.
 */
import { yearlyPrice, yearlyPriceBody } from "@/lib/yearly-switch";
import type { Listing, Store } from "@/lib/store";
import { priceEcho } from "./stripe-price-echo";
import { done, is, part } from "./check";

const posts: URLSearchParams[] = [];
let made = 0;
let change: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if ((init?.method ?? "GET") === "POST" && path === "/prices") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    posts.push(body);
    made++;
    return new Response(JSON.stringify({ ...priceEcho(`price_Yearly00000${made}`, body), ...change }));
  }
  return new Response("{}", { status: 500 });
}) as typeof fetch;

const shop = (enabled: boolean, included: boolean): Store =>
  ({ handle: "harbor", stripeAccountId: "acct_Harbor00001", currency: "usd", tax: { enabled, included } }) as unknown as Store;
const tier = { id: "y-tax", title: "Pro", priceCents: 2000, recurring: { interval: "month" } } as unknown as Listing;

async function outcome(make: () => Promise<string>): Promise<string> {
  try {
    return await make();
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_yearly_tax";
  part("The body says the store's tax treatment, as the tier's price does");
  is("tax included in the price: inclusive", yearlyPriceBody(shop(true, true), tier, 20000).get("tax_behavior"), "inclusive");
  is("tax on top: exclusive", yearlyPriceBody(shop(true, false), tier, 20000).get("tax_behavior"), "exclusive");
  is("tax off: none, as checkout", yearlyPriceBody(shop(false, false), tier, 20000).has("tax_behavior"), false);
  is("the amount is the yearly amount, unchanged", yearlyPriceBody(shop(true, true), tier, 20000).get("unit_amount"), "20000");

  part("One kept price per tax treatment");
  const off = await outcome(() => yearlyPrice(shop(false, false), tier, 20000));
  const inclusive = await outcome(() => yearlyPrice(shop(true, true), tier, 20000));
  const exclusive = await outcome(() => yearlyPrice(shop(true, false), tier, 20000));
  is("three prices, one for each treatment", new Set([off, inclusive, exclusive]).size, 3);
  is("each made with its own treatment", posts.map((body) => body.get("tax_behavior")), [null, "inclusive", "exclusive"]);
  const asked = posts.length;
  is("and each kept: asked again, Stripe is asked nothing", [await yearlyPrice(shop(true, true), tier, 20000), posts.length - asked], [inclusive, 0]);

  part("A reply with another tax treatment is refused");
  change = { tax_behavior: "exclusive" };
  const other = { ...tier, id: "y-tax-wrong" } as unknown as Listing;
  is("tax on top when it was sent inside the price", (await outcome(() => yearlyPrice(shop(true, true), other, 20000))).startsWith("refused"), true);
  change = {};
}
main().then(done);
