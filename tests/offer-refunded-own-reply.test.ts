/**
 * offerRefunded (lib/upsell.ts), asked on every download of an offer taken after paying, read GET
 * /payment_intents/{id} and judged the reply without checking it was that payment (rule 30). A reply for another,
 * unrefunded payment made a refunded offer read as kept, and its file was still handed over after the money went back.
 * Now a reply that is not this payment's own throws, and the download answers that it could not check.
 * Found by Claude 3 (nuvem E)'s money audit, 13/11/2026. Synthetic: a stand-in for the creator's Stripe account.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { offerRefunded } from "@/lib/upsell";
import type { Store } from "@/lib/store";

process.env.STRIPE_SECRET_KEY = "sk_test_offer_refunded_own_only";
const store = { stripeAccountId: "acct_1TestOfferOwn01" } as unknown as Store;
const OWN = "pi_TestOfferOwn0001";

function answer(id: string, refunded: boolean) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ object: "payment_intent", id, amount: 2_900, amount_received: 2_900, currency: "usd", latest_charge: { object: "charge", id: `ch_${id.slice(3)}`, payment_intent: id, amount: 2_900, amount_refunded: refunded ? 2_900 : 0, refunded, disputed: false } }))) as typeof fetch;
}

test("control: this payment's own refunded reply reads as refunded", async () => {
  answer(OWN, true);
  assert.equal(await offerRefunded(store, OWN), true);
});

test("another payment's unrefunded reply is never taken as this offer kept", async () => {
  answer("pi_TestSomeoneElse01", false);
  await assert.rejects(offerRefunded(store, OWN));
});
