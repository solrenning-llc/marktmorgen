/**
 * Proof (CX-123 rules 24 and 30): lib/buyer-profile.ts reads a PayPal sale's
 * paid record with `readPaid(...).catch(() => null)`. readPaid itself already
 * answers null for a reply in another shape and for text that is not JSON,
 * and the catch turns a thrown read into null too. Null is taken as "no
 * PayPal payment": the sale is shown to the creator as "brought" ("No payment
 * here" on the studio's person page), its money is left out of "Spent with
 * you", and nothing on the page says the read failed (stripeError and partial
 * stay false). The creator is told something false about what a buyer paid.
 */
import { buyerProfile } from "@/lib/buyer-profile";
import { grantImported } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsppprofile01";
const ORDER = "5O190127TN3647101";
const paidKey = `nl:ppsell:paid:${ORDER}`;
const NOW = Math.floor(Date.now() / 1000);
const products = [{ id: "guide1", title: "Sourdough Guide", course: null, options: [] }];

const shop = (): Store =>
  ({
    sid: "sidppprof0001",
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    listId: null,
    callsId: null,
    currency: "usd",
    language: "en",
    stripeAccountId: null,
    pastBuyers: true,
    catalog: { id: null, head: [], items: products.map((p) => ({ id: p.id, kind: 0, options: [] })), inline: products },
  }) as unknown as Store;

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

type Seen = { kind: string; cents: number; note: string; paid: number; stripeError: boolean; partial: boolean } | string;

/** What the page would say about the PayPal sale, or that the read could not be done. */
async function seen(store: Store): Promise<Seen> {
  try {
    const profile = await buyerProfile(store, "buyer@example.com");
    const sale = profile.orders.find((o) => o.note === "paypal");
    return { kind: sale?.kind ?? "none", cents: sale?.cents ?? -1, note: sale?.note ?? "", paid: profile.paid, stripeError: profile.stripeError, partial: profile.partial };
  } catch (error) {
    return `refused: ${(error as Error).name}`;
  }
}

/** True when the page tells the creator "no payment here" for a paid PayPal sale, without saying the read failed. */
const falseStatement = (s: Seen) => typeof s !== "string" && s.kind === "brought" && s.paid === 0 && !s.stripeError && !s.partial;

async function main(): Promise<void> {
  redis.clear();
  const store = shop();
  const record = JSON.stringify({ store: STATS, order: ORDER, capture: "3C679366HH908701", email: "buyer@example.com", product: "guide1", cents: 4900, currency: "usd", at: NOW - 3600, handle: "harbor" });
  await grantImported(STATS, `paypal:${ORDER}`, [{ email: "buyer@example.com", productId: "guide1", items: null }], NOW - 3600, store.sid);
  await redis.pipeline([["SET", paidKey, record]]);

  part("Healthy control");
  const healthy = await seen(store);
  is("a PayPal sale, its money counted", healthy, { kind: "sale", cents: 4900, note: "paypal", paid: 4900, stripeError: false, partial: false });

  part("The paid record is not JSON (RED)");
  await redis.pipeline([["SET", paidKey, "{\"store\":\"" + STATS + "\", not json"]]);
  const malformed = await seen(store);
  console.log(`        page: ${JSON.stringify(malformed)}`);
  is("an unknown paid record is never shown as 'No payment here', $0, with no word of a failed read", falseStatement(malformed), false);
  await redis.pipeline([["SET", paidKey, record]]);

  const pipeline = redis.pipeline.bind(redis);
  part("A Redis reply in another shape (RED)");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await pipeline(commands);
    return commands.map((command, i) => (command[0] === "GET" && command[1] === paidKey ? { result: replies[i] } : replies[i]));
  }) as typeof redis.pipeline;
  const shape = await seen(store);
  console.log(`        page: ${JSON.stringify(shape)}`);
  is("an unknown reply is never shown as 'No payment here', $0, with no word of a failed read", falseStatement(shape), false);

  part("The read throws (RED: swallowed by .catch(() => null))");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "GET" && command[1] === paidKey)) throw new Error("Redis did not answer");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const thrown = await seen(store);
  console.log(`        page: ${JSON.stringify(thrown)}`);
  is("a thrown read is never shown as 'No payment here', $0, with no word of a failed read", falseStatement(thrown), false);
  is("the sale stays an unknown amount (no money counted) and the page warns", thrown, { kind: "brought", cents: 0, note: "paypal", paid: 0, stripeError: false, partial: true });

  part("The handed-over purchases cannot be read");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "HGETALL" && String(command[1]).startsWith(`nl:imp:buy:${STATS}:`))) throw new Error("Redis did not answer");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const lost = await buyerProfile(store, "buyer@example.com");
  is("a failed read is not 'nothing handed over': the page warns", { orders: lost.orders.length, paid: lost.paid, partial: lost.partial }, { orders: 0, paid: 0, partial: true });
  redis.pipeline = pipeline;

  part("Control after the failures");
  is("the healthy sale is read again, nothing flagged", await seen(store), { kind: "sale", cents: 4900, note: "paypal", paid: 4900, stripeError: false, partial: false });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
