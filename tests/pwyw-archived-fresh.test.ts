/**
 * The retry after Stripe refused a kept choose-your-price Price at checkout (the creator archived it in their
 * dashboard; lib/store-checkout.ts asks pwywPriceId once more with the refused id), found in the review of
 * claude5/switch-price-checked: that retry asked Stripe under an Idempotency-Key ending in Date.now(), so every
 * checkout on that path made a new Price on the creator's account, buyers at the same moment each made their own,
 * and none of them went through the count of refusals or its daily ceiling (REFUSED_MOST). This Stripe keeps and
 * replays its reply per Idempotency-Key, as Stripe does.
 */
import { PwywPriceHeld, REFUSED_MOST, pwywPriceId } from "@/lib/pay-what-you-want";
import type { Listing, Store } from "@/lib/store";
import { priceEcho } from "./stripe-price-echo";
import { done, is, part } from "./check";

const kept = new Map<string, Record<string, unknown>>();
const keys: string[] = [];
let wrong = false;
let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if ((init?.method ?? "GET") === "POST" && path === "/prices") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    keys.push(key);
    if (key && kept.has(key)) return new Response(JSON.stringify(kept.get(key)));
    made++;
    const id = `price_${wrong ? "Wrong" : "Right"}${String(made).padStart(8, "0")}`;
    const reply = wrong ? { ...priceEcho(id, body), currency: "eur" } : priceEcho(id, body);
    if (key) kept.set(key, reply);
    return new Response(JSON.stringify(reply));
  }
  return new Response("{}", { status: 500 });
}) as typeof fetch;

const shop = { handle: "harbor", stripeAccountId: "acct_Harbor00001", currency: "usd", tax: { enabled: false, included: false } } as unknown as Store;
const listing = (id: string) => ({ id, title: "Guide", priceCents: 500, recurring: null }) as unknown as Listing;
const PWYW = { suggestedCents: 900 };
/** A checkout's ask: the kept Price, or, with `archived`, the one retry after Stripe refused that id at checkout. */
const ask = async (id: string, archived?: string) => {
  try {
    return await pwywPriceId(shop, listing(id), PWYW, archived);
  } catch (e) {
    return e instanceof PwywPriceHeld ? "held" : "refused";
  }
};
const later = () => new Promise((r) => setTimeout(r, 3));

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_proof";

  part("F1: checkouts that each meet the archived Price, one after another, make one new Price between them");
  wrong = false; made = 0; keys.length = 0;
  const archived = await ask("f1");
  is("the first Price is made and kept", [archived.startsWith("price_Right"), made], [true, 1]);
  const retried: string[] = [];
  for (let i = 0; i < 5; i++) {
    retried.push(await ask("f1", archived));
    await later();
  }
  is("every retry gets the same new Price", new Set(retried).size === 1 && retried[0] !== archived && retried[0].startsWith("price_Right"), true);
  is("one new Price made on the creator's account, not one per checkout", made, 2);
  is("under one Idempotency-Key for the retries", new Set(keys.slice(1)).size, 1);
  is("and the key is not the first key's", keys[1] !== keys[0], true);
  is("and the new Price is the one kept: the next checkout asks Stripe nothing", [await ask("f1"), keys.length], [retried[0], 6]);

  part("F2: buyers at the same moment meeting the archived Price share one key: one Price");
  made = 0; keys.length = 0;
  const first = await ask("f2");
  const both = await Promise.all(Array.from({ length: 4 }, () => ask("f2", first)));
  is("all get the same new Price", new Set(both).size === 1 && both[0] !== first && both[0].startsWith("price_Right"), true);
  is("one new Price made", made, 2);

  part("F3: a Stripe that refuses every kept Price at checkout: the retries go through the same count and ceiling");
  made = 0; keys.length = 0;
  const outcomes: string[] = [];
  let current = await ask("f3");
  for (let i = 0; i < REFUSED_MOST + 3; i++) {
    const next = await ask("f3", current);
    outcomes.push(next.startsWith("price_") ? "made" : next);
    if (next.startsWith("price_")) current = next;
    await later();
  }
  is("at most REFUSED_MOST + 1 Prices a day for the product, the first one's and one per counted retry", made, REFUSED_MOST + 1);
  is("then the retry fails as held, without asking Stripe", outcomes, [...Array(REFUSED_MOST).fill("made"), "held", "held", "held"]);
  is("Stripe asked no more than that", keys.length, REFUSED_MOST + 1);
  is("and a checkout that does not need a retry still gets the Price kept", await ask("f3"), current);

  part("F4: a retry answered wrong is not answered again to the next retry");
  made = 0; keys.length = 0;
  wrong = false;
  const before = await ask("f4");
  wrong = true;
  is("the retry answered wrong is refused", await ask("f4", before), "refused");
  wrong = false;
  await later();
  const again = await ask("f4", before);
  is("the next retry asks under a new key and gets the price written", [again.startsWith("price_Right"), new Set(keys).size], [true, 3]);

  part("F5: no Idempotency-Key is made of the clock");
  is("every key sent is made of the product's shape and the count", keys.every((key) => /^pwyw-[0-9a-f]{32}(-r\d+)?$/.test(key)), true);
}
main().then(done);
