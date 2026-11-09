/**
 * After a choose-your-price Price is refused (lib/pay-what-you-want.ts, isPwywPrice), the next checkout asks Stripe
 * under a new Idempotency-Key. Stripe keeps the reply to a key for 24 hours and answers it again to the same key, so
 * under the same key the refused reply came back to every buyer of that product for a day (found in the review of
 * claude5/switch-price-checked). Buyers pressing buy at the same moment still share one key, so they make one Price.
 * This Stripe keeps and replays its reply per key, as Stripe does.
 */
import { pwywPriceId } from "@/lib/pay-what-you-want";
import type { Listing, Store } from "@/lib/store";
import { priceEcho } from "./stripe-price-echo";
import { done, is, part } from "./check";

const kept = new Map<string, Record<string, unknown>>();
const keys: string[] = [];
let wrong = true;
let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if ((init?.method ?? "GET") === "POST" && path === "/prices") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    keys.push(key);
    if (key && kept.has(key)) return new Response(JSON.stringify(kept.get(key)));
    made++;
    const reply = wrong ? { ...priceEcho(`price_Wrong000000${made}`, body), currency: "eur" } : priceEcho(`price_Right000000${made}`, body);
    if (key) kept.set(key, reply);
    return new Response(JSON.stringify(reply));
  }
  return new Response("{}", { status: 500 });
}) as typeof fetch;

const shop = { handle: "harbor", stripeAccountId: "acct_Harbor00001", currency: "usd", tax: { enabled: false, included: false } } as unknown as Store;
const listing = (id: string) => ({ id, title: "Guide", priceCents: 500, recurring: null }) as unknown as Listing;
const out = async (id: string) => {
  try {
    return await pwywPriceId(shop, listing(id), { suggestedCents: 900 } as never);
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
};

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_proof";
  part("A refused reply is not answered again to the next checkout");
  wrong = true;
  const first = await out("w-idem");
  wrong = false; // Stripe would now make the right Price
  const second = await out("w-idem");
  is("the first is refused", first.startsWith("refused"), true);
  is("the next checkout asks Stripe again under a new key and gets the price written", second, "price_Right0000002");
  is("two different keys were sent", new Set(keys).size, 2);
  is("and once right, the Price is kept: the next checkout asks Stripe nothing", [await out("w-idem"), keys.length], ["price_Right0000002", 2]);

  part("Buyers pressing buy at the same moment still share one key: one Price");
  keys.length = 0;
  const before = made;
  const both = await Promise.all([out("w-same"), out("w-same")]);
  is("both get the same Price", both[0] === both[1] && both[0].startsWith("price_Right"), true);
  is("under one key", new Set(keys).size, 1);
  is("one Price made", made - before, 1);

  part("And after a refusal, the next ones at the same moment share the new key");
  keys.length = 0;
  wrong = true;
  const refusedAgain = await Promise.all([out("w-race"), out("w-race")]);
  is("both refused", refusedAgain.every((r) => r.startsWith("refused")), true);
  wrong = false;
  const after = made;
  keys.length = 0;
  const retried = await Promise.all([out("w-race"), out("w-race")]);
  is("both get the price written", retried[0] === retried[1] && retried[0].startsWith("price_Right"), true);
  is("under one new key", new Set(keys).size, 1);
  is("one Price made", made - after, 1);
}
main().then(done);
