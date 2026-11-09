/**
 * Without Redis (lib/pay-what-you-want.ts, pwywPriceId), found in the review of claude5/switch-price-checked: the
 * count of refusals was deleted after a success, so the next checkout went back to the first Idempotency-Key, which
 * Stripe had answered wrong and answers so again for a day; and the server's own count never ran out and had no
 * ceiling on its size. This Stripe keeps and replays its reply per key.
 */
import { PwywPriceHeld, REFUSED_MOST, pwywPriceId } from "@/lib/pay-what-you-want";
import type { Listing, Store } from "@/lib/store";
import { priceEcho } from "./stripe-price-echo";
import { done, is, part } from "./check";
const kept = new Map<string, Record<string, unknown>>();
const keys: string[] = [];
let wrong = true; let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const body = new URLSearchParams(String(init?.body ?? ""));
  const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
  keys.push(key);
  if (key && kept.has(key)) return new Response(JSON.stringify(kept.get(key)));
  made++;
  const reply = wrong ? { ...priceEcho(`price_Wrong000000${made}`, body), currency: "eur" } : priceEcho(`price_Right000000${made}`, body);
  if (key) kept.set(key, reply);
  return new Response(JSON.stringify(reply));
}) as typeof fetch;
const shop = { handle: "harbor", stripeAccountId: "acct_Harbor00001", currency: "usd", tax: { enabled: false, included: false } } as unknown as Store;
const listing = (id = "nr") => ({ id, title: "Guide", priceCents: 500, recurring: null }) as unknown as Listing;
const out = async (id?: string) => { try { return await pwywPriceId(shop, listing(id), { suggestedCents: 900 } as never); } catch (e) { return e instanceof PwywPriceHeld ? "held" : "refused"; } };
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_proof";
  part("P3: without Redis, after a refusal and a success");
  await out(); wrong = false;
  const r = [await out(), await out(), await out(), await out()];
  is("every later buyer gets the Price written", r.every((x) => x.startsWith("price_Right")), true);

  part("Without Redis, the same ceiling: past REFUSED_MOST refusals Stripe is not asked");
  wrong = true; made = 0; keys.length = 0;
  const held: string[] = [];
  for (let i = 0; i < REFUSED_MOST + 2; i++) held.push(await out("nr-held"));
  is("refused, then held", held, [...Array(REFUSED_MOST + 1).fill("refused"), "held"]);
  is("at most REFUSED_MOST + 1 Prices", made, REFUSED_MOST + 1);
  is("and Stripe asked no more than that", keys.length, REFUSED_MOST + 1);

  part("The server's count runs out 25 hours after the last refusal");
  wrong = false; keys.length = 0;
  shift = 24 * 3600 * 1000;
  is("still held after 24 hours", await out("nr-held"), "held");
  shift = 25 * 3600 * 1000 + 1000;
  kept.clear(); // Stripe forgets its reply to a key after 24 hours
  is("then asked again, under the first key, and the price written is used", [(await out("nr-held")).startsWith("price_Right"), keys.length, /-r\d/.test(keys[0] ?? "")], [true, 1, false]);

  part("The server's count holds at most 1,000 products, the oldest dropped first");
  wrong = true; keys.length = 0;
  for (let i = 0; i < 1_001; i++) await out(`nr-many-${i}`);
  keys.length = 0;
  await out("nr-many-0");
  is("the oldest product's count was dropped: asked again under its first key", /-r\d/.test(keys[0] ?? ""), false);
  keys.length = 0;
  await out("nr-many-1000");
  is("the newest is kept: asked under a new key", /-r1$/.test(keys[0] ?? ""), true);
}
main().then(done);
