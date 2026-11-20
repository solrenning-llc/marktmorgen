/**
 * A price made on the creator's Stripe account for a yearly switch (lib/yearly-switch.ts yearlyPrice), a tier switch
 * (lib/tier-switch.ts tierPrice) or a pay-what-you-want checkout (lib/pay-what-you-want.ts pwywPriceId) is kept in
 * a cache under the account's id (nl:yearly:price:, nl:tier:price:, nl:pwyw:), all families erased with the store
 * (lib/data-families.ts). Stripe can answer after the store's erasure began or ended: that late answer must never
 * write the cache back (Codex L-1446 = G-1341, G-1346 = L-1405 and G-1333, C5-20261119-1455-defeitos21). A live store
 * still keeps it, and so does a store kept from before ids (its sid is ""), fenced on its record.
 * Every service and identifier here is a local synthetic stand-in.
 */
import { claimHandle, ERASING_KEY, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";
import { yearlyPrice } from "@/lib/yearly-switch";
import { tierPrice } from "@/lib/tier-switch";
import { pwywPriceId } from "@/lib/pay-what-you-want";
import { setWhileStoreLive } from "@/lib/store-live-cache";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_price_cache_erased";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
const ACCOUNT = "acct_PriceCache01";

/** What the next price POST does while Stripe is working on it, before it answers. */
let duringPost: () => Promise<void> = async () => {};
let made = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== "/v1/prices" || init?.method !== "POST") {
    throw new Error(`unexpected synthetic operation ${init?.method} ${url}`);
  }
  await duringPost();
  made += 1;
  return Response.json({ id: `price_SyntheticCache${String(made).padStart(4, "0")}`, object: "price" });
}) as typeof fetch;

const product = {
  id: "p_cache_erased01",
  title: "Synthetic membership",
  priceCents: 2_000,
  recurring: { interval: "month" },
} as unknown as Listing;

const cached = (prefix: string) => redis.keys().filter((key) => key.startsWith(prefix));
const FAMILIES = ["nl:yearly:price:", "nl:tier:price:", "nl:pwyw:"] as const;

async function shop(email: string, handle: string): Promise<Store> {
  const claimed = await claimHandle(email, handle, "Price cache shop", "");
  if (!claimed.ok) throw new Error("synthetic store was not made");
  return { ...claimed.store, stripeAccountId: ACCOUNT };
}

/** The store's erasure, as closeStoreRecord leaves it: its id key and record gone, or only its erasing mark set. */
async function erase(store: Store, how: "gone" | "erasing"): Promise<void> {
  if (how === "erasing") {
    await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
    return;
  }
  await redis.pipeline([["DEL", storeIdCommand(store.sid)[1]], ["DEL", await ownerKey(storeRef(store))]]);
}

const makers: [string, (store: Store) => Promise<string>][] = [
  ["the yearly price", (store) => yearlyPrice(store, product, 20_000)],
  ["the tier price", (store) => tierPrice(store, product)],
  // As the server checkout calls it (lib/store-checkout.ts), with the store-live keeper.
  ["the pay-what-you-want price", (store) => pwywPriceId(store, product, { suggestedCents: 2_500 }, false, (key, id, seconds) => setWhileStoreLive(store, key, id, seconds))],
];

async function main(): Promise<void> {
  for (const how of ["gone", "erasing"] as const) {
    part(`a late Stripe answer after the store's erasure (${how === "gone" ? "its record gone" : "its erasure begun"}) keeps no price`);
    redis.clear();
    const store = await shop(`price-cache-${how}@example.com`, `price-cache-${how}`);
    for (const [label, make] of makers) {
      duringPost = () => erase(store, how);
      const id = await make(store).catch((error: unknown) => `threw: ${String(error)}`);
      is(`${label}: Stripe's id is still handed back to this one request`, /^price_SyntheticCache\d{4}$/.test(id), true);
    }
    duringPost = async () => {};
    for (const family of FAMILIES) is(`nothing kept under ${family}`, cached(family), []);
  }

  part("a live store keeps each price, and reuses it");
  redis.clear();
  const live = await shop("price-cache-live@example.com", "price-cache-live");
  made = 0;
  for (const [label, make] of makers) {
    const first = await make(live);
    is(`${label}: the second ask reuses the kept price`, await make(live), first);
  }
  is("three prices made on Stripe, not six", made, 3);
  for (const family of FAMILIES) is(`one price kept under ${family}`, cached(family).length, 1);

  part("a store from before ids (no sid) keeps its prices while its record is there");
  redis.clear();
  const old = await shop("price-cache-old@example.com", "price-cache-old");
  const legacy: Store = { ...old, sid: "", extra: false };
  made = 0;
  for (const [, make] of makers) await make(legacy);
  for (const family of FAMILIES) is(`one price kept under ${family}`, cached(family).length, 1);
  redis.clear();
  const oldGone = await shop("price-cache-old-gone@example.com", "price-cache-old-gone");
  const legacyGone: Store = { ...oldGone, sid: "", extra: false };
  for (const [, make] of makers) {
    duringPost = () => erase(legacyGone, "gone");
    await make(legacyGone);
  }
  duringPost = async () => {};
  for (const family of FAMILIES) is(`its record gone: nothing kept under ${family}`, cached(family), []);

  done();
}

void main();
