/**
 * The count of refused choose-your-price replies (lib/pay-what-you-want.ts, pwywPriceId), found in the review of
 * claude5/switch-price-checked. P1: a Stripe that always answers wrong made a new Price on the creator's account for
 * every refused checkout, with no ceiling. P2: the count was written with SET (the count read, plus one), so a slow
 * checkout's refusal written last lowered it, and the next checkout asked again under a key Stripe had already
 * answered wrong. This Stripe keeps and replays its reply per Idempotency-Key, as Stripe does.
 */
import { PwywPriceHeld, REFUSED_MOST, pwywPriceId } from "@/lib/pay-what-you-want";
import { advance, store as redis } from "./redis-stub";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import type { Listing, Store } from "@/lib/store";
import { priceEcho } from "./stripe-price-echo";
import { done, is, part } from "./check";

const kept = new Map<string, Record<string, unknown>>();
let wrong = true;
let made = 0;
let calls = 0;
let holdCall = -1;
let release: () => void = () => {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if ((init?.method ?? "GET") === "POST" && path === "/prices") {
    const n = ++calls;
    const body = new URLSearchParams(String(init?.body ?? ""));
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    let reply: Record<string, unknown>;
    if (key && kept.has(key)) reply = kept.get(key)!;
    else {
      made++;
      reply = wrong ? { ...priceEcho(`price_Wrong000000${made}`, body), currency: "eur" } : priceEcho(`price_Right000000${made}`, body);
      if (key) kept.set(key, reply);
    }
    if (n === holdCall) await new Promise<void>((r) => (release = r));
    return new Response(JSON.stringify(reply));
  }
  return new Response("{}", { status: 500 });
}) as typeof fetch;

const shop = { handle: "harbor", stripeAccountId: "acct_Harbor00001", currency: "usd", tax: { enabled: false, included: false } } as unknown as Store;
const listing = (id: string) => ({ id, title: "Guide", priceCents: 500, recurring: null }) as unknown as Listing;
const out = async (id: string) => { try { return await pwywPriceId(shop, listing(id), { suggestedCents: 900 } as never); } catch (e) { return e instanceof PwywPriceHeld ? "held" : "refused"; } };

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_proof";
  part("P1: a reply Stripe always gets wrong (deterministic): Prices made on the creator's account");
  wrong = true; made = 0; calls = 0;
  const p1: string[] = [];
  for (let i = 0; i < REFUSED_MOST + 3; i++) p1.push(await out("p1"));
  // Rule 23 (claude5/switch-price-checked, review): was `made, 1` for five checkouts ("as before the delta": one key
  // for a day), which no fix can keep, since a new key after a refusal is what lets a right reply through
  // (tests/pwyw-refused-fresh-key.test.ts). The ceiling bounds the Prices instead: the first key's and one for each of
  // REFUSED_MOST new keys, then no call to Stripe at all until the count runs out.
  is("refused checkouts make at most REFUSED_MOST + 1 Prices", made, REFUSED_MOST + 1);
  is("past REFUSED_MOST refusals Stripe is not asked", calls, REFUSED_MOST + 1);
  is("and those checkouts fail as held, not as refused", p1, [...Array(REFUSED_MOST + 1).fill("refused"), "held", "held"]);
  const [ttl] = await redis.pipeline([["TTL", redis.keys().find((name) => name.endsWith(":refused")) ?? ""]]);
  is("the count is kept 25 hours after the last refusal", typeof ttl === "number" && ttl > 24 * 3600 && ttl <= 25 * 3600, true);

  part("P2: a slow checkout's refusal written late lowers the count");
  wrong = true; made = 0; calls = 0; holdCall = 1;
  const a = out("p2"); // A reads 0, asks under the first key, is slow
  while (calls < 1) await new Promise((r) => setTimeout(r, 1));
  await out("p2"); // B reads 0, the same key, refused: count 1
  await out("p2"); // C reads 1, refused: count 2
  release(); await a; // A's refusal lands last: count back to 1
  wrong = false; holdCall = -1;
  const d = await out("p2");
  is("once Stripe answers right, the next buyer is not refused", d.startsWith("price_Right"), true);

  part("The buyer of a held checkout is told plainly (app/api/store/checkout/route.ts, ?status=price-held)");
  is("in every store language, nothing charged and when to try again", LANGUAGE_CODES.filter((code) => !(wordsIn(code).notices["price-held"]?.title && wordsIn(code).notices["price-held"]?.body)), []);
  // Rule 23 (pre-review of claude5/switch-price-checked, H6 in tests/pwyw-held-truth.test.ts): was { title: "This
  // product can't be bought here today", body: "Nothing was charged. The payment company did not set up the price you
  // choose correctly. Try again tomorrow." }, false when the creator archived the Price again and again; the hold lasts
  // up to 25 hours from any moment (the count's own expiry), not until tomorrow.
  is("in plain US English", wordsIn("en").notices["price-held"], { title: "This product can't be bought right now", body: "Nothing was charged. Buying it is paused for up to 25 hours, because its price had to be set up again too many times. Please try again later." });

  part("P4: held until the count runs out, a day and an hour after the last refusal");
  wrong = false; made = 0; calls = 0;
  is("still held before the 25 hours", await out("p1"), "held");
  is("without asking Stripe", calls, 0);
  advance(25 * 3600 * 1000 + 1000);
  kept.clear(); // Stripe forgets its reply to a key after 24 hours
  is("then Stripe is asked again and the price written is used", (await out("p1")).startsWith("price_Right"), true);
}
main().then(done);
