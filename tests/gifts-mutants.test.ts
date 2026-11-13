/**
 * Mutation testing of lib/gifts.ts (Claude 7, 13/11/2026): each case kills a
 * mutant that survived the tests importing the module. A gift is started only
 * for a store with records, a product that can be given and an address that
 * fits; it is handed over only for its own store and product, with the
 * buyer's receipt saying what this checkout charged; and a refund takes it
 * back only when the payment was given back in full, only once, only for a
 * gift of this store, with every product of its bundle.
 *
 * Synthetic only: Stripe and Resend are a stand-in fetch, Redis is
 * tests/redis-stub.ts.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, readGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { importedKey } from "@/lib/imported-purchases";
import { MAX_EMAIL_LENGTH } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[]; subject: string; text: string };
const emails: Sent[] = [];
let refunds: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/refunds") return answer({ object: "list", data: refunds, has_more: false });
  if (path === "/events") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

let sessions = 0;
async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gifts_mutants_stand_in";
  process.env.RESEND_API_KEY = "re_test_gifts_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Sourdough Course", "", "49", null);
  const other = await addProduct("owner@example.com", "Rye Course", "", "29", null);
  if (!made.ok || !other.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/course");
  await setProductLink("owner@example.com", other.product.id, "https://example.com/rye");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  const rye = (await readListing(store, other.product.id))!;

  part("Starting a gift");
  const input = (to: string) => ({ to, from: "Ana", message: "" });
  const noRecords = await startGift({ ...store, statsId: "" } as Store, product, input("pal@example.com"));
  is("no store records: unavailable", noRecords.ok ? "started" : noRecords.reason, "unavailable");
  const free = await startGift(store, { ...product, priceCents: 0 } as Listing, input("pal@example.com"));
  is("something free cannot be given", free.ok ? "started" : free.reason, "product");
  const longest = `${"a".repeat(MAX_EMAIL_LENGTH - "@example.com".length)}@example.com`;
  is("an address of the longest length fits", (await startGift(store, product, input(longest))).ok, true);
  const over = await startGift(store, product, input(`a${longest}`));
  is("one character more does not", over.ok ? "started" : over.reason, "email");

  const give = async (p: Listing, session: Record<string, unknown> = {}, onStore: Store = store) => {
    const started = await startGift(store, product, { to: "friend@example.com", from: "Ana", message: "" });
    if (!started.ok) throw new Error("no gift");
    emails.length = 0;
    sessions += 1;
    const outcome = await deliverGift({
      store: onStore,
      session: { id: `cs_test_${String(sessions).padStart(24, "m")}`, created: 1_900_000_000, amount_total: 4900, currency: "usd", payment_intent: `pi_GiftMut${sessions}`, metadata: { store: "harbor", product: product.id, gift: started.gift.id }, customer_details: { email: "buyer@example.com" }, ...session },
      product: p,
      base: "https://marktmorgen.com/@harbor",
      from: '"Harbor Kitchen" <hello@marktmorgen.com>',
      recordStart: async () => {},
      ordersLink: async () => "https://marktmorgen.com/@harbor/orders",
    });
    return { outcome, id: started.gift.id, receipt: emails.find((e) => e.to[0] === "buyer@example.com")?.text ?? "" };
  };

  part("Handing it over");
  is("for another product: not this checkout's", (await give(rye)).outcome, "skip");
  is("for another store: not this checkout's", (await give(product, {}, { ...store, statsId: "otherstats1" } as Store)).outcome, "skip");
  const handed = await give(product, { amount_total: 3900 });
  is("handed over", handed.outcome, "given");
  is("the receipt says what this checkout charged", handed.receipt.includes("$39"), true);
  is("the order kept is this checkout's", (await readGift(handed.id))?.session, `cs_test_${String(sessions).padStart(24, "m")}`);
  is("in the currency it was charged in", (await give(product, { amount_total: 3900, currency: "eur" })).receipt.includes("€39"), true);
  is("no currency said: the store's", (await give(product, { amount_total: 3900, currency: "" })).receipt.includes("$39"), true);

  part("A refund takes it back");
  const dropped: string[] = [];
  const revoke = () => revokeRefundedGifts(store, Date.now() + 10_000, async (email, id) => void dropped.push(`${email}|${id}`));
  const refund = (pi: string, over: Record<string, unknown> = {}) => ({ id: `re_${pi.slice(3)}`, created: Math.floor(Date.now() / 1000), status: "succeeded", payment_intent: pi, charge: { refunded: true }, ...over });

  const partly = await give(product);
  refunds = [refund(`pi_GiftMut${sessions}`, { charge: { refunded: false } })];
  is("not a refund of part of it", [await revoke(), (await readGift(partly.id))?.revoked], [0, undefined]);

  const whole = await give(product);
  const sid = store.statsId as string;
  await redis.pipeline([["HSET", importedKey(sid, "friend@example.com"), product.id, JSON.stringify({ items: ["prod_a", 7, "prod_b"] })]]);
  dropped.length = 0;
  refunds = [refund(`pi_GiftMut${sessions}`)];
  is("a full refund: taken back", await revoke(), 1);
  is("with every product of its bundle", dropped, [`friend@example.com|${product.id}`, "friend@example.com|prod_a", "friend@example.com|prod_b"]);
  is("and marked as taken back", typeof (await readGift(whole.id))?.revoked, "number");

  dropped.length = 0;
  refunds = [refund(`pi_GiftMut${sessions}`, { id: "re_GiftMutAgain" })];
  is("another refund of the same payment does not take it back twice", [await revoke(), dropped], [0, []]);

  const elsewhere = await give(product);
  const kept = JSON.parse(String((await redis.pipeline([["GET", `nl:gift:${elsewhere.id}`]]))[0])) as Record<string, unknown>;
  await redis.pipeline([["SET", `nl:gift:${elsewhere.id}`, JSON.stringify({ ...kept, s: "otherstats1" })]]);
  dropped.length = 0;
  refunds = [refund(`pi_GiftMut${sessions}`)];
  is("a gift kept for another store is not this store's to take back", [await revoke(), dropped], [0, []]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
