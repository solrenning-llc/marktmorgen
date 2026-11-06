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
  await grantImported(STATS, `paypal:${ORDER}`, [{ email: "buyer@example.com", productId: "guide1", items: null }], NOW - 3600, store.sid);
  part("Paid record of this store, but in another shape (no cents/at/currency)");
  await redis.pipeline([["SET", paidKey, JSON.stringify({ store: STATS, order: ORDER })]]);
  const p = await buyerProfile(store, "buyer@example.com");
  const sale = p.orders.find((o) => o.note === "paypal");
  console.log("        ", JSON.stringify({ kind: sale?.kind, cents: sale?.cents, paid: p.paid, partial: p.partial, purchases: p.purchases }));
  is("a malformed paid record is never counted as a sale (paid stays a number, partial set)", { finite: Number.isFinite(p.paid), partial: p.partial }, { finite: true, partial: true });
  part("cents as text");
  await redis.pipeline([["SET", paidKey, JSON.stringify({ store: STATS, order: ORDER, cents: "4900", currency: "usd", at: NOW })]]);
  const q = await buyerProfile(store, "buyer@example.com");
  console.log("        ", JSON.stringify({ paid: q.paid, type: typeof q.paid }));
  is("paid is a number", typeof q.paid, "number");
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
