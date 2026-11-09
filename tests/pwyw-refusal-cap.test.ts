/**
 * The count of refused choose-your-price replies (lib/pay-what-you-want.ts, pwywPriceId), found in the review of
 * claude5/switch-price-checked. P1: a Stripe that always answers wrong made a new Price on the creator's account for
 * every refused checkout, with no ceiling. P2: the count was written with SET (the count read, plus one), so a slow
 * checkout's refusal written last lowered it, and the next checkout asked again under a key Stripe had already
 * answered wrong. This Stripe keeps and replays its reply per Idempotency-Key, as Stripe does.
 */
import { pwywPriceId } from "@/lib/pay-what-you-want";
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
const out = async (id: string) => { try { return await pwywPriceId(shop, listing(id), { suggestedCents: 900 } as never); } catch { return "refused"; } };

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_proof";
  part("P1: a reply Stripe always gets wrong (deterministic): Prices made on the creator's account");
  wrong = true; made = 0;
  for (let i = 0; i < 5; i++) await out("p1");
  is("five refused checkouts make at most one Price (as before the delta)", made, 1);

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
}
main().then(done);
