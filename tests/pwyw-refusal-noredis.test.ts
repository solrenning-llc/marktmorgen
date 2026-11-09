/**
 * Without Redis (lib/pay-what-you-want.ts, pwywPriceId), found in the review of claude5/switch-price-checked: the
 * count of refusals was deleted after a success, so the next checkout went back to the first Idempotency-Key, which
 * Stripe had answered wrong and answers so again for a day. This Stripe keeps and replays its reply per key.
 */
import { pwywPriceId } from "@/lib/pay-what-you-want";
import type { Listing, Store } from "@/lib/store";
import { priceEcho } from "./stripe-price-echo";
import { done, is, part } from "./check";
const kept = new Map<string, Record<string, unknown>>();
let wrong = true; let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const body = new URLSearchParams(String(init?.body ?? ""));
  const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
  if (key && kept.has(key)) return new Response(JSON.stringify(kept.get(key)));
  made++;
  const reply = wrong ? { ...priceEcho(`price_Wrong000000${made}`, body), currency: "eur" } : priceEcho(`price_Right000000${made}`, body);
  if (key) kept.set(key, reply);
  return new Response(JSON.stringify(reply));
}) as typeof fetch;
const shop = { handle: "harbor", stripeAccountId: "acct_Harbor00001", currency: "usd", tax: { enabled: false, included: false } } as unknown as Store;
const listing = { id: "nr", title: "Guide", priceCents: 500, recurring: null } as unknown as Listing;
const out = async () => { try { return await pwywPriceId(shop, listing, { suggestedCents: 900 } as never); } catch { return "refused"; } };
async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_proof";
  part("P3: without Redis, after a refusal and a success");
  await out(); wrong = false;
  const r = [await out(), await out(), await out(), await out()];
  is("every later buyer gets the Price written", r.every((x) => x.startsWith("price_Right")), true);
}
main().then(done);
