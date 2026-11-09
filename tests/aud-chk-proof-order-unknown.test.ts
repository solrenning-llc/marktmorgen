/**
 * AUDIT PROOF (throwaway, 09/11/2026): readOrder turns an amount Stripe did
 * not send into 0 (lib/store-checkout.ts, `amount: ... : 0`), and the thanks
 * page then prints "for $0.00" and sends a purchase of value 0 to the
 * creator's ad platforms (CX-123 rule 24). And the "slow" notice promises a
 * few minutes when the refusal is the store's window, which lasts until the
 * window turns (VR 2). Each check states the DESIRED behaviour.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readOrder } from "@/lib/store-checkout";
import { thanksWords } from "@/lib/buyer-words/thanks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ID = `cs_test_${"u".repeat(24)}`;
let productId = "";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path.startsWith("/checkout/sessions/")) {
    // A paid checkout whose amount is missing from the reply (an unknown amount, never "nothing").
    return new Response(JSON.stringify({ id: ID, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created: Math.floor(Date.now() / 1000), currency: "usd", metadata: { store: "harbor", product: productId }, customer_details: { email: "ann@example.com" }, payment_intent: { id: "pi_Unknown0001", latest_charge: { refunded: false, amount: 4900, amount_refunded: 0 } } }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_aud_chk_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Bread Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  await setProductLink("owner@example.com", productId, "https://example.com/bread");
  const store = (await storeForEmail("owner@example.com"))!;

  part("A paid order whose amount Stripe did not send");
  const order = await readOrder(store, ID);
  is("control: it is read as paid", order.state, "paid");
  is("DESIRED: its amount is unknown, never 0", order.state === "paid" ? order.amount : "n/a", null);

  part("The 'slow' notice (thanks page) is shown for the store's window too");
  const page = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  is("control: the same 'slow' state covers the per-connection limit and the store's window (withinStore)", /allowed \? await readOrder\(store, sessionId\) : \{ state: "slow" \}/.test(page), true);
  is("DESIRED: the notice does not promise 'a few minutes' for a refusal that can last until the window turns", /in a few minutes/.test(thanksWords("en").notices.slow.body), false);
  done();
}

void main();
