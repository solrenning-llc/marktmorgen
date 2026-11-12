/**
 * A refunded gift takes back only what the gift itself gave (entitlement hunt, Claude 7). Synthetic only: Redis is the
 * in-memory stand-in, Stripe and Resend stand-in fetches (no network).
 *
 * Before the fix, lib/gifts.ts revokeRefundedGifts took the recipient's course (dropStart) and the product's record
 * (HDEL of the imported purchase) on a gift's full refund without reading the record's job. grantImported writes with
 * HSETNX, so a gift to an address that already held the product another way (a PayPal purchase, a place in a group
 * purchase, a pre-order, an import, an earlier gift) wrote nothing, yet its refund deleted that other purchase: the
 * recipient lost what they had paid for. The sibling jobs read the job first (lib/group-buy.ts "Only what this
 * purchase gave: an address that also has the product another way keeps that"; lib/preorders.ts likewise).
 *
 * What is checked:
 *   - the recipient already holds the product from a PayPal purchase; a gift of it is given (writing nothing), then
 *     fully refunded: the PayPal purchase stays, the course is not taken away, and the refund is read once;
 *   - control: a gift that did give the product is still taken back on its full refund.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { grantImported, importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let refunds: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/events") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  if (path === "/refunds") return new Response(JSON.stringify({ object: "list", data: refunds, has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_other_grant_stand_in";
  process.env.RESEND_API_KEY = "re_test_gift_other_grant";
  await claimHandle("owner@gift-other.example", "gift-other", "Gift Other", "");
  await ensureStatsId("owner@gift-other.example");
  await setStripeAccount("owner@gift-other.example", "acct_1TestGiftOther01", true);
  await setSubscription("owner@gift-other.example", { customerId: "cus_GiftOther01", subscriptionId: "sub_GiftOther01", active: true, period: paidPeriod() });
  const made = await addProduct("owner@gift-other.example", "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@gift-other.example", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@gift-other.example"))!;
  const product = (await readListing(store, made.product.id))!;

  async function giveAndRefund(to: string, n: string): Promise<{ dropped: string[]; revoked: number; again: number }> {
    const started = await startGift(store, product, { to, from: "Bob", message: "" });
    if (!started.ok) throw new Error("no gift");
    const pi = `pi_GiftOther${n}`;
    const given = await deliverGift({
      store,
      session: { id: `cs_test_${n.repeat(24)}`, created: 1_900_000_000, amount_total: 4900, currency: "usd", payment_intent: pi, metadata: { store: "gift-other", product: product.id, gift: started.gift.id }, customer_details: { email: "bob@gift-other.example" } },
      product,
      base: "https://marktmorgen.com/@gift-other",
      from: '"Gift Other" <hello@marktmorgen.com>',
      recordStart: async () => {},
      ordersLink: async () => null,
    });
    if (given !== "given") throw new Error(`gift not given: ${given}`);
    refunds = [{ id: `re_GiftOther${n}`, created: Math.floor(Date.now() / 1000), status: "succeeded", payment_intent: pi, charge: { refunded: true } }];
    const dropped: string[] = [];
    const revoked = await revokeRefundedGifts(store, Date.now() + 10_000, async (email, id) => void dropped.push(`${email}|${id}`));
    const again = await revokeRefundedGifts(store, Date.now() + 10_000, async (email, id) => void dropped.push(`${email}|${id}`));
    return { dropped, revoked, again };
  }

  part("The recipient already holds the product from a PayPal purchase");
  await grantImported(store.statsId!, "paypal:ORDER0001", [{ email: "alice@gift-other.example", productId: product.id, items: null }], 1_800_000_000, store.sid);
  const first = await giveAndRefund("alice@gift-other.example", "1");
  is("the PayPal purchase stays theirs", (await importedFor((await storeForEmail("owner@gift-other.example"))!, "alice@gift-other.example")).map((p) => [p.productId, p.job]), [[product.id, "paypal:ORDER0001"]]);
  is("their course is not taken away", first.dropped, []);
  is("the refund is read once", first.again, 0);

  part("Control: a gift that gave the product is still taken back");
  const second = await giveAndRefund("carol@gift-other.example", "2");
  is("taken back on its full refund", [second.revoked, second.dropped, (await importedFor((await storeForEmail("owner@gift-other.example"))!, "carol@gift-other.example")).length], [1, [`carol@gift-other.example|${product.id}`], 0]);

  done();
}

void main();
