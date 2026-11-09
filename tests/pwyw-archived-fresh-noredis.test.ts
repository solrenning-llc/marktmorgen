/**
 * Without Redis, the retry after Stripe refused a choose-your-price Price at checkout (lib/pay-what-you-want.ts,
 * pwywPriceId with the refused id; tests/pwyw-archived-fresh.test.ts has the same with Redis): it asked Stripe under
 * an Idempotency-Key ending in Date.now(), so every checkout on that path made a new Price, outside the server's own
 * count of refusals and its ceiling. This Stripe keeps and replays its reply per Idempotency-Key.
 */
import { PwywPriceHeld, REFUSED_MOST, pwywPriceId } from "@/lib/pay-what-you-want";
import type { Listing, Store } from "@/lib/store";
import { priceEcho } from "./stripe-price-echo";
import { done, is, part } from "./check";

const kept = new Map<string, Record<string, unknown>>();
const keys: string[] = [];
let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const body = new URLSearchParams(String(init?.body ?? ""));
  const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
  keys.push(key);
  if (key && kept.has(key)) return new Response(JSON.stringify(kept.get(key)));
  made++;
  const reply = priceEcho(`price_Right${String(made).padStart(8, "0")}`, body);
  if (key) kept.set(key, reply);
  return new Response(JSON.stringify(reply));
}) as typeof fetch;
const shop = { handle: "harbor", stripeAccountId: "acct_Harbor00001", currency: "usd", tax: { enabled: false, included: false } } as unknown as Store;
const listing = (id: string) => ({ id, title: "Guide", priceCents: 500, recurring: null }) as unknown as Listing;
const ask = async (id: string, archived?: string) => {
  try {
    return await pwywPriceId(shop, listing(id), { suggestedCents: 900 }, archived);
  } catch (e) {
    return e instanceof PwywPriceHeld ? "held" : "refused";
  }
};
const later = () => new Promise((r) => setTimeout(r, 3));

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_proof";
  part("N1: without Redis, checkouts that each meet the archived Price make one new Price between them");
  const archived = await ask("n1");
  const retried: string[] = [];
  for (let i = 0; i < 5; i++) {
    retried.push(await ask("n1", archived));
    await later();
  }
  is("every retry gets the same new Price", new Set(retried).size === 1 && retried[0] !== archived && retried[0].startsWith("price_Right"), true);
  is("one new Price, not one per checkout", made, 2);
  is("and the next checkout, with nothing kept on this server, is answered that new Price, not the archived one", await ask("n1"), retried[0]);
  is("still two Prices", made, 2);

  part("N2: without Redis, the retries go through the server's count and its ceiling");
  made = 0; keys.length = 0;
  const outcomes: string[] = [];
  let current = await ask("n2");
  for (let i = 0; i < REFUSED_MOST + 3; i++) {
    const next = await ask("n2", current);
    outcomes.push(next.startsWith("price_") ? "made" : next);
    if (next.startsWith("price_")) current = next;
    await later();
  }
  is("at most REFUSED_MOST + 1 Prices", made, REFUSED_MOST + 1);
  is("then held, without asking Stripe", [outcomes, keys.length], [[...Array(REFUSED_MOST).fill("made"), "held", "held", "held"], REFUSED_MOST + 1]);
  is("no Idempotency-Key is made of the clock", keys.every((key) => /^pwyw-[0-9a-f]{32}(-r\d+)?$/.test(key)), true);
}
main().then(done);
